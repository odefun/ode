import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import {
  getChannelAgentProvider,
  getChannelBaseBranch,
  getChannelModel,
  getChannelSystemMessage,
  getUserGeneralSettings,
  resolveChannelCwd,
} from "@/config";
import {
  type TaskRecord,
  getTaskById,
  listDueTasks,
  markTaskCompleted,
  markTaskFailed,
  markTaskTriggered,
} from "@/config/local/tasks";
import {
  buildThreadKey,
  completeAgentResult,
  ensureMessageThread,
  failAgentResult,
  recordUserPrompt,
  startAgentResult,
} from "@/config/local/inbox";
import {
  loadSession,
  saveSession,
  type PersistedSession,
} from "@/config/local/sessions";
import { buildMessageOptions } from "@/core/runtime/message-options";
import { buildFinalResponseText, categorizeRuntimeError } from "@/core/runtime/helpers";
import { buildSessionEnvironment, prepareSessionWorkspace } from "@/core/session";
import { sendChannelMessage as sendDiscordChannelMessage } from "@/ims/discord/client";
import { sendChannelMessage as sendLarkChannelMessage } from "@/ims/lark/client";
import {
  sendChannelMessage as sendSlackChannelMessage,
  sendMessage as sendSlackThreadMessage,
} from "@/ims/slack/client";
import { type AgentProviderId, isAgentProviderId } from "@/shared/agent-provider";
import { log } from "@/utils";

// ---------------------------------------------------------------------------
// One-time task scheduler.
//
// Closely mirrors `packages/core/cron/scheduler.ts`: a polling loop claims
// tasks atomically via SQL, fires the agent turn, and persists the result.
// The key differences vs. cron:
//   - Tasks fire exactly once (status lifecycle: pending -> running ->
//     success | failed | cancelled).
//   - Tasks can anchor to an existing thread (reuse its session for
//     continuity) or post as a fresh channel message with a synthetic
//     threadId of `task:{id}`.
// ---------------------------------------------------------------------------

const TASK_POLL_INTERVAL_MS = 10_000;

let taskSchedulerTimer: ReturnType<typeof setInterval> | null = null;
const runningTaskIds = new Set<string>();

function getSyntheticThreadId(taskId: string): string {
  return `task:${taskId}`;
}

function getTaskUserId(taskId: string): string {
  return `task:${taskId}`;
}

function getTaskMessageId(task: TaskRecord): string {
  // `triggeredAt` is set atomically in `markTaskTriggered` before the run
  // begins; prefer it for a stable per-run id. Fall back to the creation
  // time for manual early runs where `triggeredAt` may not yet be visible.
  return String(task.triggeredAt ?? task.createdAt);
}

function resolveTaskThreadId(task: TaskRecord): string {
  return task.threadId ?? getSyntheticThreadId(task.id);
}

/**
 * Resolve the agent provider a task should run on, following the fallback
 * chain:
 *   1. If the task is anchored to an existing thread that already has a
 *      persisted session, use that thread's provider. Tasks anchored to a
 *      thread reuse its session for context continuity, and sessions are
 *      provider-scoped in storage (`getThreadSessionId(..., providerId)`),
 *      so honouring a different per-task override here would silently spin
 *      up a fresh session under a new provider and drop the thread's
 *      history. In that case we intentionally ignore `task.agent`.
 *   2. Otherwise `task.agent` (per-task override set by CLI / Web UI),
 *   3. Otherwise the channel's configured agent (`channelDetails.agentProvider`),
 *   4. Otherwise the global default baked into `getChannelAgentProvider`
 *      (currently `opencode`).
 *
 * Unknown string values on `task.agent` (e.g. a provider that used to be
 * supported but was removed) fall through to the channel default rather than
 * blowing up the scheduler tick; creation/update already rejects bad values
 * at the source.
 *
 * Exported for unit tests that don't want to touch the real SQLite DB.
 */
export function resolveTaskAgentProvider(task: TaskRecord): AgentProviderId {
  // 1. Anchored thread wins over everything — keep the existing session's
  //    provider so we don't silently fork the conversation.
  if (task.threadId && task.threadId.trim().length > 0) {
    const existing = loadSession(task.channelId, task.threadId);
    if (existing?.providerId && isAgentProviderId(existing.providerId)) {
      return existing.providerId;
    }
  }
  // 2. Per-task override.
  if (task.agent && isAgentProviderId(task.agent)) {
    return task.agent;
  }
  // 3 + 4. Channel default -> global default (handled inside
  // getChannelAgentProvider).
  return getChannelAgentProvider(task.channelId);
}

function resolveInboxModelForTask(
  task: TaskRecord,
  options: ReturnType<typeof buildMessageOptions>,
): string | null {
  const explicitModel = options?.model;
  if (explicitModel?.providerID && explicitModel.modelID) {
    return `${explicitModel.providerID}/${explicitModel.modelID}`;
  }
  const fallbackModel = getChannelModel(task.channelId)?.trim();
  return fallbackModel && fallbackModel.length > 0 ? fallbackModel : null;
}

async function sendResultToChannel(
  task: TaskRecord,
  text: string,
): Promise<{ threadedReply: boolean; newThreadId: string | undefined }> {
  if (task.platform === "slack") {
    // Slack is the only platform with a stable "reply in thread" helper; use
    // it whenever the caller anchored the task to a real thread so the reply
    // lands back in the conversation. Without a thread the task posts at
    // the top of the channel.
    if (task.threadId && task.threadId.trim().length > 0) {
      await sendSlackThreadMessage(task.channelId, task.threadId, text);
      return { threadedReply: true, newThreadId: undefined };
    }
    const newThreadId = await sendSlackChannelMessage(task.channelId, text);
    return { threadedReply: false, newThreadId };
  }
  if (task.platform === "discord") {
    const newThreadId = await sendDiscordChannelMessage(task.channelId, text);
    return { threadedReply: false, newThreadId };
  }
  const newThreadId = await sendLarkChannelMessage(task.channelId, text);
  return { threadedReply: false, newThreadId };
}

/**
 * After a Task (or similar bot-initiated flow) posts a top-level channel
 * message that creates a fresh thread, mirror the synthetic thread's
 * session onto the real platform-assigned thread id. This makes the thread
 * "active" for inbound routing and marks the owner as synthetic so the
 * first human replier can claim the thread via session-bootstrap.
 */
function seedChannelThreadSession(params: {
  platform: "slack" | "discord" | "lark";
  channelId: string;
  realThreadId: string;
  sessionId: string;
  providerId: PersistedSession["providerId"];
  workingDirectory: string;
  syntheticOwnerId: string;
  botParticipantId: string;
  branchName?: string;
}): void {
  const existing = loadSession(params.channelId, params.realThreadId);
  if (existing) {
    // Respect any pre-existing session (should be rare — the thread was
    // just created), but keep `lastActivityBotId` fresh so isThreadActive
    // returns true for subsequent replies.
    existing.lastActivityBotId = params.botParticipantId;
    saveSession(existing);
    return;
  }
  const now = Date.now();
  const session: PersistedSession = {
    sessionId: params.sessionId,
    providerId: params.providerId,
    platform: params.platform,
    channelId: params.channelId,
    threadId: params.realThreadId,
    workingDirectory: params.workingDirectory,
    threadOwnerUserId: params.syntheticOwnerId,
    participantBotIds: [params.botParticipantId],
    createdAt: now,
    lastActivityAt: now,
    lastActivityBotId: params.botParticipantId,
    branchName: params.branchName,
  };
  saveSession(session);
}

function buildTaskAgentContext(task: TaskRecord): OpenCodeMessageContext {
  const userId = getTaskUserId(task.id);
  const threadId = resolveTaskThreadId(task);
  return {
    slack: {
      platform: task.platform,
      channelId: task.channelId,
      threadId,
      userId,
      hasGitHubToken: false,
      channelSystemMessage: getChannelSystemMessage(task.channelId) ?? undefined,
    },
  };
}

async function prepareTaskSession(task: TaskRecord): Promise<{
  session: PersistedSession;
  sessionId: string;
  cwd: string;
  created: boolean;
  threadId: string;
}> {
  const threadId = resolveTaskThreadId(task);
  const userId = getTaskUserId(task.id);
  const agent = createAgentAdapter({ providerOverride: resolveTaskAgentProvider(task) });

  let cwd = resolveChannelCwd(task.channelId).cwd;
  let session = loadSession(task.channelId, threadId);
  if (session?.workingDirectory) {
    cwd = session.workingDirectory;
  }

  const { env: sessionEnv, gitIdentity } = buildSessionEnvironment({
    threadOwnerUserId: session?.threadOwnerUserId ?? userId,
  });

  const { sessionId } = await agent.getOrCreateSession(task.channelId, threadId, cwd, sessionEnv);
  const created = !session;

  // Only create a fresh worktree when we are starting a brand-new session.
  // When a task reuses an existing thread's session, we inherit whatever
  // worktree that thread already set up.
  if (created && getUserGeneralSettings().gitStrategy === "worktree") {
    const baseBranch = getChannelBaseBranch(task.channelId);
    const prepared = await prepareSessionWorkspace({
      channelId: task.channelId,
      threadId,
      cwd,
      worktreeId: `ode_task_${task.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      baseBranch,
      sessionEnv,
      gitIdentity,
    });
    cwd = prepared.cwd;
  }

  if (!session) {
    session = {
      sessionId,
      providerId: agent.getProviderForSession(sessionId),
      platform: task.platform,
      channelId: task.channelId,
      threadId,
      workingDirectory: cwd,
      threadOwnerUserId: userId,
      participantBotIds: ["task"],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastActivityBotId: "task",
    };
  } else {
    session.sessionId = sessionId;
    session.providerId = agent.getProviderForSession(sessionId);
    session.platform = task.platform;
    session.workingDirectory = cwd;
    session.lastActivityBotId = "task";
    // Preserve the original threadOwnerUserId when reusing a session so
    // GitHub/git identity stay attached to the human owner rather than the
    // synthetic task user.
  }

  saveSession(session);
  return { session, sessionId, cwd, created, threadId };
}

async function runTask(task: TaskRecord): Promise<void> {
  const agent = createAgentAdapter({ providerOverride: resolveTaskAgentProvider(task) });
  const taskMessageId = getTaskMessageId(task);
  let agentResultDetailId: string | null = null;
  let threadKey: string | null = null;

  try {
    const { session, sessionId, cwd, threadId } = await prepareTaskSession(task);
    threadKey = buildThreadKey(task.channelId, threadId);
    const providerId = agent.getProviderForSession(sessionId);
    const options = buildMessageOptions({
      text: task.messageText,
      channelId: task.channelId,
      providerId,
    });
    const model = resolveInboxModelForTask(task, options);

    try {
      ensureMessageThread({
        platform: task.platform,
        channelId: task.channelId,
        threadId,
        replyThreadId: threadId,
        sessionId,
        providerId,
        model,
        workingDirectory: cwd,
        threadOwnerUserId: session.threadOwnerUserId ?? getTaskUserId(task.id),
        branchName: session.branchName,
        sourceKind: "task",
        taskId: task.id,
        taskTitle: task.title,
        context: {
          sourceKind: "task",
          taskId: task.id,
          taskTitle: task.title,
        },
      });
      recordUserPrompt({
        threadKey,
        messageId: taskMessageId,
        userId: getTaskUserId(task.id),
        promptText: task.messageText,
        context: {
          taskId: task.id,
          scheduledAt: task.scheduledAt,
          triggeredAt: task.triggeredAt,
        },
      });
      const detail = startAgentResult({
        threadKey,
        requestMessageId: taskMessageId,
        providerId,
        model,
        workingDirectory: cwd,
        context: {
          taskId: task.id,
          scheduledAt: task.scheduledAt,
        },
      });
      agentResultDetailId = detail.id;
    } catch (error) {
      log.warn("Failed to record task inbox message", {
        taskId: task.id,
        error: String(error),
      });
    }

    const responses = await agent.sendMessage(
      task.channelId,
      sessionId,
      task.messageText,
      cwd,
      options,
      buildTaskAgentContext(task),
    );
    const finalText = buildFinalResponseText(responses) ?? "_Done_";

    await sendResultToChannel(task, finalText).then((outcome) => {
      if (!outcome.threadedReply && outcome.newThreadId) {
        // The task opened a brand-new channel thread. Mirror the synthetic
        // session to the real thread id so humans replying there are
        // routed to the same agent session and can claim ownership.
        seedChannelThreadSession({
          platform: task.platform,
          channelId: task.channelId,
          realThreadId: outcome.newThreadId,
          sessionId,
          providerId,
          workingDirectory: cwd,
          syntheticOwnerId: getTaskUserId(task.id),
          botParticipantId: "task",
          branchName: session.branchName,
        });
      }
    });
    if (agentResultDetailId) {
      try {
        completeAgentResult({
          detailId: agentResultDetailId,
          resultText: finalText,
          providerId,
          model,
          workingDirectory: cwd,
        });
      } catch (error) {
        log.warn("Failed to complete task agent_result detail", {
          detailId: agentResultDetailId,
          error: String(error),
        });
      }
    }
    markTaskCompleted(task.id);
  } catch (error) {
    const { message } = categorizeRuntimeError(error);
    if (agentResultDetailId) {
      try {
        failAgentResult({
          detailId: agentResultDetailId,
          errorText: message,
        });
      } catch (failError) {
        log.warn("Failed to mark task agent_result detail as failed", {
          detailId: agentResultDetailId,
          error: String(failError),
        });
      }
    }
    markTaskFailed(task.id, message);
    log.warn("Task execution failed", {
      taskId: task.id,
      title: task.title,
      channelId: task.channelId,
      error: String(error),
    });
  }
}

async function tickTasks(): Promise<void> {
  const now = Date.now();
  const due = listDueTasks(now);
  for (const task of due) {
    if (runningTaskIds.has(task.id)) continue;
    if (!markTaskTriggered(task.id)) continue;
    runningTaskIds.add(task.id);
    // Re-read after the atomic claim so `triggeredAt` is populated for the
    // inbox message id.
    const claimed = getTaskById(task.id) ?? task;
    void runTask(claimed).finally(() => {
      runningTaskIds.delete(task.id);
    });
  }
}

export function startTaskScheduler(): void {
  if (taskSchedulerTimer) return;
  void tickTasks();
  taskSchedulerTimer = setInterval(() => {
    void tickTasks();
  }, TASK_POLL_INTERVAL_MS);
  log.debug("Task scheduler started", { intervalMs: TASK_POLL_INTERVAL_MS });
}

export function stopTaskScheduler(): void {
  if (!taskSchedulerTimer) return;
  clearInterval(taskSchedulerTimer);
  taskSchedulerTimer = null;
  runningTaskIds.clear();
  log.debug("Task scheduler stopped");
}

export class TaskAlreadyRunningError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} is already running`);
    this.name = "TaskAlreadyRunningError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskNotPendingError extends Error {
  constructor(taskId: string, status: string) {
    super(`Task ${taskId} is not pending (status: ${status})`);
    this.name = "TaskNotPendingError";
  }
}

/**
 * Trigger a task immediately, bypassing the scheduled time. The task must
 * still be in `pending` status — finished, failed, and cancelled tasks are
 * terminal. The in-process `runningTaskIds` guard prevents duplicate runs.
 */
export function beginTriggerTaskNow(taskId: string): Promise<void> {
  const task = getTaskById(taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  if (runningTaskIds.has(task.id)) {
    throw new TaskAlreadyRunningError(task.id);
  }
  if (task.status !== "pending") {
    throw new TaskNotPendingError(task.id, task.status);
  }
  if (!markTaskTriggered(task.id)) {
    // Lost the race to the polling loop. Surface the same error shape as the
    // in-process check so HTTP handlers can 409 uniformly.
    throw new TaskAlreadyRunningError(task.id);
  }
  runningTaskIds.add(task.id);
  const claimed = getTaskById(task.id) ?? task;
  const runPromise = runTask(claimed).finally(() => {
    runningTaskIds.delete(task.id);
  });
  return runPromise;
}

export async function triggerTaskNow(taskId: string): Promise<void> {
  await beginTriggerTaskNow(taskId);
}
