import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { join } from "path";
import {
  getSlackTargetChannels,
  getSlackBotTokens,
  invalidateOdeConfigCache,
  getChannelAgentProvider,
  getGitHubInfoForUser,
  getChannelSystemMessage,
} from "@/config";
import { markdownToSlack, splitForSlack, truncateForSlack } from "./formatter";
import {
  markThreadActive,
  isThreadActive,
  getPendingRestartMessages,
  clearPendingRestartMessages,
} from "@/config/local/settings";
import { createCoreRuntime } from "@/core/runtime";
import type { IMAdapter } from "@/core/types";
import { createMessageProcessor } from "@/agents/message-processor";
import type { OpenCodeMessageContext } from "@/agents";
import { log } from "@/utils";
import { getSlackActionApiUrl } from "./config";
import { fetchThreadHistoryByClient } from "./message-history";
import { registerSlackMessageRouter } from "./message-router";
import { syncSlackWorkspace } from "@/core/web/local-settings";
import { describeSlackSettingsIssues, postSlackGeneralSettingsLauncher } from "./settings";
import {
  createProcessorId,
  getScopedProcessorId,
  scopeChannelId,
  unscopeChannelId,
} from "@/ims/shared/processor-scope";
import { createProcessorManager } from "@/ims/shared/processor-manager";
import { SlackAuthRegistry, type WorkspaceAuth } from "@/ims/slack/state/auth-registry";

export interface MessageContext {
  channelId: string;
  replyThreadId: string;
  threadId: string;
  userId: string;
  messageId: string;
  workspaceName?: string;
}


const appRegistry = new Map<string, App>();

const slackAuthRegistry = new SlackAuthRegistry();
const slackProcessorManager = createProcessorManager({
  createRuntime: () => createCoreRuntime({
    platform: "slack",
    im: slackAdapter,
    agent: createMessageProcessor(),
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
  slackProcessorManager.clear();
}

function getSlackProcessorRuntime(processorId?: string): ReturnType<typeof createCoreRuntime> {
  return slackProcessorManager.getRuntime(processorId);
}

function getOdeSlackApiUrl(): string | undefined {
  return getSlackActionApiUrl();
}

async function buildSlackContext(
  cwd: string,
  channelId: string,
  threadId: string,
  userId: string,
  threadHistory?: string | null
): Promise<OpenCodeMessageContext> {
  const rawChannelId = unscopeChannelId(channelId);
  return {
    threadHistory: threadHistory || undefined,
    slack: {
      platform: "slack",
      channelId: rawChannelId,
      threadId,
      userId,
      threadHistory: threadHistory || undefined,
      hasCustomSlackTool: await hasOdeSlackTool(cwd),
      odeSlackApiUrl: getOdeSlackApiUrl(),
      hasGitHubToken: Boolean(getGitHubInfoForUser(userId)?.token),
      channelSystemMessage: getChannelSystemMessage(rawChannelId) ?? undefined,
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
  const rawChannelId = channelId ? unscopeChannelId(channelId) : undefined;
  const scopedProcessorId = channelId ? getScopedProcessorId(channelId) : undefined;

  if (scopedProcessorId) {
    const scopedToken = slackAuthRegistry.findBotTokenByProcessorId(
      scopedProcessorId,
      (botToken) => createProcessorId("slack", botToken)
    );
    if (scopedToken) return scopedToken;
  }

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

async function hasOdeSlackTool(workingPath: string): Promise<boolean> {
  const basePath = join(workingPath, ".opencode", "tools");
  const candidates = [
    "ode_action.ts",
    "ode_action.js",
    "ode_action.mjs",
    "ode_action.cjs",
  ];

  for (const candidate of candidates) {
    const file = Bun.file(join(basePath, candidate));
    if (await file.exists()) return true;
  }

  return false;
}

function truncateToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
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

async function fetchWorkspaceAuth(
  appToken: string,
  botToken: string,
  workspaceId: string,
  workspaceName: string
): Promise<WorkspaceAuth | null> {
  try {
    const client = new WebClient(botToken);
    const auth = await client.auth.test();
    return {
      appToken,
      botToken,
      workspaceId,
      workspaceName,
      teamId: (auth as any).team_id ?? null,
      enterpriseId: (auth as any).enterprise_id ?? null,
      botUserId: (auth as any).bot_user_id ?? (auth as any).user_id ?? null,
      botId: (auth as any).bot_id ?? null,
      userId: (auth as any).user_id ?? null,
    };
  } catch (err) {
    log.error("Slack auth.test failed", {
      botToken: truncateToken(botToken),
      workspaceName,
      error: String(err),
    });
    return null;
  }
}

function registerWorkspaceAuth(auth: WorkspaceAuth): void {
  slackAuthRegistry.registerWorkspaceAuth(auth);
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

  for (const [botToken, workspace] of combined.entries()) {
    if (!botToken) continue;
    const name = workspace.workspaceName ?? "unknown";
    const auth = await fetchWorkspaceAuth(workspace.appToken, botToken, workspace.workspaceId, name);
    if (!auth) continue;
    registerWorkspaceAuth(auth);
    log.debug("Registered Slack workspace auth", {
      workspace: name,
      workspaceId: auth.workspaceId,
      teamId: auth.teamId,
      enterpriseId: auth.enterpriseId,
      botUserId: auth.botUserId,
      botToken: truncateToken(botToken),
    });
  }
}

export async function sendMessage(
  channelId: string,
  threadId: string,
  text: string
): Promise<string | undefined> {
  const rawChannelId = unscopeChannelId(channelId);
  const slackApp = getApp();
  const formattedText = markdownToSlack(text);
  const chunks = splitForSlack(formattedText);
  const workspace = slackAuthRegistry.getChannelWorkspaceName(rawChannelId) || "unknown";
  const botToken = getSlackBotToken(channelId, threadId);

  if (!botToken) {
    log.warn("No Slack bot token available for channel", { channelId });
  }

  log.debug("[SLACK] Outgoing message", {
    workspace,
    channel: channelId,
    thread: threadId,
    text,
    chunks: chunks.length,
  });

  let lastTs: string | undefined;
  for (const chunk of chunks) {
    const result = await slackApp.client.chat.postMessage({
      channel: rawChannelId,
      thread_ts: threadId,
      text: chunk,
      token: botToken,
    });
    lastTs = result.ts;
    if (botToken && result.ts) {
      slackAuthRegistry.setThreadBotToken(rawChannelId, threadId, botToken);
      slackAuthRegistry.setMessageBotToken(rawChannelId, result.ts, botToken);
    }
  }
  return lastTs;
}

export async function deleteMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  try {
    const rawChannelId = unscopeChannelId(channelId);
    const slackApp = getApp();
    const botToken = slackAuthRegistry.getMessageBotToken(rawChannelId, messageTs) ?? getSlackBotToken(channelId);
    if (!botToken) {
      log.warn("No Slack bot token available for message delete", { channelId });
    }
    await slackApp.client.chat.delete({
      channel: rawChannelId,
      ts: messageTs,
      token: botToken,
    });
  } catch {
    // Ignore delete failures
  }
}

export async function updateMessage(
  channelId: string,
  messageTs: string,
  text: string
): Promise<void> {
  try {
    const rawChannelId = unscopeChannelId(channelId);
    const slackApp = getApp();
    const formattedText = markdownToSlack(text);
    const truncatedText = truncateForSlack(formattedText);
    const botToken = slackAuthRegistry.getMessageBotToken(rawChannelId, messageTs) ?? getSlackBotToken(channelId);
    if (!botToken) {
      log.warn("No Slack bot token available for message update", { channelId });
    }
    await slackApp.client.chat.update({
      channel: rawChannelId,
      ts: messageTs,
      text: truncatedText,
      token: botToken,
    });
  } catch (err) {
    const message = String(err);
    log.debug("Failed to update message", { error: message });
    const normalized = message.toLowerCase();
    if (normalized.includes("429") || normalized.includes("rate_limited") || normalized.includes("rate limit")) {
      throw err;
    }
  }
}

async function fetchThreadHistory(
  channelId: string,
  threadId: string,
  messageId: string
): Promise<string | null> {
  const rawChannelId = unscopeChannelId(channelId);
  return fetchThreadHistoryByClient({
    client: getApp().client,
    channelId: rawChannelId,
    threadId,
    messageId,
    token: getSlackBotToken(channelId, threadId),
  });
}

const slackAdapter: IMAdapter = {
  maxEditableMessageChars: 35_000,
  sendMessage,
  updateMessage,
  deleteMessage,
  fetchThreadHistory,
  buildAgentContext: async ({ cwd, channelId, threadId, userId, threadHistory }) =>
    buildSlackContext(cwd, channelId, threadId, userId, threadHistory),
};

const slackRecoveryRuntime = createCoreRuntime({
  platform: "slack",
  im: slackAdapter,
  agent: createMessageProcessor(),
});

export async function recoverPendingRequests(): Promise<void> {
  await slackRecoveryRuntime.recoverPendingRequests();

  const pendingRestartMessages = getPendingRestartMessages();
  if (pendingRestartMessages.length === 0) {
    return;
  }

  log.info("Updating pending restart messages", { count: pendingRestartMessages.length });

  for (const pendingRestart of pendingRestartMessages) {
    await updateMessage(
      pendingRestart.channelId,
      pendingRestart.messageTs,
      "Restarting Ode complete."
    );
  }

  clearPendingRestartMessages();
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
  const scopedChannelId = scopeChannelId(processorId, channelId);
  const runtime = getSlackProcessorRuntime(processorId);
  await runtime.handleButtonSelection({
    channelId: scopedChannelId,
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
        if (!auth?.botToken) return;
        slackAuthRegistry.setChannelWorkspaceAuthByBotToken(channelId, auth.botToken);
      },
      isThreadActive,
      markThreadActive,
      postGeneralSettingsLauncher: postSlackGeneralSettingsLauncher,
      describeSettingsIssues: describeSlackSettingsIssues,
      getChannelAgentProvider,
      handleStopCommand: (channelId, threadId) => {
        const processorId = getScopedProcessorId(channelId);
        return getSlackProcessorRuntime(processorId).handleStopCommand(channelId, threadId);
      },
      handleIncomingMessage: (context, text) => {
        if (context.botToken) {
          const rawChannelId = context.rawChannelId ?? unscopeChannelId(context.channelId);
          slackAuthRegistry.setThreadBotToken(rawChannelId, context.replyThreadId, context.botToken);
          slackAuthRegistry.setThreadBotToken(rawChannelId, context.threadId, context.botToken);
        }
        const processorId = getScopedProcessorId(context.channelId)
          ?? createProcessorId("slack", context.botToken ?? "");
        return getSlackProcessorRuntime(processorId).handleIncomingMessage(context, text);
      },
    });

  }

}
