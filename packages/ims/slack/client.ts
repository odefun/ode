import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { existsSync } from "fs";
import { join } from "path";
import {
  getSlackTargetChannels,
  getSlackBotTokens,
  invalidateOdeConfigCache,
  getChannelAgentProvider,
  getChannelModel,
  getOpenCodeModels,
  isAgentEnabled,
  getGitHubInfoForUser,
  getChannelSystemMessage,
  resolveChannelCwd,
} from "@/config";
import { markdownToSlack, splitForSlack } from "./formatter";
import {
  markThreadActive,
  isThreadActive,
  getPendingRestartMessages,
  clearPendingRestartMessages,
} from "@/config/local/settings";
import { createCoreRuntime } from "@/core/runtime";
import type { IMAdapter } from "@/core/types";
import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import { log } from "@/utils";
import { getSlackActionApiUrl } from "./config";
import { createThrottledMessageUpdater } from "./message-updates";
import { fetchThreadHistoryByClient } from "./message-history";
import { registerSlackMessageRouter } from "./message-router";
import { syncSlackWorkspace } from "@/core/web/local-settings";

export interface MessageContext {
  channelId: string;
  threadId: string;
  userId: string;
  messageId: string;
  workspaceName?: string;
}


const appRegistry = new Map<string, App>();


type WorkspaceAuth = {
  appToken: string;
  botToken: string;
  workspaceId: string;
  workspaceName: string;
  teamId: string | null;
  enterpriseId: string | null;
  botUserId: string | null;
  botId: string | null;
  userId: string | null;
};

const teamAuthMap = new Map<string, WorkspaceAuth>();
const enterpriseAuthMap = new Map<string, WorkspaceAuth>();
const channelWorkspaceMap = new Map<string, string>();
const channelWorkspaceAuthMap = new Map<string, WorkspaceAuth>();
const backgroundWorkspaceSyncInFlight = new Set<string>();

export function clearSlackAuthState(): void {
  teamAuthMap.clear();
  enterpriseAuthMap.clear();
  channelWorkspaceMap.clear();
  channelWorkspaceAuthMap.clear();
}

export function resetSlackState(): void {
  clearSlackAuthState();
  appRegistry.clear();
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
  return {
    threadHistory: threadHistory || undefined,
    slack: {
      channelId,
      threadId,
      userId,
      threadHistory: threadHistory || undefined,
      hasCustomSlackTool: await hasOdeSlackTool(cwd),
      odeSlackApiUrl: getOdeSlackApiUrl(),
      hasGitHubToken: Boolean(getGitHubInfoForUser(userId)?.token),
      channelSystemMessage: getChannelSystemMessage(channelId) ?? undefined,
    },
  };
}

const updateMessageThrottled = createThrottledMessageUpdater({
  getApp,
  getSlackBotToken,
});

export async function createSlackApp(appToken: string): Promise<App> {
  const normalizedAppToken = appToken.trim();
  if (normalizedAppToken.length === 0) {
    throw new Error("Slack app token missing");
  }

  if (appRegistry.has(normalizedAppToken)) {
    return appRegistry.get(normalizedAppToken)!;
  }

  const createdApp = new App({
    socketMode: true,
    appToken: normalizedAppToken,
    authorize: async ({ teamId, enterpriseId }) => {
      const auth = resolveWorkspaceAuth(teamId, enterpriseId);
      if (!auth) {
        log.warn("No Slack auth for workspace", { teamId, enterpriseId });
        throw new Error("Missing Slack auth for workspace");
      }

      return {
        botToken: auth.botToken,
        botId: auth.botId ?? undefined,
        botUserId: auth.botUserId ?? undefined,
      };
    },
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
  teamId?: string,
  enterpriseId?: string
): WorkspaceAuth | undefined {
  if (teamId && teamAuthMap.has(teamId)) {
    return teamAuthMap.get(teamId);
  }

  if (enterpriseId && enterpriseAuthMap.has(enterpriseId)) {
    return enterpriseAuthMap.get(enterpriseId);
  }

  return undefined;
}

export function getSlackBotToken(channelId?: string): string | undefined {
  if (channelId) {
    const channelAuth = channelWorkspaceAuthMap.get(channelId);
    if (channelAuth?.botToken) return channelAuth.botToken;
  }
  const registered = teamAuthMap.values().next().value as WorkspaceAuth | undefined;
  if (registered?.botToken) return registered.botToken;
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

function describeSettingsIssues(channelId: string): string[] {
  const issues: string[] = [];
  const provider = getChannelAgentProvider(channelId);
  const model = getChannelModel(channelId);
  const { workingDirectory } = resolveChannelCwd(channelId);
  const normalizeModel = (value: string) => value.trim().toLowerCase();

  if (!isAgentEnabled(provider)) {
    issues.push(`Agent not enabled: ${provider}`);
  }

  if (provider === "opencode") {
    const models = getOpenCodeModels();
    const modelSet = new Set(models.map(normalizeModel));
    if (!model) {
      issues.push("Model not configured.");
    } else if (!modelSet.has(normalizeModel(model))) {
      issues.push("Model not available in configured OpenCode models.");
    }
  }

  if (!workingDirectory) {
    issues.push("Working directory not configured.");
  } else if (!existsSync(workingDirectory)) {
    issues.push(`Working directory not found: ${workingDirectory}`);
  }

  return issues;
}

function isChannelSettingsCommand(text: string): boolean {
  return /^\/channel\b/i.test(text.trim());
}

function isGeneralSettingsCommand(text: string): boolean {
  return /^\/setting\b/i.test(text.trim());
}

function isGitHubCommand(text: string): boolean {
  return /^\/gh\b/i.test(text.trim());
}

async function postChannelSettingsLauncher(
  channelId: string,
  userId: string,
  client: WebClient
): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "Open channel settings",
    blocks: [
      {
        type: "section",
          text: {
            type: "mrkdwn",
            text: "Open channel settings for agent, working directory, base branch, and optional channel system message (model appears for OpenCode and Codex).",
          },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_settings_modal",
            text: { type: "plain_text", text: "Open settings" },
            value: channelId,
          },
        ],
      },
    ],
  });
}

async function postGeneralSettingsLauncher(
  channelId: string,
  userId: string,
  client: WebClient
): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "Open settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Choose which settings page to open.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_general_settings_modal",
            text: { type: "plain_text", text: "general setting" },
            value: channelId,
          },
          {
            type: "button",
            action_id: "open_settings_modal",
            text: { type: "plain_text", text: "channel setting" },
            value: channelId,
          },
        ],
      },
    ],
  });
}

async function postGitHubLauncher(
  channelId: string,
  userId: string,
  client: WebClient
): Promise<void> {
  const hasToken = Boolean(getGitHubInfoForUser(userId)?.token);
  const statusText = hasToken
    ? "GitHub token is set for your account."
    : "No GitHub token set yet.";

  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: "Open GitHub info settings",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${statusText} Add or update your info to enable GitHub CLI actions.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_github_token_modal",
            text: { type: "plain_text", text: "Set GitHub info" },
            value: channelId,
          },
        ],
      },
    ],
  });
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
  if (auth.teamId) {
    teamAuthMap.set(auth.teamId, auth);
  }
  if (auth.enterpriseId) {
    enterpriseAuthMap.set(auth.enterpriseId, auth);
  }
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
  text: string,
  asMarkdown = true
): Promise<string | undefined> {
  const slackApp = getApp();
  const formattedText = asMarkdown ? markdownToSlack(text) : text;
  const chunks = splitForSlack(formattedText);
  const workspace = channelWorkspaceMap.get(channelId) || "unknown";
  const botToken = getSlackBotToken(channelId);

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
      channel: channelId,
      thread_ts: threadId,
      text: chunk,
      token: botToken,
    });
    lastTs = result.ts;
  }
  return lastTs;
}

export async function deleteMessage(
  channelId: string,
  messageTs: string
): Promise<void> {
  try {
    const slackApp = getApp();
    const botToken = getSlackBotToken(channelId);
    if (!botToken) {
      log.warn("No Slack bot token available for message delete", { channelId });
    }
    await slackApp.client.chat.delete({
      channel: channelId,
      ts: messageTs,
      token: botToken,
    });
  } catch {
    // Ignore delete failures
  }
}

async function fetchThreadHistory(
  channelId: string,
  threadId: string,
  messageId: string
): Promise<string | null> {
  return fetchThreadHistoryByClient({
    client: getApp().client,
    channelId,
    threadId,
    messageId,
    token: getSlackBotToken(channelId),
  });
}

const slackAdapter: IMAdapter = {
  sendMessage,
  updateMessage: updateMessageThrottled,
  deleteMessage,
  fetchThreadHistory,
  buildAgentContext: async ({ cwd, channelId, threadId, userId, threadHistory }) =>
    buildSlackContext(cwd, channelId, threadId, userId, threadHistory),
};

const coreRuntime = createCoreRuntime({
  im: slackAdapter,
  agent: createAgentAdapter(),
});

export async function recoverPendingRequests(): Promise<void> {
  await coreRuntime.recoverPendingRequests();

  const pendingRestartMessages = getPendingRestartMessages();
  if (pendingRestartMessages.length === 0) {
    return;
  }

  log.info("Updating pending restart messages", { count: pendingRestartMessages.length });

  for (const pendingRestart of pendingRestartMessages) {
    await updateMessageThrottled(
      pendingRestart.channelId,
      pendingRestart.messageTs,
      "Restarting Ode complete.",
      false
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
  await coreRuntime.handleButtonSelection({
    channelId,
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
      getChannelWorkspaceName: (channelId) => channelWorkspaceMap.get(channelId),
      setChannelWorkspaceName: (channelId, workspaceName) => {
        channelWorkspaceMap.set(channelId, workspaceName);
      },
      setChannelWorkspaceAuth: (channelId, auth) => {
        if (!auth?.botToken) return;
        const fullAuth = Array.from(teamAuthMap.values()).find((entry) => entry.botToken === auth.botToken)
          ?? Array.from(enterpriseAuthMap.values()).find((entry) => entry.botToken === auth.botToken);
        if (fullAuth) channelWorkspaceAuthMap.set(channelId, fullAuth);
      },
      isThreadActive,
      markThreadActive,
      isGitHubCommand,
      isChannelSettingsCommand,
      isGeneralSettingsCommand,
      postGitHubLauncher,
      postChannelSettingsLauncher,
      postGeneralSettingsLauncher,
      describeSettingsIssues,
      getChannelAgentProvider,
      handleStopCommand: (channelId, threadId) => coreRuntime.handleStopCommand(channelId, threadId),
      handleIncomingMessage: (context, text) => coreRuntime.handleIncomingMessage(context, text),
    });

  }

}
