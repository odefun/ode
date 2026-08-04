import { App } from "@slack/bolt";
import {
  getSlackTargetChannels,
  getSlackBotTokens,
  invalidateOdeConfigCache,
  getGitHubInfoForUser,
  getChannelSystemMessage,
  getWorkspaces,
} from "@/config";
import { markdownToSlack, splitForSlack, truncateForSlack } from "./formatter";
import {
  isThreadActive,
  loadSession,
} from "@/config/local/sessions";
import { createCoreRuntime } from "@/core/runtime";
import type { IMAdapter } from "@/core/types";
import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import { log } from "@/utils";
import { fetchThreadHistoryByClient } from "./message-history";
import { registerSlackMessageRouter } from "./message-router";
import { syncSlackWorkspace } from "@/core/web/local-settings";
import { describeSlackSettingsIssues, postSlackGeneralSettingsLauncher } from "./settings";
import { postSlackChannelCronLauncher } from "./cron";
import {
  createProcessorId,
} from "@/ims/shared/processor-id";
import { createProcessorManager } from "@/ims/shared/processor-manager";
import { SlackAuthRegistry, type WorkspaceAuth } from "@/ims/slack/state/auth-registry";
import { SlackMessageUpdateManager } from "@/ims/slack/message-update-manager";
import { deliveryStats, isRateLimitError } from "@/ims/shared/delivery-stats";
import { isSyntheticOwner, threadTsField } from "@/ims/shared/synthetic-owner";

export interface MessageContext {
  channelId: string;
  replyThreadId: string;
  threadId: string;
  userId: string;
  messageId: string;
  workspaceName?: string;
}


const appRegistry = new Map<string, App>();
const TRACE_SLACK_ROUTER = process.env.ODE_SLACK_TRACE === "1";

const slackAuthRegistry = new SlackAuthRegistry();
const slackMessageUpdateManager = new SlackMessageUpdateManager(async ({ channelId, messageTs, text, processorId }) => {
  await performSlackMessageUpdate(channelId, messageTs, text, processorId);
});
const slackProcessorManager = createProcessorManager({
  createRuntime: (processorId) => createCoreRuntime({
    platform: "slack",
    im: createSlackAdapter(processorId),
    agent: createAgentAdapter(),
  }),
  defaultProcessorId: "slack:default",
});
const backgroundWorkspaceSyncInFlight = new Set<string>();

export function clearSlackAuthState(): void {
  slackAuthRegistry.clear();
}

export function resetSlackState(): void {
  clearSlackAuthState();
  appRegistry.clear();
  slackMessageUpdateManager.clear();
  slackProcessorManager.clear();
}

function getSlackProcessorRuntime(processorId?: string): ReturnType<typeof createCoreRuntime> {
  return slackProcessorManager.getRuntime(processorId);
}

async function buildSlackContext(
  channelId: string,
  threadId: string,
  userId: string,
  threadHistory?: string | null
): Promise<OpenCodeMessageContext> {
  return {
    threadHistory: threadHistory ?? undefined,
    slack: {
      platform: "slack",
      channelId,
      threadId,
      userId,
      threadHistory: threadHistory ?? undefined,
      hasGitHubToken: Boolean(getGitHubInfoForUser(userId)?.token),
      channelSystemMessage: getChannelSystemMessage(channelId) ?? undefined,
    },
  };
}

export async function createSlackApp(appToken: string): Promise<App> {
  const normalizedAppToken = appToken.trim();
  if (normalizedAppToken.length === 0) {
    throw new Error("Slack app token missing");
  }

  if (appRegistry.has(normalizedAppToken)) {
    return appRegistry.get(normalizedAppToken)!;
  }

  const auth = slackAuthRegistry.getWorkspaceAuthByAppToken(normalizedAppToken);
  if (!auth) {
    log.warn("No Slack auth for app token", { appToken: truncateToken(normalizedAppToken) });
    throw new Error("Missing Slack auth for app token");
  }

  const createdApp = new App({
    socketMode: true,
    appToken: normalizedAppToken,
    token: auth.botToken,
  });

  appRegistry.set(normalizedAppToken, createdApp);
  return createdApp;
}

export function getApp(): App {
  const first = appRegistry.values().next().value as App | undefined;
  if (!first) throw new Error("Slack app not initialized");
  return first;
}

export function getApps(): App[] {
  return Array.from(appRegistry.values());
}

function isAuthorizedChannel(channelId: string): boolean {
  const targetChannels = getSlackTargetChannels();
  if (!targetChannels) return true;
  return targetChannels.includes(channelId);
}

function resolveWorkspaceAuth(
  credentialKey?: string
): WorkspaceAuth | undefined {
  return slackAuthRegistry.resolveWorkspaceAuth(credentialKey);
}

export function getSlackBotToken(channelId?: string, threadId?: string): string | undefined {
  const rawChannelId = channelId;

  if (rawChannelId && threadId) {
    const threadToken = slackAuthRegistry.getThreadBotToken(rawChannelId, threadId);
    if (threadToken) return threadToken;
  }
  if (rawChannelId) {
    const channelToken = slackAuthRegistry.getChannelWorkspaceBotToken(rawChannelId);
    if (channelToken) return channelToken;
  }
  const registered = slackAuthRegistry.getFirstRegisteredBotToken();
  if (registered) return registered;
  const tokens = getSlackBotTokens()
    .map((entry) => entry.token)
    .filter((token) => token && token.trim().length > 0);
  return tokens[0];
}

function getSlackBotTokenForProcessor(processorId?: string): string | undefined {
  const normalizedProcessorId = processorId?.trim();
  if (!normalizedProcessorId) return undefined;
  return slackAuthRegistry.findBotTokenByProcessorId(
    normalizedProcessorId,
    (botToken) => createProcessorId("slack", botToken)
  );
}

function truncateToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function tokenLast6(token?: string): string | undefined {
  if (!token) return undefined;
  return token.slice(-6);
}

async function syncWorkspaceAfterMention(
  channelId: string,
  workspace: { workspaceId?: string; workspaceName?: string } | undefined
): Promise<boolean> {
  if (!workspace?.workspaceId) {
    log.warn("Skipping Slack workspace sync; workspace id missing", {
      channelId,
      workspaceName: workspace?.workspaceName,
    });
    return false;
  }

  if (backgroundWorkspaceSyncInFlight.has(workspace.workspaceId)) {
    log.debug("Skipping Slack workspace sync; already in flight", {
      workspaceId: workspace.workspaceId,
      channelId,
    });
    return false;
  }

  backgroundWorkspaceSyncInFlight.add(workspace.workspaceId);
  try {
    const updatedWorkspace = await syncSlackWorkspace(workspace.workspaceId);
    invalidateOdeConfigCache();
    log.info("Slack workspace synced after mention in unseen channel", {
      workspaceId: workspace.workspaceId,
      workspaceName: updatedWorkspace.name,
      channelId,
    });
    return true;
  } catch (error) {
    log.warn("Slack workspace sync failed after mention in unseen channel", {
      workspaceId: workspace.workspaceId,
      channelId,
      error: String(error),
    });
    return false;
  } finally {
    backgroundWorkspaceSyncInFlight.delete(workspace.workspaceId);
  }
}

function buildWorkspaceAuthFromConfig(
  appToken: string,
  botToken: string,
  workspaceId: string,
  workspaceName: string
): WorkspaceAuth {
  return {
    appToken,
    botToken,
    workspaceId,
    workspaceName,
    teamId: null,
    enterpriseId: null,
    botUserId: null,
    botId: null,
    userId: null,
  };
}

function registerWorkspaceAuth(auth: WorkspaceAuth): void {
  slackAuthRegistry.registerWorkspaceAuth(auth);
}

function asWorkspaceAuth(auth: { [key: string]: unknown } | undefined): WorkspaceAuth | null {
  const appToken = typeof auth?.appToken === "string" ? auth.appToken : "";
  const botToken = typeof auth?.botToken === "string" ? auth.botToken : "";
  const workspaceId = typeof auth?.workspaceId === "string" ? auth.workspaceId : "";
  const workspaceName = typeof auth?.workspaceName === "string" ? auth.workspaceName : "config";
  if (!appToken || !botToken || !workspaceId) return null;
  return {
    appToken,
    botToken,
    workspaceId,
    workspaceName,
    teamId: typeof auth?.teamId === "string" ? auth.teamId : null,
    enterpriseId: typeof auth?.enterpriseId === "string" ? auth.enterpriseId : null,
    botUserId: typeof auth?.botUserId === "string" ? auth.botUserId : null,
    botId: typeof auth?.botId === "string" ? auth.botId : null,
    userId: typeof auth?.userId === "string" ? auth.userId : null,
  };
}

export async function initializeWorkspaceAuth(): Promise<void> {
  const combined = new Map<string, { appToken: string; workspaceId: string; workspaceName: string }>();

  for (const record of getSlackBotTokens()) {
    combined.set(record.token, {
      appToken: record.appToken,
      workspaceId: record.workspaceId,
      workspaceName: record.workspaceName ?? "config",
    });
  }

  if (combined.size === 0) {
    log.warn("No Slack bot tokens configured", { mode: "local" });
  }

  const auths = Array.from(combined.entries()).map(([botToken, workspace]) => {
    if (!botToken) return null;
    const name = workspace.workspaceName ?? "unknown";
    return buildWorkspaceAuthFromConfig(workspace.appToken, botToken, workspace.workspaceId, name);
  });

  for (const auth of auths) {
    if (!auth) continue;
    registerWorkspaceAuth(auth);
    log.debug("Registered Slack workspace auth", {
      workspace: auth.workspaceName,
      workspaceId: auth.workspaceId,
      teamId: auth.teamId,
      enterpriseId: auth.enterpriseId,
      botUserId: auth.botUserId,
      botToken: truncateToken(auth.botToken),
    });
  }
}

export async function sendMessage(
  channelId: string,
  threadId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  const rawChannelId = channelId;
  const slackApp = getApp();
  const formattedText = markdownToSlack(text);
  const chunks = splitForSlack(formattedText);
  const workspace = slackAuthRegistry.getChannelWorkspaceName(rawChannelId) || "unknown";

  // A "synthetic" thread id (`task:{id}` / `cron-job:{id}:{run}` / `cron:{id}`)
  // is an internal placeholder the task/cron schedulers use before a real
  // Slack `thread_ts` exists. Slack rejects these with `invalid_thread_ts`
  // because they are not message timestamps, so any intermediate output the
  // agent runtime emits during a scheduled run is lost and captured as a
  // Sentry delivery failure (ODE-DEAMON-7). Degenerate to a top-level channel
  // post instead so the message still lands in the channel.
  const threadIsSynthetic = isSyntheticOwner(threadId);

  // Token resolution. For real threads prefer the registry-bound token for
  // this (channel, thread) — that's the token the inbound router observed
  // delivering the parent message. For synthetic placeholders the call has
  // degenerated to a top-level post and the registry has no entry for a fake
  // `thread_ts`, so resolve via the channel's workspace first (mirroring
  // `sendChannelMessage`) to avoid the multi-workspace case where
  // `getSlackBotToken` returns the first registered token instead of the one
  // for `rawChannelId`.
  const botToken = getSlackBotTokenForProcessor(processorId)
    ?? (threadIsSynthetic
      ? (getWorkspaceBotTokenForChannel(channelId) ?? getSlackBotToken(channelId))
      : getSlackBotToken(channelId, threadId));

  if (!botToken) {
    log.warn("No Slack bot token available for channel", { channelId });
  }

  if (TRACE_SLACK_ROUTER) {
    log.info("[SLACK] Outgoing message", {
      workspace,
      channel: channelId,
      thread: threadId,
      threadIsSynthetic,
      botTokenLast6: tokenLast6(botToken),
      text,
      chunks: chunks.length,
    });
  } else {
    log.debug("[SLACK] Outgoing message", {
      workspace,
      channel: channelId,
      thread: threadId,
      threadIsSynthetic,
      botTokenLast6: tokenLast6(botToken),
      text,
      chunks: chunks.length,
    });
  }

  let lastTs: string | undefined;
  for (const chunk of chunks) {
    deliveryStats.recordAttempt({
      platform: "slack",
      channelId: rawChannelId,
      op: "send",
      processorId,
    });
    try {
      const result = await slackApp.client.chat.postMessage({
        channel: rawChannelId,
        ...(threadTsField(threadId)),
        text: chunk,
        token: botToken,
      });
      deliveryStats.recordSuccess({
        platform: "slack",
        channelId: rawChannelId,
        op: "send",
        processorId,
      });
      lastTs = result.ts;
      if (botToken && result.ts) {
        // Never bind a real bot token to a synthetic placeholder thread id —
        // the real platform-assigned thread is `result.ts` for the first
        // message of the run, which `setMessageBotToken` covers below.
        if (!threadIsSynthetic) {
          slackAuthRegistry.setThreadBotToken(rawChannelId, threadId, botToken);
        }
        slackAuthRegistry.setMessageBotToken(rawChannelId, result.ts, botToken);
      }
    } catch (err) {
      const rateLimited = isRateLimitError(err);
      deliveryStats.recordFailure({
        platform: "slack",
        channelId: rawChannelId,
        op: "send",
        error: err,
        rateLimited,
        processorId,
        threadId,
      });
      deliveryStats.logThrottledWarn(
        `slack-send:${rawChannelId}`,
        "Slack sendMessage failed",
        {
          channelId: rawChannelId,
          threadId,
          rateLimited,
          error: String(err),
        },
      );
      throw err;
    }
  }
  return lastTs;
}

function getWorkspaceBotTokenForChannel(channelId: string): string | undefined {
  const resolvedChannelId = channelId.trim();
  for (const workspace of getWorkspaces()) {
    if (workspace.type !== "slack") continue;
    if (!workspace.channelDetails.some((channel) => channel.id === resolvedChannelId)) continue;
    const botToken = workspace.slackBotToken?.trim();
    if (botToken) return botToken;
  }
  return undefined;
}

export async function sendChannelMessage(
  channelId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  const rawChannelId = channelId;
  const slackApp = getApp();
  const formattedText = markdownToSlack(text);
  const chunks = splitForSlack(formattedText);
  const botToken = getSlackBotTokenForProcessor(processorId)
    ?? getWorkspaceBotTokenForChannel(channelId)
    ?? getSlackBotToken(channelId);

  if (!botToken) {
    log.warn("No Slack bot token available for top-level channel message", { channelId });
  }

  let lastTs: string | undefined;
  for (const chunk of chunks) {
    deliveryStats.recordAttempt({
      platform: "slack",
      channelId: rawChannelId,
      op: "send",
      processorId,
    });
    try {
      const result = await slackApp.client.chat.postMessage({
        channel: rawChannelId,
        text: chunk,
        token: botToken,
      });
      deliveryStats.recordSuccess({
        platform: "slack",
        channelId: rawChannelId,
        op: "send",
        processorId,
      });
      lastTs = result.ts;
      if (botToken && result.ts) {
        slackAuthRegistry.setMessageBotToken(rawChannelId, result.ts, botToken);
      }
    } catch (err) {
      const rateLimited = isRateLimitError(err);
      deliveryStats.recordFailure({
        platform: "slack",
        channelId: rawChannelId,
        op: "send",
        error: err,
        rateLimited,
        processorId,
      });
      deliveryStats.logThrottledWarn(
        `slack-send-channel:${rawChannelId}`,
        "Slack sendChannelMessage failed",
        {
          channelId: rawChannelId,
          rateLimited,
          error: String(err),
        },
      );
      throw err;
    }
  }
  return lastTs;
}

export async function deleteMessage(
  channelId: string,
  messageTs: string,
  processorId?: string
): Promise<void> {
  const rawChannelId = channelId;
  deliveryStats.recordAttempt({
    platform: "slack",
    channelId: rawChannelId,
    op: "delete",
    processorId,
  });
  try {
    const slackApp = getApp();
    const botToken = getSlackBotTokenForProcessor(processorId)
      ?? slackAuthRegistry.getMessageBotToken(rawChannelId, messageTs)
      ?? getSlackBotToken(channelId);
    if (!botToken) {
      log.warn("No Slack bot token available for message delete", { channelId });
    }
    await slackApp.client.chat.delete({
      channel: rawChannelId,
      ts: messageTs,
      token: botToken,
    });
    deliveryStats.recordSuccess({
      platform: "slack",
      channelId: rawChannelId,
      op: "delete",
      processorId,
    });
  } catch (err) {
    const rateLimited = isRateLimitError(err);
    deliveryStats.recordFailure({
      platform: "slack",
      channelId: rawChannelId,
      op: "delete",
      error: err,
      rateLimited,
      processorId,
      messageTs,
    });
    deliveryStats.logThrottledWarn(
      `slack-delete:${rawChannelId}`,
      "Slack deleteMessage failed",
      {
        channelId: rawChannelId,
        messageTs,
        rateLimited,
        error: String(err),
      },
    );
    // Ignore delete failures for callers; recorded in stats instead.
  }
}

async function performSlackMessageUpdate(
  channelId: string,
  messageTs: string,
  text: string,
  processorId?: string
): Promise<void> {
  const rawChannelId = channelId;
  deliveryStats.recordAttempt({
    platform: "slack",
    channelId: rawChannelId,
    op: "update",
    processorId,
  });
  try {
    const slackApp = getApp();
    const formattedText = markdownToSlack(text);
    const truncatedText = truncateForSlack(formattedText);
    const botToken = getSlackBotTokenForProcessor(processorId)
      ?? slackAuthRegistry.getMessageBotToken(rawChannelId, messageTs)
      ?? getSlackBotToken(channelId);
    if (!botToken) {
      log.warn("No Slack bot token available for message update", { channelId });
    }
    await slackApp.client.chat.update({
      channel: rawChannelId,
      ts: messageTs,
      text: truncatedText,
      token: botToken,
    });
    deliveryStats.recordSuccess({
      platform: "slack",
      channelId: rawChannelId,
      op: "update",
      processorId,
    });
  } catch (err) {
    const rateLimited = isRateLimitError(err);
    deliveryStats.recordFailure({
      platform: "slack",
      channelId: rawChannelId,
      op: "update",
      error: err,
      rateLimited,
      processorId,
      messageTs,
    });
    const message = String(err);
    log.debug("Failed to update message", { error: message });
    if (rateLimited) {
      // Rate-limit errors are rethrown so the core layer can mark the message
      // as 429-ed and switch to the "post final result as a new message"
      // fallback path in runtime-support.ts.
      throw err;
    }
    // Non-429 update failures used to be silently swallowed at DEBUG level,
    // which hid "status message disappeared" bugs. Surface them at WARN,
    // throttled per channel to avoid flooding the logs on a flapping channel.
    deliveryStats.logThrottledWarn(
      `slack-update:${rawChannelId}`,
      "Slack updateMessage failed (non-429)",
      {
        channelId: rawChannelId,
        messageTs,
        error: message,
      },
    );
  }
}

export async function updateMessage(
  channelId: string,
  messageTs: string,
  text: string,
  processorId?: string
): Promise<void> {
  await slackMessageUpdateManager.updateMessage({ channelId, messageTs, text, processorId });
}

async function fetchThreadHistory(
  channelId: string,
  threadId: string,
  messageId: string,
  processorId?: string
): Promise<string | null> {
  const rawChannelId = channelId;
  return fetchThreadHistoryByClient({
    client: getApp().client,
    channelId: rawChannelId,
    threadId,
    messageId,
    token: getSlackBotTokenForProcessor(processorId) ?? getSlackBotToken(channelId, threadId),
  });
}

function createSlackAdapter(processorId?: string): IMAdapter {
  return {
    maxEditableMessageChars: 35_000,
    sendMessage: (channelId: string, threadId: string, text: string) =>
      sendMessage(channelId, threadId, text, processorId),
    updateMessage: (channelId: string, messageTs: string, text: string) =>
      updateMessage(channelId, messageTs, text, processorId),
    cancelPendingUpdates: (channelId: string, messageTs: string) =>
      slackMessageUpdateManager.cancelPendingUpdates(channelId, messageTs),
    markMessageFinalized: (channelId: string, messageTs: string) =>
      slackMessageUpdateManager.markMessageFinalized(channelId, messageTs),
    deleteMessage: (channelId: string, messageTs: string) =>
      deleteMessage(channelId, messageTs, processorId),
    fetchThreadHistory: (channelId: string, threadId: string, messageId: string) =>
      fetchThreadHistory(channelId, threadId, messageId, processorId),
    buildAgentContext: async ({ channelId, threadId, userId, threadHistory }) =>
      buildSlackContext(channelId, threadId, userId, threadHistory),
  };
}

const slackAdapter: IMAdapter = createSlackAdapter();

const slackRecoveryRuntime = createCoreRuntime({
  platform: "slack",
  im: slackAdapter,
  agent: createAgentAdapter(),
});

export async function recoverPendingRequests(options?: { startedBeforeMs?: number }): Promise<void> {
  await slackRecoveryRuntime.recoverPendingRequests(options);
}

export async function handleButtonSelection(
  channelId: string,
  threadId: string,
  userId: string,
  selection: string,
  messageTs: string
): Promise<void> {
  const botToken = slackAuthRegistry.getMessageBotToken(channelId, messageTs)
    ?? slackAuthRegistry.getThreadBotToken(channelId, threadId);
  const processorId = createProcessorId("slack", botToken ?? "");
  const runtime = getSlackProcessorRuntime(processorId);
  await runtime.handleButtonSelection({
    channelId,
    rawChannelId: channelId,
    replyThreadId: threadId,
    threadId,
    userId,
    selection,
    messageTs,
  });
}

export function setupMessageHandlers(): void {
  for (const slackApp of getApps()) {
    registerSlackMessageRouter({
      app: slackApp,
      isAuthorizedChannel,
      resolveWorkspaceAuth,
      syncWorkspaceForChannel: syncWorkspaceAfterMention,
      getChannelWorkspaceName: (channelId) => slackAuthRegistry.getChannelWorkspaceName(channelId),
      setChannelWorkspaceName: (channelId, workspaceName) => {
        slackAuthRegistry.setChannelWorkspaceName(channelId, workspaceName);
      },
      setChannelWorkspaceAuth: (channelId, auth) => {
        const workspaceAuth = asWorkspaceAuth(auth);
        if (!workspaceAuth) return;
        registerWorkspaceAuth(workspaceAuth);
        slackAuthRegistry.setChannelWorkspaceAuthByBotToken(channelId, workspaceAuth.botToken);
      },
      isThreadOwner: (channelId, threadId, userId) => {
        const session = loadSession(channelId, threadId);
        const owner = session?.threadOwnerUserId;
        if (!owner) return false;
        // Synthetic owners (task:/cron:) are placeholders for bot-started
        // threads; treat any real user as the claimable owner so the first
        // human replier can adopt the thread.
        if (isSyntheticOwner(owner)) return true;
        return owner === userId;
      },
      isThreadActive,
      postGeneralSettingsLauncher: postSlackGeneralSettingsLauncher,
      postCronLauncher: postSlackChannelCronLauncher,
      describeSettingsIssues: describeSlackSettingsIssues,
      handleInboundEvent: async (event) => {
        const rawChannelId = event.rawChannelId ?? event.channelId;
        if (event.botId) {
          slackAuthRegistry.setThreadBotToken(rawChannelId, event.replyThreadId, event.botId);
          slackAuthRegistry.setThreadBotToken(rawChannelId, event.threadId, event.botId);
        }
        const processorId = createProcessorId("slack", event.botId ?? "");
        if (TRACE_SLACK_ROUTER) {
          log.info("Slack runtime dispatch", {
            channelId: event.channelId,
            threadId: event.threadId,
            replyThreadId: event.replyThreadId,
            messageId: event.messageId,
            botTokenLast6: tokenLast6(event.botId),
            processorId,
            mentionedBot: event.mentionedBot,
            activeThread: event.activeThread,
          });
        } else {
          log.debug("Slack runtime dispatch", {
            channelId: event.channelId,
            threadId: event.threadId,
            replyThreadId: event.replyThreadId,
            messageId: event.messageId,
            botTokenLast6: tokenLast6(event.botId),
            processorId,
            mentionedBot: event.mentionedBot,
            activeThread: event.activeThread,
          });
        }
        await getSlackProcessorRuntime(processorId).handleInboundEvent(event);
      },
    });

  }

}
