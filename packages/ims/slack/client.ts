import { App, type AllMiddlewareArgs } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { existsSync } from "fs";
import { join } from "path";
import {
  getSlackTargetChannels,
  getSlackAppToken,
  getSlackBotTokens,
  getChannelDevServerId,
  getChannelModel,
  getChannelOpenCodeServerUrl,
  getDevServers,
  getDefaultOpenCodeServerUrl,
  isLocalMode,
  resolveChannelCwd,
} from "@ode/config";
import { markdownToSlack, splitForSlack, truncateForSlack } from "./formatter";
import {
  markThreadActive,
  isThreadActive,
  getOpenCodeSession,
  getGitHubAuthRecordForUser,
  getGitHubUserConfigDir,
  getPendingRestartMessages,
  clearPendingRestartMessages,
} from "@ode/config/local/settings";
import {
  loadSession,
  saveSession,
  createActiveRequest,
  updateActiveRequest,
  completeActiveRequest,
  failActiveRequest,
  clearActiveRequest,
  getActiveRequest,
  getSessionsWithPendingRequests,
  isMessageProcessed,
  markMessageProcessed,
  getPendingQuestion,
  setPendingQuestion,
  clearPendingQuestion,
  type ActiveRequest,
  type PendingQuestion,
  type PersistedSession,
  type TrackedTool,
  type TrackedTodo,
} from "@ode/config/local/sessions";
import { storeSessionEvent, storeSessionMeta } from "@ode/config/local/redis";
import {
  getOrCreateSession,
  sendMessage as sendOpenCodeMessage,
  abortSession,
  ensureSession,
  subscribeToSession,
  supportsEventStream,
  type OpenCodeMessage,
  type OpenCodeMessageContext,
  type OpenCodeOptions,
} from "@ode/agents";
import { getSessionClient } from "@ode/agents/opencode";
import {
  buildSessionMessageState,
  type SessionEvent,
  type SessionMessageState,
  log,
  ensureSessionWorktree,
} from "@ode/utils";
import { getSlackActionApiUrl } from "./config";
import { getAllBotTokens, getProfileBySlackUserId, getSlackAppTokenFromServer } from "@ode/config/db";

export interface MessageContext {
  channelId: string;
  threadId: string;
  userId: string;
  messageId: string;
  opencodeServerUrl?: string;
  workspaceName?: string;
}


let app: App | null = null;


type WorkspaceAuth = {
  botToken: string;
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
const channelBotTokenMap = new Map<string, string>();

export function clearSlackAuthState(): void {
  teamAuthMap.clear();
  enterpriseAuthMap.clear();
  channelWorkspaceMap.clear();
  channelBotTokenMap.clear();
}

export function resetSlackState(): void {
  clearSlackAuthState();
  app = null;
}

type SlackClient = AllMiddlewareArgs["client"];

type SlackThreadMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  subtype?: string;
};

// Throttling state
const liveEventHistory = new Map<string, SessionEvent[]>();
const liveParsedState = new Map<string, SessionMessageState>();

// Global rate limiter for chat.update calls across all messages
// Slack's rate limit is roughly 1 request per second for chat.update
let globalLastUpdate = 0;
const GLOBAL_UPDATE_INTERVAL_MS = 1000;
let globalUpdateQueue: Array<{ channelId: string; messageTs: string; text: string; asMarkdown: boolean; resolve: () => void }> = [];
let globalQueueProcessing = false;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function isRedisTrackingEnabled(): boolean {
  if (!isLocalMode()) return false;
  const flag = process.env.ODE_REDIS_ENABLED?.trim().toLowerCase();
  return flag === "true" || flag === "1" || flag === "yes";
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
    },
  };
}

function buildGitEnvironmentForUser(userId: string): Record<string, string> {
  const env: Record<string, string> = {};
  const authRecord = getGitHubAuthRecordForUser(userId);
  if (!authRecord) return env;

  if (authRecord.user) {
    const email = `${authRecord.user}@users.noreply.github.com`;
    env.GIT_AUTHOR_NAME = authRecord.user;
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_NAME = authRecord.user;
    env.GIT_COMMITTER_EMAIL = email;
  }

  env.GH_CONFIG_DIR = getGitHubUserConfigDir(userId);
  return env;
}

async function processGlobalUpdateQueue(): Promise<void> {
  if (globalQueueProcessing || globalUpdateQueue.length === 0) return;
  globalQueueProcessing = true;

  while (globalUpdateQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastUpdate = now - globalLastUpdate;

    if (timeSinceLastUpdate < GLOBAL_UPDATE_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, GLOBAL_UPDATE_INTERVAL_MS - timeSinceLastUpdate));
    }

    const item = globalUpdateQueue.shift();
    if (!item) break;

    globalLastUpdate = Date.now();

    try {
      const slackApp = getApp();
      const formattedText = item.asMarkdown ? markdownToSlack(item.text) : item.text;
      const truncatedText = truncateForSlack(formattedText);

      const botToken = getChannelBotToken(item.channelId);
      if (!botToken) {
        log.warn("No Slack bot token available for message update", { channelId: item.channelId });
      }
      await slackApp.client.chat.update({
        channel: item.channelId,

        ts: item.messageTs,
        text: truncatedText,
        token: botToken,
      });
    } catch (err) {
      log.debug("Failed to update message", { error: String(err) });
    }

    item.resolve();
  }

  globalQueueProcessing = false;
}

export async function createSlackApp(): Promise<App> {
  const appToken = isLocalMode()
    ? getSlackAppToken().trim()
    : (await getSlackAppTokenFromServer()).trim();

  if (!appToken) {
    throw new Error("Slack app token missing");
  }

  app = new App({
    socketMode: true,
    appToken,
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

  return app;
}

export function getApp(): App {
  if (!app) throw new Error("Slack app not initialized");
  return app;
}

function isAuthorizedChannel(channelId: string): boolean {
  if (!isLocalMode()) return true;
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

export function getChannelBotToken(channelId: string): string | undefined {
  return channelBotTokenMap.get(channelId);
}

function registerChannelBotToken(channelId: string, botToken: string | undefined): void {
  if (!botToken) return;
  if (channelBotTokenMap.has(channelId)) return;
  channelBotTokenMap.set(channelId, botToken);
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
  const devServers = getDevServers();
  const devServerId = getChannelDevServerId(channelId);
  const model = getChannelModel(channelId);
  const { workingDirectory } = resolveChannelCwd(channelId);

  if (!devServerId) {
    issues.push("Dev server not configured.");
  }

  const server = devServerId
    ? devServers.find((entry) => entry.id === devServerId)
    : undefined;

  if (devServerId && !server) {
    issues.push("Dev server not found in config.");
  }

  if (!model) {
    issues.push("Model not configured.");
  } else if (server && !server.models.includes(model)) {
    issues.push("Model not available on the selected dev server.");
  }

  if (!workingDirectory) {
    issues.push("Working directory not configured.");
  } else if (!existsSync(workingDirectory)) {
    issues.push(`Working directory not found: ${workingDirectory}`);
  }

  return issues;
}

function isSettingsCommand(text: string): boolean {
  return /^\/setting\b/i.test(text.trim());
}

async function postSettingsLauncher(
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
        text: { type: "mrkdwn", text: "Open channel settings for dev server, model, and working directory." },
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

async function fetchWorkspaceAuth(botToken: string, workspaceName: string): Promise<WorkspaceAuth | null> {
  try {
    const client = new WebClient(botToken);
    const auth = await client.auth.test();
    return {
      botToken,
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
  const localMode = isLocalMode();

  const combined = new Map<string, string | null>();

  if (localMode) {
    for (const record of getSlackBotTokens()) {
      combined.set(record.token, record.workspaceName ?? "config");
    }
  } else {
    const tokens = await getAllBotTokens();
    for (const record of tokens) {
      if (record.botToken) {
        combined.set(record.botToken, record.workspaceName ?? "db");
      }
    }
  }

  if (combined.size === 0) {
    log.warn("No Slack bot tokens configured", { mode: localMode ? "local" : "cloud" });
  }

  for (const [botToken, workspaceName] of combined.entries()) {
    if (!botToken) continue;
    const name = workspaceName ?? "unknown";
    const auth = await fetchWorkspaceAuth(botToken, name);
    if (!auth) continue;
    registerWorkspaceAuth(auth);
    log.info("Registered Slack workspace auth", {
      workspace: name,
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
  const botToken = getChannelBotToken(channelId);

  if (!botToken) {
    log.warn("No Slack bot token available for channel", { channelId });
  }

  log.info("[SLACK] Outgoing message", {
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
    const botToken = getChannelBotToken(channelId);
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

async function updateMessageThrottled(
  channelId: string,
  messageTs: string,
  text: string,
  asMarkdown = true
): Promise<void> {
  // Remove any existing queued updates for this message (only keep latest)
  // Use in-place splice instead of filter to avoid reassigning the array,
  // which would break the while loop in processGlobalUpdateQueue
  // Also resolve removed items' promises so callers don't hang forever
  for (let i = globalUpdateQueue.length - 1; i >= 0; i--) {
    const item = globalUpdateQueue[i];
    if (item && item.channelId === channelId && item.messageTs === messageTs) {
      globalUpdateQueue.splice(i, 1);
      item.resolve(); // Resolve so the awaiting code can continue
    }
  }

  // Queue the update
  return new Promise<void>((resolve) => {
    globalUpdateQueue.push({ channelId, messageTs, text, asMarkdown, resolve });
    void processGlobalUpdateQueue();
  });
}

// Flush any pending updates
async function flushPendingUpdate(
  channelId: string,
  messageTs: string,
  text: string
): Promise<void> {
  await updateMessageThrottled(channelId, messageTs, text);
}

function formatElapsedTime(startedAt: number): string {
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getToolIcon(status: string): string {
  switch (status) {
    case "running":
    case "pending":
      return "~";
    case "error":
      return "!";
    case "completed":
    default:
      return "-";
  }
}

function getTodoIcon(status: string): string {
  switch (status) {
    case "completed": return "\u2705";
    case "in_progress": return "\u25b6\ufe0f";
    default: return "\u2b1c";
  }
}

const PLAN_TODO_LIMIT = 15;

function getStatusMessageKey(request: ActiveRequest): string {
  return `${request.channelId}:${request.threadId}:${request.statusMessageTs}`;
}

function getRepoRoot(workingPath: string): string {
  const markers = ["/.worktree/", "/.worktrees/"];
  for (const marker of markers) {
    const matchIndex = workingPath.indexOf(marker);
    if (matchIndex >= 0) {
      return workingPath.slice(0, matchIndex);
    }
  }
  return workingPath;
}

function trimToolPath(label: string, workingPath: string): string {
  let trimmed = label.trim();
  if (!trimmed) return trimmed;

  const repoRoot = getRepoRoot(workingPath);
  if (repoRoot && trimmed.startsWith(`${repoRoot}/`)) {
    trimmed = trimmed.slice(repoRoot.length + 1);
  }

  if (trimmed.startsWith(`${workingPath}/`)) {
    trimmed = trimmed.slice(workingPath.length + 1);
  }

  trimmed = trimmed.replace(/(^|\/)\.worktrees\/[^/]+\//, "");
  trimmed = trimmed.replace(/(^|\/)\.worktree\/[^/]+\//, "");
  trimmed = trimmed.replace(/^\//, "");
  return trimmed;
}


function formatTodoLines(todos: TrackedTodo[], limit = PLAN_TODO_LIMIT): string[] {
  const lines: string[] = [];
  for (const todo of todos.slice(0, limit)) {
    const icon = getTodoIcon(todo.status);
    lines.push(`${icon} ${todo.content}`);
  }
  if (todos.length > limit) {
    lines.push(`_(+${todos.length - limit} more)_`);
  }
  return lines;
}

function buildToolDetails(tool: SessionMessageState["tools"][number], workingPath: string): string {
  const name = tool.name?.toLowerCase?.() ?? "";
  const input = tool.input || {};
  const title = tool.title?.trim() ?? "";

  if (name === "grep" || name === "ripgrep" || name === "rg") {
    const pattern = input.pattern || "";
    const path = trimToolPath(String(input.path || "."), workingPath);
    return `${pattern} in ${path}`.trim();
  }

  if (name === "glob") {
    const pattern = input.pattern || "";
    const path = trimToolPath(String(input.path || "."), workingPath);
    return `${pattern} in ${path}`.trim();
  }

  if (name === "read") {
    const filePath = input.filePath || input.file_path;
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    let details = filePath ? trimToolPath(String(filePath), workingPath) : "";
    if (details && (offset !== undefined || limit !== undefined)) {
      const offsetLabel = offset !== undefined ? `offset ${offset}` : "";
      const limitLabel = limit !== undefined ? `limit ${limit}` : "";
      const rangeLabel = [offsetLabel, limitLabel].filter(Boolean).join(", ");
      details = `${details} (${rangeLabel})`;
    }
    return details;
  }

  if (name === "edit" || name === "write") {
    const filePath = input.filePath || input.file_path;
    if (filePath) {
      return trimToolPath(String(filePath), workingPath);
    }
  }

  if (name === "bash") {
    return String(input.command || "");
  }

  return title ? trimToolPath(title, workingPath) : "";
}

const TOOL_DETAIL_LIMIT = 100;

function truncateToolDetail(detail: string): string {
  if (detail.length <= TOOL_DETAIL_LIMIT) return detail;
  return `${detail.slice(0, TOOL_DETAIL_LIMIT)}...`;
}

function buildToolLines(state: SessionMessageState, workingPath: string): string[] {
  const tools = state.tools || [];
  if (tools.length === 0) return [];

  const items = tools.length > 5 ? tools.slice(-5) : tools;
  const header = tools.length > 5
    ? `Tool execution (Last 5 items in ${tools.length})`
    : "Tool execution";

  const lines = [header];
  for (const tool of items) {
    const details = buildToolDetails(tool, workingPath);
    const truncated = details ? truncateToolDetail(details) : "";
    const suffix = truncated ? ` — ${truncated}` : "";
    lines.push(`${getToolIcon(tool.status)} ${tool.name}${suffix}`);
  }

  return lines;
}

function buildFinalResponseText(responses: OpenCodeMessage[]): string | null {
  const texts = responses
    .map((response) => response.text?.trim())
    .filter((text): text is string => Boolean(text));
  if (texts.length === 0) return null;
  return texts.join("\n\n");
}

function buildLiveStatusMessage(request: ActiveRequest, workingPath: string): string {
  const state = liveParsedState.get(getStatusMessageKey(request));
  if (!state) {
    if (request.statusFrozen && request.currentText) {
      return request.currentText;
    }
    return `_Working_ (${formatElapsedTime(request.startedAt)})`;
  }

  if (request.statusFrozen && request.currentText) {
    return request.currentText;
  }

  const lines: string[] = [];

  if (state.sessionTitle) {
    const trimmedTitle = state.sessionTitle.length > 40
      ? `${state.sessionTitle.slice(0, 40)}...`
      : state.sessionTitle;
    lines.push(`*${trimmedTitle}* (${formatElapsedTime(state.startedAt)})`);
  } else {
    lines.push(`_${formatElapsedTime(state.startedAt)}_`);
  }

  if (state.todos.length > 0) {
    const todos = state.todos.map((todo) => ({
      content: todo.content,
      status: todo.status as TrackedTodo["status"],
    }));
    lines.push("Tasks", ...formatTodoLines(todos));
  }

  const toolLines = buildToolLines(state, workingPath);
  if (toolLines.length > 0) {
    lines.push(...toolLines);
  }

  return lines.join("\n");
}


function formatThreadAuthor(message: SlackThreadMessage): string {
  if (message.user) return `<@${message.user}>`;
  if (message.bot_id) return `bot:${message.bot_id}`;
  if (message.username) return message.username;
  return "unknown";
}

async function fetchThreadHistory(
  client: SlackClient,
  channelId: string,
  threadId: string,
  messageId: string
): Promise<string | null> {
  try {
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;

    do {
      const response = await client.conversations.replies({
        channel: channelId,
        ts: threadId,
        limit: 200,
        cursor,
      });

      const batch = response.messages as SlackThreadMessage[] | undefined;
      if (batch?.length) {
        messages.push(...batch);
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    const history = messages
      .filter((message) => message.ts && message.ts !== messageId)
      .filter((message) => typeof message.text === "string" && message.text.trim().length > 0)
      .map((message) => `${formatThreadAuthor(message)}: ${message.text}`);

    if (history.length === 0) {
      return null;
    }

    return history.join("\n");
  } catch {
    return null;
  }
}

function categorizeError(
  err: unknown,
  serverUrlOverride?: string
): { message: string; suggestion: string } {
  const errorStr = err instanceof Error ? err.message : String(err);

  if (errorStr.includes("timeout") || errorStr.includes("ETIMEDOUT")) {
    return {
      message: "Request timed out",
      suggestion: "The operation took too long. Try a simpler request or break it into smaller steps.",
    };
  }

  if (errorStr.includes("rate limit") || errorStr.includes("429")) {
    return {
      message: "Rate limited",
      suggestion: "Too many requests. Please wait a moment and try again.",
    };
  }

  if (errorStr.includes("authentication") || errorStr.includes("401") || errorStr.includes("403")) {
    return {
      message: "Authentication error",
      suggestion: "There may be an issue with API credentials. Contact your administrator.",
    };
  }

  if (
    errorStr.includes("ConnectionRefused") ||
    errorStr.includes("ECONNREFUSED") ||
    errorStr.includes("ENOTFOUND") ||
    errorStr.includes("network")
  ) {
    let defaultUrl: string | undefined;
    try {
      defaultUrl = getDefaultOpenCodeServerUrl();
    } catch {
      defaultUrl = undefined;
    }
    const serverUrl = serverUrlOverride || defaultUrl;
    const message = serverUrl
      ? `OpenCode server not accessible on ${serverUrl}`
      : "OpenCode server not accessible";
    return {
      message,
      suggestion: "Check that the OpenCode server is running and reachable.",
    };
  }

  if (errorStr.includes("empty response")) {
    return {
      message: "No response received",
      suggestion: "The model didn't generate a response. Try rephrasing your request.",
    };
  }

  return {
    message: errorStr.length > 100 ? errorStr.slice(0, 100) + "..." : errorStr,
    suggestion: "If this persists, try starting a new thread or contact support.",
  };
}

type NormalizedQuestion = {
  question: string;
  options?: string[];
  multiple?: boolean;
  custom?: boolean;
};

function normalizeQuestions(questions?: QuestionInfo[]): NormalizedQuestion[] {
  if (!questions || questions.length === 0) return [];
  return questions
    .map((question) => {
      const prompt = typeof question.question === "string" ? question.question.trim() : "";
      const options = Array.isArray(question.options)
        ? question.options
          .map((option) => (typeof option?.label === "string" ? option.label : ""))
          .filter((label) => label.length > 0)
        : undefined;
      return {
        question: prompt,
        options: options && options.length > 0 ? options : undefined,
        multiple: question.multiple,
        custom: question.custom,
      };
    })
    .filter((question) => question.question.length > 0);
}

function formatQuestionPrompt(questions: NormalizedQuestion[]): string {
  const lines = questions.map((question, index) => {
    const prefix = questions.length > 1 ? `${index + 1}. ` : "";
    const optionText = question.options?.length
      ? `\nOptions: ${question.options.join(" / ")}`
      : "";
    return `${prefix}${question.question}${optionText}`;
  });

  return lines.join("\n\n");
}

function buildQuestionAnswers(
  questions: NormalizedQuestion[],
  responseText: string
): Array<Array<string>> {
  const trimmed = responseText.trim();
  if (questions.length <= 1) {
    return [[trimmed]];
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return questions.map((_, index) => {
    const line = lines[index] ?? "";
    return [line];
  });
}

async function handlePendingQuestionReply(
  pendingQuestion: PendingQuestion,
  channelId: string,
  threadId: string,
  userId: string,
  text: string,
  messageId: string
): Promise<boolean> {
  if (isMessageProcessed(messageId)) {
    log.debug("Skipping duplicate question reply", { messageId });
    return true;
  }

  const session = loadSession(channelId, threadId);
  const threadOwnerUserId = session?.threadOwnerUserId;
  if (threadOwnerUserId && threadOwnerUserId !== userId) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    await sendMessage(channelId, threadId, "Please reply with an answer.", false);
    return true;
  }

  markMessageProcessed(messageId);

  try {
    const client = await getSessionClient(pendingQuestion.sessionId);
    const answers = buildQuestionAnswers(pendingQuestion.questions, trimmed);
    const response = await client.question.reply({
      requestID: pendingQuestion.requestId,
      directory: session?.workingDirectory,
      answers,
    });

    if (response.error) {
      throw new Error(`OpenCode question reply error: ${response.error}`);
    }

    clearPendingQuestion(channelId, threadId);
    return true;
  } catch (err) {
    log.error("Failed to answer OpenCode question", { error: String(err) });
    await sendMessage(channelId, threadId, "Failed to submit your answer. Please try again.", false);
    return true;
  }
}

async function startEventStreamWatcher(
  request: ActiveRequest,
  workingPath: string,
  onUpdate: () => void,
  onStop?: () => void
): Promise<() => void> {
  if (!supportsEventStream) {
    return () => { };
  }

  const shouldStoreEvents = isRedisTrackingEnabled();

  // Ensure the session instance exists before subscribing
  await ensureSession(request.sessionId);

  const messageKey = getStatusMessageKey(request);
  const eventHistory = liveEventHistory.get(messageKey) ?? [];
  if (!liveEventHistory.has(messageKey)) {
    liveEventHistory.set(messageKey, eventHistory);
  }

  function applyStateFromEvents(): void {
    const state = buildSessionMessageState(eventHistory, {
      workingDirectory: workingPath,
      baseState: { startedAt: request.startedAt },
    });
    liveParsedState.set(messageKey, state);
    request.currentText = state.currentText;
    request.tools = state.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status as TrackedTool["status"],
      title: tool.title,
      output: tool.output,
      error: tool.error,
    }));
    request.todos = state.todos.map((todo) => ({
      content: todo.content,
      status: todo.status as TrackedTodo["status"],
    }));
  }

  let stopNotified = false;

  // Subscribe to events for this session via the shared dispatcher
  const unsubscribe = subscribeToSession(request.sessionId, (globalEvent: unknown) => {
    const event = (globalEvent as any).payload ?? globalEvent;
    log.info("[OPENCODE] Event", {
      sessionId: request.sessionId,
      type: (event as any)?.type ?? "unknown",
      properties: (event as any)?.properties,
      directory: (globalEvent as any)?.directory,
    });

    if (!stopNotified && event?.type === "message.part.updated") {
      const part = (event as any)?.properties?.part;
      if (part?.type === "step-finish" && part?.reason === "stop") {
        stopNotified = true;
        onStop?.();
      }
    }

    const sessionEvent: SessionEvent = {
      timestamp: Date.now(),
      type: event.type || "unknown",
      data: event as Record<string, unknown>,
    };
    eventHistory.push(sessionEvent);

    if (shouldStoreEvents) {
      void storeSessionEvent({
        timestamp: Date.now(),
        type: event.type || "unknown",
        sessionId: request.sessionId,
        channelId: request.channelId,
        threadId: request.threadId,
        data: event as Record<string, unknown>,
      });
    }
    const pendingQuestion = getPendingQuestion(request.channelId, request.threadId);

    if (pendingQuestion) {
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = event.properties?.requestID;
        if (!requestId || requestId !== pendingQuestion.requestId) {
          return;
        }
        clearPendingQuestion(request.channelId, request.threadId);
        onUpdate();
        return;
      }
      if (event.type !== "question.asked") {
        return;
      }
    }

    applyStateFromEvents();

    if (event.type === "question.asked") {
      const properties = event.properties as {
        id?: string;
        sessionID?: string;
        questions?: QuestionInfo[];
      };
      const requestId = properties?.id;
      if (!requestId) return;

      const existingQuestion = getPendingQuestion(request.channelId, request.threadId);
      if (existingQuestion?.requestId === requestId) return;

      const normalized = normalizeQuestions(properties.questions);
      if (normalized.length === 0) return;

      request.statusFrozen = true;
      const prompt = formatQuestionPrompt(normalized);
      request.currentText = prompt;
      onUpdate();

      void (async () => {
        await updateMessageThrottled(
          request.channelId,
          request.statusMessageTs,
          buildLiveStatusMessage(request, workingPath),
          false
        );
        setPendingQuestion(request.channelId, request.threadId, {
          requestId,
          sessionId: properties.sessionID ?? request.sessionId,
          askedAt: Date.now(),
          questions: normalized,
          messageTs: request.statusMessageTs,
        });
      })();
      return;
    }

    onUpdate();
  });

  return unsubscribe;
}

async function runOpenCodeRequest(
  session: PersistedSession,
  channelId: string,
  threadId: string,
  sessionId: string,
  cwd: string,
  message: string,
  phaseLabel: string,
  context: OpenCodeMessageContext,
  options?: OpenCodeOptions,
  serverUrlOverride?: string
): Promise<OpenCodeMessage[] | null> {
  const statusTs = await sendMessage(
    channelId,
    threadId,
    `_${phaseLabel}..._`,
    false
  );

  if (!statusTs) {
    log.error("Failed to send status message");
    return null;
  }

  const request = createActiveRequest(sessionId, channelId, threadId, statusTs, message);
  session.activeRequest = request;
  saveSession(session);

  if (isRedisTrackingEnabled()) {
    void storeSessionMeta({
      sessionId: session.sessionId,
      channelId: session.channelId,
      threadId: session.threadId,
      workingDirectory: session.workingDirectory,
      createdAt: session.createdAt,
      lastActivityAt: Date.now(),
      threadOwnerUserId: session.threadOwnerUserId,
    });
  }

  let lastHeartbeat = Date.now();
  const progressTimer = setInterval(async () => {
    if (request.state !== "processing") return;

    const now = Date.now();
    if (now - lastHeartbeat > 5000) {
      lastHeartbeat = now;
      request.lastUpdatedAt = now;
    }

    const statusText = buildLiveStatusMessage(request, cwd);
    if (!request.statusFrozen) {
      await updateMessageThrottled(channelId, statusTs, statusText, false);
    }
    updateActiveRequest(channelId, threadId, {
      currentText: request.currentText,
      tools: request.tools,
      todos: request.todos,
      statusFrozen: request.statusFrozen,
    });
  }, 2000);

  const stopSignal = createDeferred<void>();
  const stopWatcher = await startEventStreamWatcher(request, cwd, () => { }, () => {
    stopSignal.resolve();
  });

  try {
    const promptPromise = sendOpenCodeMessage(
      channelId,
      sessionId,
      message,
      cwd,
      options,
      context
    );
    const result = await Promise.race([
      promptPromise.then((responses) => ({ type: "prompt" as const, responses })),
      stopSignal.promise.then(() => ({ type: "stop" as const })),
    ]);

    clearInterval(progressTimer);
    stopWatcher();
    request.state = "completed";

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));
    completeActiveRequest(channelId, threadId);

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const finalText = fallbackText || "_Done_";
      await updateMessageThrottled(channelId, statusTs, finalText, true);
      void promptPromise.catch((err) => {
        log.debug("OpenCode prompt rejected after stop", { error: String(err) });
      });
      return fallbackText
        ? [{ text: fallbackText, messageType: "assistant" }]
        : [];
    }

    if (result.responses.length === 0) {
      log.warn("No text responses from model - tool-only response");
    }

    const finalText = buildFinalResponseText(result.responses) ?? "_Done_";
    await updateMessageThrottled(channelId, statusTs, finalText, true);

    return result.responses;
  } catch (err) {
    clearInterval(progressTimer);
    stopWatcher();

    const { message: errorMessage, suggestion } = categorizeError(err, serverUrlOverride);
    log.error("Request failed", { channelId, threadId, error: String(err) });

    request.state = "failed";
    request.error = errorMessage;

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    const errorStatus = `Error: ${errorMessage}\n_${suggestion}_`;
    await flushPendingUpdate(channelId, statusTs, errorStatus);
    await updateMessageThrottled(channelId, statusTs, errorStatus, false);
    failActiveRequest(channelId, threadId, errorMessage);
    return null;
  }
}

type QueuedMessage = {
  context: MessageContext;
  text: string;
  client: SlackClient;
};

type ThreadQueue = {
  processing: boolean;
  items: QueuedMessage[];
};

const threadQueues = new Map<string, ThreadQueue>();

function getThreadQueueKey(channelId: string, threadId: string): string {
  return `${channelId}-${threadId}`;
}

async function processThreadQueue(queueKey: string): Promise<void> {
  const queue = threadQueues.get(queueKey);
  if (!queue || queue.processing) return;

  queue.processing = true;
  while (queue.items.length > 0) {
    const batch = queue.items.splice(0);
    const next = batch[0];
    if (!next) continue;
    const combinedText = batch.map((item) => item.text).join("\n");
    try {
      await handleUserMessageInternal(next.context, combinedText, next.client);
    } catch (err) {
      log.error("Queued message processing failed", { error: String(err) });
    }
  }
  queue.processing = false;

  if (queue.items.length === 0) {
    threadQueues.delete(queueKey);
    return;
  }

  void processThreadQueue(queueKey);
}

function enqueueUserMessage(context: MessageContext, text: string, client: SlackClient): void {
  const queueKey = getThreadQueueKey(context.channelId, context.threadId);
  const queue = threadQueues.get(queueKey) ?? { processing: false, items: [] };
  queue.items.push({ context, text, client });
  threadQueues.set(queueKey, queue);

  if (!queue.processing) {
    void processThreadQueue(queueKey);
  }
}

async function handleUserMessageInternal(
  context: MessageContext,
  text: string,
  client: SlackClient
): Promise<void> {
  const { channelId, threadId, messageId } = context;
  let cwd: string;
  try {
    cwd = resolveChannelCwd(channelId).cwd;
  } catch (err) {
    await sendMessage(channelId, threadId, `Error: ${String(err)}`, false);
    return;
  }

  let session = loadSession(channelId, threadId);
  const threadOwnerUserId = session?.threadOwnerUserId ?? context.userId;
  const gitEnv = buildGitEnvironmentForUser(threadOwnerUserId);
  const sessionEnv = context.opencodeServerUrl
    ? { ...gitEnv, OPENCODE_SERVER_URL: context.opencodeServerUrl }
    : gitEnv;

  let sessionId: string;
  let created: boolean;

  try {
    ({ sessionId, created } = await getOrCreateSession(channelId, threadId, cwd, sessionEnv));
  } catch (err) {
    const { message, suggestion } = categorizeError(err, context.opencodeServerUrl);
    log.error("Failed to create OpenCode session", {
      channelId,
      threadId,
      error: String(err),
      opencodeServerUrl: context.opencodeServerUrl,
    });
    await sendMessage(channelId, threadId, `Error: ${message}\n_${suggestion}_`, false);
    return;
  }

  try {
    const worktreeId = `ode_${threadId}`;
    const worktree = await ensureSessionWorktree({ cwd, worktreeId, env: sessionEnv });
    if (worktree.skipped && worktree.message) {
      await sendMessage(channelId, threadId, worktree.message, false);
    }
    if (!worktree.skipped && worktree.worktreePath !== cwd) {
      cwd = worktree.worktreePath;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to prepare worktree", {
      channelId,
      threadId,
      sessionId,
      error: message,
    });
    await sendMessage(channelId, threadId, `Error: Failed to prepare worktree. ${message}`, false);
    return;
  }

  if (!session) {
    session = {
      sessionId,
      channelId,
      threadId,
      workingDirectory: cwd,
      threadOwnerUserId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  } else if (session.sessionId !== sessionId) {
    session.sessionId = sessionId;
  }

  if (session.workingDirectory !== cwd) {
    session.workingDirectory = cwd;
  }

  if (!session.threadOwnerUserId) {
    session.threadOwnerUserId = threadOwnerUserId;
  }
  saveSession(session);

  const threadHistory = created
    ? await fetchThreadHistory(client, channelId, threadId, messageId)
    : null;

  const messageContext = await buildSlackContext(
    cwd,
    channelId,
    threadId,
    threadOwnerUserId,
    threadHistory
  );

  const trimmed = text.trim();
  const agent = /^plan\b/i.test(trimmed) ? "plan" : undefined;

  const responses = await runOpenCodeRequest(
    session,
    channelId,
    threadId,
    sessionId,
    cwd,
    text,
    "Working",
    messageContext,
    agent ? { agent } : undefined,
    context.opencodeServerUrl
  );

  if (!responses) return;
}

async function handleUserMessage(
  context: MessageContext,
  text: string,
  client: SlackClient
): Promise<void> {
  const { messageId } = context;

  if (isMessageProcessed(messageId)) {
    log.debug("Skipping duplicate message", { messageId });
    return;
  }
  markMessageProcessed(messageId);

  enqueueUserMessage(context, text, client);
}

// Recovery: Check for interrupted requests on startup
export async function recoverPendingRequests(): Promise<void> {
  const pendingSessions = getSessionsWithPendingRequests();

  if (pendingSessions.length === 0) {
    log.info("No pending requests to recover");
  } else {
    log.info("Found pending requests to recover", { count: pendingSessions.length });

    for (const session of pendingSessions) {
      const request = session.activeRequest;
      if (!request) continue;

      // Check if request is stale (older than 10 minutes)
      const age = Date.now() - request.startedAt;
      if (age > 10 * 60 * 1000) {
        log.info("Clearing stale request", {
          channelId: session.channelId,
          threadId: session.threadId,
          age: Math.floor(age / 1000) + "s",
        });
        clearActiveRequest(session.channelId, session.threadId);
        continue;
      }

      // Update status message via global rate-limited queue
      await updateMessageThrottled(
        request.channelId,
        request.statusMessageTs,
        "_Bot restarted - please resend your message_",
        false
      );

      clearActiveRequest(session.channelId, session.threadId);
    }
  }

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

// Handle stop command
async function handleStopCommand(
  channelId: string,
  threadId: string,
  client: SlackClient
): Promise<boolean> {
  const session = loadSession(channelId, threadId);
  if (!session?.activeRequest || session.activeRequest.state !== "processing") {
    return false;
  }

  const request = session.activeRequest;
  log.info("Stop command received", { sessionId: request.sessionId });

  try {
    const cwd = session.workingDirectory;
    await abortSession(request.sessionId, cwd);
  } catch {
    // Ignore abort errors
  }

  // Update status
  request.state = "failed";
  request.error = "Stopped by user";

  // Delete the status message
  await deleteMessage(channelId, request.statusMessageTs);

  failActiveRequest(channelId, threadId, "Stopped by user");
  return true;
}

// Handle button selection - sends the user's choice to the OpenCode session
export async function handleButtonSelection(
  channelId: string,
  threadId: string,
  userId: string,
  selection: string,
  messageTs: string,
  client: SlackClient
): Promise<void> {
  let cwd: string;
  try {
    cwd = resolveChannelCwd(channelId).cwd;
  } catch (err) {
    await sendMessage(channelId, threadId, `Error: ${String(err)}`, false);
    return;
  }

  // Get existing session
  const sessionId = getOpenCodeSession(channelId, threadId);
  if (!sessionId) {
    log.warn("No session found for button selection", { channelId, threadId });
    return;
  }

  // Check for duplicate processing
  if (isMessageProcessed(messageTs)) {
    log.debug("Skipping duplicate button selection", { messageTs });
    return;
  }
  markMessageProcessed(messageTs);

  // Create status message
  const statusTs = await sendMessage(channelId, threadId, "_Processing..._", false);
  if (!statusTs) {
    log.error("Failed to send status message for button selection");
    return;
  }

  // Create active request
  const request = createActiveRequest(sessionId, channelId, threadId, statusTs, selection);

  // Persist session state
  const session = loadSession(channelId, threadId);
  if (session) {
    session.activeRequest = request;
    if (!session.threadOwnerUserId) {
      session.threadOwnerUserId = userId;
    }
    saveSession(session);
  }

  const threadOwnerUserId = session?.threadOwnerUserId ?? userId;

  const agent = /^plan\b/i.test(selection.trim()) ? "plan" : undefined;

  // Progress timer
  const progressTimer = setInterval(async () => {
    if (request.state !== "processing") return;
    const statusText = buildLiveStatusMessage(request, cwd);
    await updateMessageThrottled(channelId, statusTs, statusText, false);
  }, 2000); // 2 seconds to reduce Slack API load

  // Event watcher
  const stopSignal = createDeferred<void>();
  const stopWatcher = await startEventStreamWatcher(request, cwd, () => { }, () => {
    stopSignal.resolve();
  });

  try {
    // Build context - the selection is the user's response
    const messageContext = await buildSlackContext(
      cwd,
      channelId,
      threadId,
      threadOwnerUserId
    );

    // Send to OpenCode - the selection as the user's message
    const promptPromise = sendOpenCodeMessage(
      channelId,
      sessionId,
      `User selected: ${selection}`,
      cwd,
      agent ? { agent } : undefined,
      messageContext
    );
    const result = await Promise.race([
      promptPromise.then((responses) => ({ type: "prompt" as const, responses })),
      stopSignal.promise.then(() => ({ type: "stop" as const })),
    ]);

    clearInterval(progressTimer);
    stopWatcher();
    request.state = "completed";

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const finalText = fallbackText || "_Done_";
      await updateMessageThrottled(channelId, statusTs, finalText, true);
      completeActiveRequest(channelId, threadId);
      void promptPromise.catch((err) => {
        log.debug("OpenCode prompt rejected after stop", { error: String(err) });
      });
      return;
    }

    const finalText = buildFinalResponseText(result.responses) ?? "_Done_";
    await updateMessageThrottled(channelId, statusTs, finalText, true);

    completeActiveRequest(channelId, threadId);

  } catch (err) {
    clearInterval(progressTimer);
    stopWatcher();

    const { message, suggestion } = categorizeError(err);
    log.error("Button selection handling failed", { error: String(err) });

    request.state = "failed";
    request.error = message;

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    const errorStatus = `Error: ${message}\n_${suggestion}_`;
    await updateMessageThrottled(channelId, statusTs, errorStatus, false);
    failActiveRequest(channelId, threadId, message);
  }
}

export function setupMessageHandlers(): void {
  const slackApp = getApp();

  // Handle messages
  slackApp.message(async ({ message, say, client }) => {
    // Ignore all message subtypes (edits, deletes, etc) - only process new messages
    if (message.subtype !== undefined) return;
    if (!("text" in message) || !message.text) return;
    if (!("user" in message)) return;

    const channelId = message.channel;
    const userId = message.user;
    const text = message.text;
    const threadId = message.thread_ts || message.ts;

    if (!isAuthorizedChannel(channelId)) {
      log.info("[DROP] Unauthorized channel", { channelId });
      return;
    }
    registerChannelBotToken(channelId, client.token);

    // Get bot user ID for this workspace
    const authResult = await client.auth.test();
    const currentBotUserId = authResult.user_id as string;
    if (authResult.team_id) {
      const auth = resolveWorkspaceAuth(authResult.team_id, authResult.enterprise_id ?? undefined);
      if (auth?.workspaceName && !channelWorkspaceMap.has(channelId)) {
        channelWorkspaceMap.set(channelId, auth.workspaceName);
      }
      registerChannelBotToken(channelId, auth?.botToken);
    }

    if (userId === currentBotUserId) {
      log.debug("[DROP] Message from bot user", { channelId, userId });
      return;
    }

    // Check for stop command
    if (/\bstop\b/i.test(text)) {
      const stopped = await handleStopCommand(channelId, threadId, client);
      if (stopped) {
        await say({
          text: "Request stopped.",
          thread_ts: threadId,
        });
        return;
      }
    }

    const pendingQuestion = getPendingQuestion(channelId, threadId);
    if (pendingQuestion && message.ts) {
      const handled = await handlePendingQuestionReply(
        pendingQuestion,
        channelId,
        threadId,
        userId,
        text,
        message.ts
      );
      if (handled) {
        return;
      }
    }

    // Check if bot is mentioned or thread is active
    const isMention = currentBotUserId ? text.includes(`<@${currentBotUserId}>`) : false;
    const threadActive = isThreadActive(channelId, threadId);

    if (!isMention && !threadActive) {
      log.info("[DROP] Not mentioned and thread inactive", { channelId, threadId });
      return;
    }

    // If message mentions someone else (but not us), ignore it - it's not for us
    const mentionsOthers = /<@U[A-Z0-9]+>/g.test(text) && !isMention;
    if (mentionsOthers) {
      log.info("[DROP] Mentions other user", { channelId, threadId });
      return;
    }

    markThreadActive(channelId, threadId);

    const cleanText = currentBotUserId
      ? text.replace(new RegExp(`<@${currentBotUserId}>`, "g"), "").trim()
      : text.trim();

    if (isSettingsCommand(cleanText)) {
      if (isMention) {
        await postSettingsLauncher(channelId, userId, client);
      }
      return;
    }

    const settingsIssues = describeSettingsIssues(channelId);
    if (settingsIssues.length > 0) {
      await say({
        text: `Channel settings need attention:\n- ${settingsIssues.join("\n- ")}`,
        thread_ts: threadId,
      });
      await postSettingsLauncher(channelId, userId, client);
      return;
    }

    const workspaceName = channelWorkspaceMap.get(channelId) || "unknown";

    const localMode = isLocalMode();
    const channelServerUrl = getChannelOpenCodeServerUrl(channelId);
    let profile = null;
    if (!localMode) {
      try {
        profile = await getProfileBySlackUserId(userId);
      } catch (err) {
        log.error("Supabase profile lookup failed", { error: String(err) });
        await say({
          text: "Failed to load your OpenCode server settings. Please contact your administrator.",
          thread_ts: threadId,
        });
        return;
      }
    }
    if (localMode && !channelServerUrl) {
      await say({
        text: "OpenCode server URL missing for this channel. Set it in ~/.config/ode/ode.json.",
        thread_ts: threadId,
      });
      return;
    }

    if (!localMode && !profile?.opencode_server_url) {
      await say({
        text: "OpenCode server URL missing for your account. Please contact your administrator.",
        thread_ts: threadId,
      });
      return;
    }

    if (!cleanText) {
      await say({
        text: "Hi! How can I help you? Just ask me anything.",
        thread_ts: threadId,
      });
      return;
    }

    const context: MessageContext = {
      channelId,
      threadId,
      userId,
      messageId: message.ts,
      opencodeServerUrl: localMode ? channelServerUrl : profile?.opencode_server_url || undefined,
      workspaceName,
    };

    await handleUserMessage(context, cleanText, client);
  });

}
