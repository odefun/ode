import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import {
  getChannelBaseBranch,
  getChannelModel,
  getChannelSystemMessage,
  getUserGeneralSettings,
  resolveChannelCwd,
} from "@/config";
import {
  type CronJobRecord,
  getCronJobById,
  listEnabledCronJobs,
  markCronJobCompleted,
  markCronJobFailed,
  markCronJobRunning,
  markCronJobTriggered,
  reconcileInterruptedCronJobs,
} from "@/config/local/cron-jobs";
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
import { matchesCronExpression } from "@/core/cron/expression";
import { buildMessageOptions } from "@/core/runtime/message-options";
import { buildFinalResponseText, categorizeRuntimeError } from "@/core/runtime/helpers";
import { buildSessionEnvironment, prepareSessionWorkspace } from "@/core/session";
import { sendChannelMessage as sendDiscordChannelMessage } from "@/ims/discord/client";
import { sendChannelMessage as sendLarkChannelMessage } from "@/ims/lark/client";
import { sendChannelMessage as sendSlackChannelMessage } from "@/ims/slack/client";
import { log } from "@/utils";

const CRON_POLL_INTERVAL_MS = 15_000;

/**
 * Hard upper bound for a cron run's session-preparation phase (creating the
 * agent session + setting up a worktree). If this step hangs — e.g. the
 * OpenCode SDK call never returns, or a `git worktree add` stalls — the run
 * would otherwise occupy the in-process `runningJobIds` guard indefinitely,
 * blocking every subsequent manual "Run now" with HTTP 409. We time it out so
 * the job flips to `failed` and users can retry.
 */
const CRON_PREPARE_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.ODE_CRON_PREPARE_TIMEOUT_MS,
  2 * 60_000
);

/**
 * Hard upper bound for the actual agent turn (`agent.sendMessage`). OpenCode
 * sessions can wedge waiting on approvals or remote provider calls; we bound
 * the run so a stuck turn doesn't permanently lock out the job.
 */
const CRON_AGENT_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.ODE_CRON_AGENT_TIMEOUT_MS,
  2 * 60 * 60_000
);

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

class CronStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`${step} timed out after ${timeoutMs}ms`);
    this.name = "CronStepTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CronStepTimeoutError(step, timeoutMs));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let cronSchedulerTimer: ReturnType<typeof setInterval> | null = null;
const runningJobIds = new Set<string>();

function getCronThreadId(jobId: string, runId: string): string {
  return `cron-job:${jobId}:${runId}`;
}

function getCronUserId(jobId: string): string {
  return `cron-job:${jobId}`;
}

function getCronMessageId(minuteStartMs: number): string {
  return String(minuteStartMs);
}

function getCronRunId(minuteStartMs: number): string {
  return String(minuteStartMs);
}

function sanitizeForWorktreeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function resolveInboxModelForCron(job: CronJobRecord, options: ReturnType<typeof buildMessageOptions>): string | null {
  const explicitModel = options?.model;
  if (explicitModel?.providerID && explicitModel.modelID) {
    return `${explicitModel.providerID}/${explicitModel.modelID}`;
  }
  const fallbackModel = getChannelModel(job.channelId)?.trim();
  return fallbackModel && fallbackModel.length > 0 ? fallbackModel : null;
}

async function sendResultToChannel(
  job: CronJobRecord,
  text: string,
): Promise<string | undefined> {
  if (job.platform === "slack") {
    return sendSlackChannelMessage(job.channelId, text);
  }
  if (job.platform === "discord") {
    return sendDiscordChannelMessage(job.channelId, text);
  }
  return sendLarkChannelMessage(job.channelId, text);
}

/**
 * After the cron run posts its result as a top-level channel message,
 * mirror the synthetic thread's session onto the real platform-assigned
 * thread id so humans replying in that thread are routed to this run's
 * agent session and can claim ownership (see
 * `packages/ims/shared/synthetic-owner.ts`).
 */
function seedCronChannelThreadSession(params: {
  platform: "slack" | "discord" | "lark";
  channelId: string;
  realThreadId: string;
  sessionId: string;
  providerId: PersistedSession["providerId"];
  workingDirectory: string;
  syntheticOwnerId: string;
  branchName?: string;
}): void {
  const existing = loadSession(params.channelId, params.realThreadId);
  if (existing) {
    existing.lastActivityBotId = "cron-job";
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
    participantBotIds: ["cron-job"],
    createdAt: now,
    lastActivityAt: now,
    lastActivityBotId: "cron-job",
    branchName: params.branchName,
  };
  saveSession(session);
}

function buildCronAgentContext(job: CronJobRecord, runId: string): OpenCodeMessageContext {
  const userId = getCronUserId(job.id);
  const threadId = getCronThreadId(job.id, runId);
  return {
    slack: {
      platform: job.platform,
      channelId: job.channelId,
      threadId,
      userId,
      hasGitHubToken: false,
      channelSystemMessage: getChannelSystemMessage(job.channelId) ?? undefined,
    },
  };
}

async function prepareCronSession(job: CronJobRecord, runId: string): Promise<{
  session: PersistedSession;
  sessionId: string;
  cwd: string;
  created: boolean;
}> {
  const threadId = getCronThreadId(job.id, runId);
  const userId = getCronUserId(job.id);
  const agent = createAgentAdapter();

  // Each cron run gets a fresh session + worktree so runs have isolated
  // timelines and independent working directories. We intentionally do not
  // reuse any previous run's session here.
  let cwd = resolveChannelCwd(job.channelId).cwd;
  let session = loadSession(job.channelId, threadId);
  if (session?.workingDirectory) {
    cwd = session.workingDirectory;
  }

  const { env: sessionEnv, gitIdentity } = buildSessionEnvironment({
    threadOwnerUserId: userId,
  });

  const { sessionId } = await agent.getOrCreateSession(job.channelId, threadId, cwd, sessionEnv);
  const created = !session;

  if (created && getUserGeneralSettings().gitStrategy === "worktree") {
    const baseBranch = getChannelBaseBranch(job.channelId);
    const jobSlug = sanitizeForWorktreeId(job.id);
    const runSlug = sanitizeForWorktreeId(runId);
    const prepared = await prepareSessionWorkspace({
      channelId: job.channelId,
      threadId,
      cwd,
      worktreeId: `ode_cron_${jobSlug}_${runSlug}`,
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
      platform: job.platform,
      channelId: job.channelId,
      threadId,
      workingDirectory: cwd,
      threadOwnerUserId: userId,
      participantBotIds: ["cron-job"],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastActivityBotId: "cron-job",
    };
  } else {
    session.sessionId = sessionId;
    session.providerId = agent.getProviderForSession(sessionId);
    session.platform = job.platform;
    session.workingDirectory = cwd;
    session.lastActivityBotId = "cron-job";
  }

  saveSession(session);
  return { session, sessionId, cwd, created };
}

async function runCronJob(job: CronJobRecord, minuteStartMs: number): Promise<void> {
  const agent = createAgentAdapter();
  const runId = getCronRunId(minuteStartMs);
  const cronThreadId = getCronThreadId(job.id, runId);
  const cronMessageId = getCronMessageId(minuteStartMs);
  const threadKey = buildThreadKey(job.channelId, cronThreadId);
  let agentResultDetailId: string | null = null;

  try {
    const { session, sessionId, cwd } = await withTimeout(
      prepareCronSession(job, runId),
      CRON_PREPARE_TIMEOUT_MS,
      "Cron session preparation"
    );
    const providerId = agent.getProviderForSession(sessionId);
    const options = buildMessageOptions({
      text: job.messageText,
      channelId: job.channelId,
      providerId,
    });
    const model = resolveInboxModelForCron(job, options);

    try {
      ensureMessageThread({
        platform: job.platform,
        channelId: job.channelId,
        threadId: cronThreadId,
        replyThreadId: cronThreadId,
        sessionId,
        providerId,
        model,
        workingDirectory: cwd,
        threadOwnerUserId: getCronUserId(job.id),
        branchName: session.branchName,
        sourceKind: "cron_job",
        cronJobId: job.id,
        cronJobTitle: job.title,
        context: {
          sourceKind: "cron_job",
          cronJobId: job.id,
          cronJobTitle: job.title,
        },
      });
      recordUserPrompt({
        threadKey,
        messageId: cronMessageId,
        userId: getCronUserId(job.id),
        promptText: job.messageText,
        context: {
          scheduledMinuteStartMs: minuteStartMs,
        },
      });
      const detail = startAgentResult({
        threadKey,
        requestMessageId: cronMessageId,
        providerId,
        model,
        workingDirectory: cwd,
        context: {
          scheduledMinuteStartMs: minuteStartMs,
          cronJobId: job.id,
        },
      });
      agentResultDetailId = detail.id;
    } catch (error) {
      log.warn("Failed to record cron inbox message", {
        cronJobId: job.id,
        error: String(error),
      });
    }

    const responses = await withTimeout(
      agent.sendMessage(
        job.channelId,
        sessionId,
        job.messageText,
        cwd,
        options,
        buildCronAgentContext(job, runId)
      ),
      CRON_AGENT_TIMEOUT_MS,
      "Cron agent turn"
    );
    const finalText = buildFinalResponseText(responses) ?? "_Done_";

    const realThreadId = await sendResultToChannel(job, finalText);
    if (realThreadId) {
      seedCronChannelThreadSession({
        platform: job.platform,
        channelId: job.channelId,
        realThreadId,
        sessionId,
        providerId,
        workingDirectory: cwd,
        syntheticOwnerId: getCronUserId(job.id),
        branchName: session.branchName,
      });
    }
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
        log.warn("Failed to complete cron agent_result detail", {
          detailId: agentResultDetailId,
          error: String(error),
        });
      }
    }
    markCronJobCompleted(job.id);
  } catch (error) {
    const { message } = categorizeRuntimeError(error);
    if (agentResultDetailId) {
      try {
        failAgentResult({
          detailId: agentResultDetailId,
          errorText: message,
        });
      } catch (failError) {
        log.warn("Failed to mark cron agent_result detail as failed", {
          detailId: agentResultDetailId,
          error: String(failError),
        });
      }
    }
    markCronJobFailed(job.id, message);
    log.warn("Cron job execution failed", {
      cronJobId: job.id,
      title: job.title,
      channelId: job.channelId,
      error: String(error),
    });
    // Surface the failure to the chat channel so users aren't left staring
    // at a silent "running" row. Any error here is best-effort; we never
    // want the notification path to shadow the original failure.
    try {
      const failureText = `*Cron job failed:* ${job.title}\n${message}`;
      await sendResultToChannel(job, failureText);
    } catch (notifyError) {
      log.warn("Failed to send cron job failure notification", {
        cronJobId: job.id,
        error: String(notifyError),
      });
    }
  }
}

async function tickCronJobs(): Promise<void> {
  const now = new Date();
  const minuteStartMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    0,
    0
  ).getTime();

  // The poll loop runs every CRON_POLL_INTERVAL_MS; transient SQLite I/O
  // failures (e.g. a flaky disk, fs sync, or inbox.db checkpoint contention)
  // used to surface as unhandled promise rejections to Sentry because the
  // synchronous throw from `listEnabledCronJobs` / `markCronJobTriggered`
  // had no catcher in the async entrypoint. Swallowing the error here is
  // the right behaviour: the scheduler is best-effort and retries next tick.
  let jobs: ReturnType<typeof listEnabledCronJobs>;
  try {
    jobs = listEnabledCronJobs();
  } catch (error) {
    log.warn("Cron scheduler tick failed to read enabled jobs", {
      error: String(error),
    });
    return;
  }
  for (const job of jobs) {
    if (runningJobIds.has(job.id)) continue;
    try {
      if (!matchesCronExpression(job.cronExpression, now)) continue;
    } catch (error) {
      try {
        markCronJobFailed(job.id, error instanceof Error ? error.message : String(error));
      } catch (markError) {
        log.warn("Failed to mark cron job with invalid expression as failed", {
          cronJobId: job.id,
          error: String(markError),
        });
      }
      log.warn("Skipping cron job with invalid cron expression", {
        cronJobId: job.id,
        cronExpression: job.cronExpression,
        error: String(error),
      });
      continue;
    }

    let claimed = false;
    try {
      claimed = markCronJobTriggered(job.id, minuteStartMs);
    } catch (error) {
      log.warn("Failed to claim cron job for execution", {
        cronJobId: job.id,
        error: String(error),
      });
      continue;
    }
    if (!claimed) continue;

    runningJobIds.add(job.id);
    void runCronJob(job, minuteStartMs).finally(() => {
      runningJobIds.delete(job.id);
    });
  }
}

export function startCronJobScheduler(): void {
  if (cronSchedulerTimer) return;
  // Reconcile rows left in `last_run_status='running'` by a previous
  // runtime. Any row whose `last_triggered_at` is fresh enough gets a
  // backfill re-run kicked off synchronously (via the usual `beginTriggerX`
  // code path) so time-sensitive jobs don't silently skip a cycle when the
  // daemon restarts for an upgrade.
  try {
    const reconciled = reconcileInterruptedCronJobs();
    if (reconciled.length > 0) {
      log.info("Reconciled interrupted cron jobs from previous runtime", {
        count: reconciled.length,
        entries: reconciled,
      });
      for (const entry of reconciled) {
        if (entry.action !== "backfill_scheduled") continue;
        // Fire-and-forget: `beginTriggerCronJobNow` returns a detached
        // promise for the agent turn, we just want it kicked off. Errors
        // are already logged inside `runCronJob`.
        try {
          const promise = beginTriggerCronJobNow(entry.id);
          promise.catch((error) => {
            log.warn("Cron backfill run failed", {
              cronJobId: entry.id,
              error: String(error),
            });
          });
        } catch (error) {
          log.warn("Failed to start cron backfill run", {
            cronJobId: entry.id,
            error: String(error),
          });
        }
      }
    }
  } catch (error) {
    log.warn("Failed to reconcile interrupted cron jobs on startup", {
      error: String(error),
    });
  }
  void tickCronJobs();
  cronSchedulerTimer = setInterval(() => {
    void tickCronJobs();
  }, CRON_POLL_INTERVAL_MS);
  log.debug("Cron job scheduler started", { intervalMs: CRON_POLL_INTERVAL_MS });
}

export function stopCronJobScheduler(): void {
  if (!cronSchedulerTimer) return;
  clearInterval(cronSchedulerTimer);
  cronSchedulerTimer = null;
  runningJobIds.clear();
  log.debug("Cron job scheduler stopped");
}

export class CronJobAlreadyRunningError extends Error {
  constructor(jobId: string) {
    super(`Cron job ${jobId} is already running`);
    this.name = "CronJobAlreadyRunningError";
  }
}

export class CronJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Cron job ${jobId} not found`);
    this.name = "CronJobNotFoundError";
  }
}

/**
 * Manually trigger a cron job run outside of the scheduler's polling loop.
 *
 * Shares the in-process `runningJobIds` guard with the scheduler so a manual
 * click never starts a second concurrent run of the same job. The minute-guard
 * on the row (`markCronJobTriggered`) is intentionally bypassed — manual runs
 * should be possible within the same minute — but the scheduler itself still
 * uses that guard to dedupe automatic polls.
 *
 * Returns a promise that resolves once the run finishes. Callers that want to
 * fire-and-forget should use `beginTriggerCronJobNow` instead, which runs the
 * "already running" / "not found" checks synchronously and returns a detached
 * promise for the agent turn.
 */
export async function triggerCronJobNow(jobId: string): Promise<void> {
  const runPromise = beginTriggerCronJobNow(jobId);
  await runPromise;
}

/**
 * Synchronously validate that a job exists and isn't already running, then
 * start the run in the background. Throws `CronJobNotFoundError` /
 * `CronJobAlreadyRunningError` synchronously when the preconditions fail so
 * HTTP handlers can return 404 / 409 without awaiting the full agent turn.
 */
export function beginTriggerCronJobNow(jobId: string): Promise<void> {
  const job = getCronJobById(jobId);
  if (!job) {
    throw new CronJobNotFoundError(jobId);
  }
  if (runningJobIds.has(job.id)) {
    throw new CronJobAlreadyRunningError(job.id);
  }

  runningJobIds.add(job.id);
  // Reflect the in-flight manual run in SQL so the UI and any recovery logic
  // can observe it. The minute-level idempotency guard in
  // `markCronJobTriggered` is intentionally not used here — manual runs must
  // be possible within the same minute as a scheduler run.
  try {
    markCronJobRunning(job.id, Date.now());
  } catch (error) {
    log.warn("Failed to mark cron job as running before manual trigger", {
      cronJobId: job.id,
      error: String(error),
    });
  }
  const runPromise = runCronJob(job, Date.now()).finally(() => {
    runningJobIds.delete(job.id);
  });
  return runPromise;
}
