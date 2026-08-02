import { loadSession, saveSession, type PersistedSession } from "@/config/local/sessions";
import { getChannelBaseBranch, getUserGeneralSettings, resolveChannelCwd } from "@/config";
import { buildSessionEnvironment, prepareSessionWorkspace } from "@/core/session";
import { categorizeRuntimeError } from "@/core/runtime/helpers";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import { log } from "@/utils";
import { createHash } from "crypto";
import { randomUUID } from "node:crypto";

function isCiEnvironment(): boolean {
  const value = process.env.CI?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function resolveWorktreeId(threadId: string, rawChannelId: string, cwd: string): string {
  if (!isCiEnvironment()) {
    return `ode_${threadId}`;
  }

  const worktreeScope = createHash("sha1")
    .update(`${rawChannelId}:${cwd}`)
    .digest("hex")
    .slice(0, 8);
  return `ode_${threadId}_${worktreeScope}`;
}

type BootstrapDeps = {
  platform: "slack" | "discord" | "lark";
  im: IMAdapter;
  agent: AgentAdapter;
};

export type PreparedRuntimeSession = {
  session: PersistedSession;
  sessionId: string;
  created: boolean;
  cwd: string;
  threadOwnerUserId: string;
};

export async function prepareRuntimeSession(params: {
  deps: BootstrapDeps;
  context: RuntimeRequestContext;
}): Promise<PreparedRuntimeSession | null> {
  const { deps, context } = params;
  const { channelId, replyThreadId, threadId } = context;
  const rawChannelId = context.rawChannelId ?? channelId;

  let cwd: string;
  try {
    cwd = resolveChannelCwd(rawChannelId).cwd;
  } catch (err) {
    await deps.im.sendMessage(rawChannelId, replyThreadId, `Error: ${String(err)}`);
    return null;
  }

  let session = loadSession(channelId, threadId);
  if (session?.workingDirectory) {
    cwd = session.workingDirectory;
  }
  // A synthetic owner (task:/cron:) is a placeholder stored for a thread
  // Ode started on its own; the first real human to reply claims the
  // thread. Treat synthetic owners as "unset" so the current user wins.
  const existingOwner = session?.threadOwnerUserId;
  const hasRealOwner = !!existingOwner && !isSyntheticOwner(existingOwner);
  const threadOwnerUserId = hasRealOwner ? existingOwner : context.userId;
  const { env: sessionEnv, gitIdentity } = buildSessionEnvironment({
    threadOwnerUserId,
  });

  let sessionId: string;
  let created: boolean;

  try {
    ({ sessionId, created } = await deps.agent.getOrCreateSession(channelId, threadId, cwd, sessionEnv));
  } catch (err) {
    const { message, suggestion } = categorizeRuntimeError(err);
    log.error("Failed to create OpenCode session", {
      channelId,
      threadId,
      error: String(err),
    });
    await deps.im.sendMessage(rawChannelId, replyThreadId, `Error: ${message}\n_${suggestion}_`);
    return null;
  }

  const isFirstMessageInThread = !session;
  if (getUserGeneralSettings().gitStrategy === "worktree" && isFirstMessageInThread) {
    try {
      const worktreeId = resolveWorktreeId(threadId, rawChannelId, cwd);
      const baseBranch = getChannelBaseBranch(rawChannelId);
      const { cwd: resolvedCwd, worktree } = await prepareSessionWorkspace({
        channelId: rawChannelId,
        threadId,
        cwd,
        worktreeId,
        baseBranch,
        sessionEnv,
        gitIdentity,
      });
      if (worktree.skipped && worktree.message) {
        await deps.im.sendMessage(rawChannelId, replyThreadId, worktree.message);
      }
      cwd = resolvedCwd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to prepare worktree", {
        channelId,
        threadId,
        sessionId,
        error: message,
      });
      await deps.im.sendMessage(rawChannelId, replyThreadId, `Error: Failed to prepare worktree. ${message}`);
      return null;
    }
  }

  if (!session) {
    session = {
      sessionId,
      providerId: deps.agent.getProviderForSession(sessionId),
      platform: deps.platform,
      channelId,
      threadId,
      workingDirectory: cwd,
      threadOwnerUserId,
      participantBotIds: [context.botToken ?? "default"],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastActivityBotId: context.botToken ?? "default",
    };
  } else if (session.sessionId !== sessionId) {
    session.sessionId = sessionId;
  }

  const providerId = deps.agent.getProviderForSession(sessionId);
  if (session.providerId !== providerId) {
    session.providerId = providerId;
  }

  const now = Date.now();
  session.binding = {
    odeSessionId: session.binding?.odeSessionId ?? randomUUID(),
    providerId,
    transport: deps.agent.getTransportForSession(sessionId),
    nativeSessionId: sessionId,
    capabilities: deps.agent.getCapabilitiesForSession(sessionId),
    createdAt: session.binding?.createdAt ?? now,
    updatedAt: now,
  };

  if (session.platform !== deps.platform) {
    session.platform = deps.platform;
  }

  if (session.workingDirectory !== cwd) {
    session.workingDirectory = cwd;
  }

  if (!session.threadOwnerUserId || isSyntheticOwner(session.threadOwnerUserId)) {
    session.threadOwnerUserId = threadOwnerUserId;
  }
  const participantBotIds = session.participantBotIds ?? [];
  const currentBotId = context.botToken ?? "default";
  if (!participantBotIds.includes(currentBotId)) {
    participantBotIds.push(currentBotId);
    session.participantBotIds = participantBotIds;
  }
  session.lastActivityBotId = currentBotId;
  saveSession(session);

  return {
    session,
    sessionId,
    created,
    cwd,
    threadOwnerUserId,
  };
}
