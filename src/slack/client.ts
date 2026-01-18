import { App, type AllMiddlewareArgs } from "@slack/bolt";
import { loadEnv, getTargetChannels } from "../config";
import { markdownToSlack, splitForSlack } from "./formatter";
import {
  markThreadActive,
  isThreadActive,
  getChannelCwd,
  getChannelSettings,
  getOpenCodeSession,
  setOpenCodeSession,
  getGitHubAuthRecordForUser,
  getGitHubUserConfigDir,
  getPendingRestartMessages,
  clearPendingRestartMessages,
} from "../storage/settings";
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
  type ActiveRequest,
  type PersistedSession,
  type TrackedTool,
  type TrackedTodo,
} from "../storage/sessions";
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
} from "../agents";
import { statusFromEvent, type ProgressEvent } from "../agents/opencode";
import { log } from "../logger";

export interface MessageContext {
  channelId: string;
  threadId: string;
  userId: string;
  messageId: string;
}

let app: App | null = null;
let botUserId: string | null = null;

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
const lastUpdateTime = new Map<string, number>();
const pendingUpdates = new Map<string, boolean>();
const UPDATE_THROTTLE_MS = 500;

// Global rate limiter for chat.update calls across all messages
// Slack's rate limit is roughly 1 request per second for chat.update
let globalLastUpdate = 0;
const GLOBAL_UPDATE_INTERVAL_MS = 1000;
let globalUpdateQueue: Array<{ channelId: string; messageTs: string; text: string; asMarkdown: boolean; resolve: () => void }> = [];
let globalQueueProcessing = false;

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
      const truncatedText = formattedText.length > 3900
        ? formattedText.slice(0, 3900) + "\n\n_(truncated)_"
        : formattedText;

      await slackApp.client.chat.update({
        channel: item.channelId,
        ts: item.messageTs,
        text: truncatedText,
      });
    } catch (err) {
      log.debug("Failed to update message", { error: String(err) });
    }

    item.resolve();
  }

  globalQueueProcessing = false;
}

export function createSlackApp(): App {
  const env = loadEnv();

  app = new App({
    token: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: env.SLACK_APP_TOKEN,
  });

  return app;
}

export function getApp(): App {
  if (!app) throw new Error("Slack app not initialized");
  return app;
}

function isAuthorizedChannel(channelId: string): boolean {
  const targetChannels = getTargetChannels();
  if (!targetChannels) return true;
  return targetChannels.includes(channelId);
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

  log.info("[SEND] Slack message", {
    channel: channelId,
    thread: threadId,
    text: text.slice(0, 100) + (text.length > 100 ? "..." : ""),
    chunks: chunks.length,
  });

  let lastTs: string | undefined;
  for (const chunk of chunks) {
    const result = await slackApp.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: chunk,
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
    await slackApp.client.chat.delete({
      channel: channelId,
      ts: messageTs,
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
  const key = `${channelId}:${messageTs}`;
  const now = Date.now();
  const lastUpdate = lastUpdateTime.get(key) || 0;

  if (now - lastUpdate < UPDATE_THROTTLE_MS) {
    pendingUpdates.set(key, true);
    return;
  }

  lastUpdateTime.set(key, now);
  pendingUpdates.delete(key);

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
  const key = `${channelId}:${messageTs}`;
  if (pendingUpdates.has(key)) {
    lastUpdateTime.delete(key);
    await updateMessageThrottled(channelId, messageTs, text);
  }
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
    case "completed": return "\u2705"; // green check
    case "running": return "\u25b6\ufe0f"; // play button
    case "error": return "\u274c"; // red x
    default: return "\u2b1c"; // white square
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
const SEARCH_TOOL_NAMES = new Set(["glob", "grep", "rg", "ripgrep", "search"]);
const EDIT_TOOL_NAMES = new Set(["edit", "write"]);
const READ_TOOL_NAMES = new Set(["read"]);
const IGNORED_EDIT_REASONS = new Set([
  "working",
  "thinking",
  "connecting",
  "reasoning",
  "writing response",
  "planning",
  "building",
  "running",
]);

function getRepoRoot(workingPath: string): string {
  const marker = "/.worktrees/";
  const matchIndex = workingPath.indexOf(marker);
  if (matchIndex >= 0) {
    return workingPath.slice(0, matchIndex);
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
  trimmed = trimmed.replace(/^\//, "");
  return trimmed;
}

function formatToolLabel(tool: TrackedTool, workingPath: string): string | null {
  const title = tool.title?.trim() ?? "";
  const name = tool.name?.trim() ?? "";
  if (!title && !name) return null;

  const normalizedTitle = title ? trimToolPath(title, workingPath) : "";
  const toolName = name.toLowerCase();

  if (READ_TOOL_NAMES.has(toolName)) return null;

  if (SEARCH_TOOL_NAMES.has(toolName)) {
    return "Searching files";
  }

  if (EDIT_TOOL_NAMES.has(toolName)) {
    if (!normalizedTitle) return "Editing files";
    return `Editing ${normalizedTitle}`;
  }

  return normalizedTitle || name;
}

function parseSearchOutputCount(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return 0;
  if (/no (files|matches|results) found/i.test(trimmed)) return 0;
  if (trimmed === "[]") return 0;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      // Ignore parse failures
    }
  }

  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  return lines.length;
}

function buildSearchSummary(tools: TrackedTool[]): { status: TrackedTool["status"]; label: string } | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (!tool) continue;
    const toolName = tool.name?.toLowerCase() ?? "";
    if (!SEARCH_TOOL_NAMES.has(toolName)) continue;

    if (tool.status === "error") {
      return { status: tool.status, label: "Search failed" };
    }

    const count = tool.output ? parseSearchOutputCount(tool.output) : null;
    const suffix = count === null
      ? ""
      : count === 0
        ? " (no results)"
        : ` (${count} results)`;

    return { status: tool.status, label: `Searching files${suffix}` };
  }

  return null;
}

function getEditReason(request: ActiveRequest): string | null {
  const rawReason = request.currentStep || request.currentStatus || "";
  const cleaned = rawReason.replace(/^Running:\s*/i, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase();
  if (IGNORED_EDIT_REASONS.has(normalized) || normalized.startsWith("retrying")) {
    return null;
  }
  return cleaned;
}

function buildEditLines(
  tools: TrackedTool[],
  workingPath: string,
  reason: string | null
): Array<{ tool: TrackedTool; label: string }> {
  const latestByFile = new Map<string, { tool: TrackedTool; title: string; index: number }>();
  let latestEditIndex = -1;

  tools.forEach((tool, index) => {
    const toolName = tool.name?.toLowerCase() ?? "";
    if (!EDIT_TOOL_NAMES.has(toolName)) return;

    const title = tool.title?.trim() ?? "";
    const normalizedTitle = title ? trimToolPath(title, workingPath) : "";
    if (!normalizedTitle) return;

    latestEditIndex = index;
    latestByFile.set(normalizedTitle, { tool, title: normalizedTitle, index });
  });

  return Array.from(latestByFile.values())
    .sort((a, b) => a.index - b.index)
    .map(({ tool, title, index }) => {
      const label = reason && index === latestEditIndex
        ? `Edited ${title} — ${reason}`
        : `Edited ${title}`;
      return { tool, label };
    });
}

function buildChecklistLines(request: ActiveRequest, workingPath: string): string[] {
  const lines: string[] = [];
  const searchSummary = buildSearchSummary(request.tools);
  if (searchSummary) {
    lines.push(`${getToolIcon(searchSummary.status)} ${searchSummary.label}`);
  }

  const reason = getEditReason(request);
  const edits = buildEditLines(request.tools, workingPath, reason);
  for (const { tool, label } of edits) {
    lines.push(`${getToolIcon(tool.status)} ${label}`);
  }

  return lines;
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

function buildPlanMessage(todos: TrackedTodo[]): string {
  if (todos.length === 0) return "Plan\n_(No tasks yet)_";
  return ["Plan", ...formatTodoLines(todos)].join("\n");
}

function buildTodoPrompt(todos: TrackedTodo[]): string {
  if (todos.length === 0) return "";
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.content}`);
  return ["Todos:", ...lines].join("\n");
}

export function buildRichStatusMessage(request: ActiveRequest, workingPath: string): string {
  const lines: string[] = [];

  // Simple status with elapsed time
  const statusText = request.currentStep || request.currentStatus || "Working";
  lines.push(`_${statusText}_ (${formatElapsedTime(request.startedAt)})`);

  const checklistLines = buildChecklistLines(request, workingPath);
  if (checklistLines.length > 0) {
    lines.push(...checklistLines);
  }

  return lines.join("\n");
}

async function upsertPlanMessage(
  session: PersistedSession,
  channelId: string,
  threadId: string,
  todos: TrackedTodo[]
): Promise<void> {
  if (todos.length === 0) return;
  if (!session.plan) {
    session.plan = { status: "planning", todos };
  }
  session.plan.todos = todos;

  const planText = buildPlanMessage(todos);
  if (session.plan.messageTs) {
    await updateMessageThrottled(channelId, session.plan.messageTs, planText, false);
  } else {
    const messageTs = await sendMessage(channelId, threadId, planText, false);
    if (messageTs) {
      session.plan.messageTs = messageTs;
    }
  }
  saveSession(session);
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

function categorizeError(err: unknown): { message: string; suggestion: string } {
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

  if (errorStr.includes("network") || errorStr.includes("ECONNREFUSED") || errorStr.includes("ENOTFOUND")) {
    return {
      message: "Network error",
      suggestion: "Unable to connect to the service. Check your network connection.",
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

async function startEventStreamWatcher(
  request: ActiveRequest,
  workingPath: string,
  onUpdate: () => void,
  onTodoUpdate?: (todos: TrackedTodo[]) => Promise<void>
): Promise<() => void> {
  if (!supportsEventStream) {
    return () => { };
  }

  // Ensure the session instance exists before subscribing
  await ensureSession(request.sessionId);

  // Subscribe to events for this session via the shared dispatcher
  const unsubscribe = subscribeToSession(request.sessionId, (globalEvent: unknown) => {
    const event = (globalEvent as any).payload ?? globalEvent;

    if (event.type === "message.part.updated") {
      const part = event.properties?.part;
      if (!part) return;

      if (part.type === "tool") {
        const state = part.state || {};
        const existingIdx = request.tools.findIndex(t => t.id === part.id);
        const toolInfo: TrackedTool = {
          id: part.id,
          name: part.tool || "Unknown tool",
          status: state.status || "pending",
          title: state.title,
          output: state.output,
          error: state.error,
        };

        if (existingIdx >= 0) {
          request.tools[existingIdx] = toolInfo;
        } else {
          request.tools.push(toolInfo);
        }

        const status = statusFromEvent({
          directory: (globalEvent as any).directory,
          payload: event,
        } as ProgressEvent, request.sessionId);

        if (status) {
          request.currentStatus = status;
          request.currentStep = 'Tool Calling...'
        }
      } else if (part.type === "text" && part.text) {
        request.currentText = part.text;
        request.currentStatus = "Writing response";
      } else if (part.type === "step-start") {
        request.currentStep = part.metadata?.title || "Thinking";
      } else if (part.type === "step-finish") {
        request.currentStep = undefined;
      } else if (part.type === "reasoning") {
        request.currentStep = "Thinking deeply...";
      }

      onUpdate();
    } else if (event.type === "todo.updated") {
      const todos = event.properties?.todos || [];
      request.todos = todos.map((t: any) => ({
        content: t.content || t.text || "",
        status: t.status || "pending",
      }));
      void onTodoUpdate?.(request.todos);
      onUpdate();
    } else if (event.type === "session.status") {
      const status = event.properties?.status;
      if (status?.type === "busy") {
        request.currentStatus = "Working";
      } else if (status?.type === "retry") {
        const seconds = status.next
          ? Math.max(0, Math.ceil((status.next - Date.now()) / 1000))
          : undefined;
        request.currentStatus = seconds !== undefined
          ? `Retrying in ${seconds}s`
          : "Retrying...";
      }
      onUpdate();
    }
  });

  return unsubscribe;
}

function responsesContainQuestion(responses: OpenCodeMessage[]): boolean {
  return responses.some((response) => response.text?.includes("?"));
}

function buildBuildPrompt(
  userMessage: string,
  planText: string | undefined,
  todos: TrackedTodo[],
  hasPlan: boolean
): string {
  if (!hasPlan) {
    return userMessage;
  }

  const sections = [
    "Implement the plan below.",
    `User request: ${userMessage}`,
    planText ? `Plan notes:\n${planText}` : "",
    buildTodoPrompt(todos),
  ].filter((section) => section.length > 0);

  return sections.join("\n\n");
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
  onTodosUpdated?: (todos: TrackedTodo[]) => Promise<void>
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
  request.currentStatus = phaseLabel;
  session.activeRequest = request;
  saveSession(session);

  let lastHeartbeat = Date.now();
  const progressTimer = setInterval(async () => {
    if (request.state !== "processing") return;

    const now = Date.now();
    if (now - lastHeartbeat > 5000) {
      lastHeartbeat = now;
      request.lastUpdatedAt = now;
    }

    const statusText = buildRichStatusMessage(request, cwd);
    await updateMessageThrottled(channelId, statusTs, statusText, false);
    updateActiveRequest(channelId, threadId, {
      currentStatus: request.currentStatus,
      currentStep: request.currentStep,
      currentText: request.currentText,
      tools: request.tools,
      todos: request.todos,
    });
  }, 2000);

  const stopWatcher = await startEventStreamWatcher(request, cwd, () => { }, onTodosUpdated);

  try {
    request.currentStatus = "Connecting";
    await updateMessageThrottled(channelId, statusTs, buildRichStatusMessage(request, cwd), false);

    request.currentStatus = phaseLabel;
    await updateMessageThrottled(channelId, statusTs, buildRichStatusMessage(request, cwd), false);

    const responses = await sendOpenCodeMessage(
      channelId,
      sessionId,
      message,
      cwd,
      options,
      context
    );

    clearInterval(progressTimer);
    stopWatcher();
    request.state = "completed";

    await deleteMessage(channelId, statusTs);
    completeActiveRequest(channelId, threadId);

    if (responses.length === 0) {
      log.warn("No text responses from model - may have used MCP tools");
    }

    return responses;
  } catch (err) {
    clearInterval(progressTimer);
    stopWatcher();

    const { message: errorMessage, suggestion } = categorizeError(err);
    log.error("Request failed", { channelId, threadId, error: String(err) });

    request.state = "failed";
    request.error = errorMessage;

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
  const env = loadEnv();
  const { channelId, threadId, messageId } = context;

  const cwd = getChannelCwd(channelId, env.DEFAULT_CWD);

  let session = loadSession(channelId, threadId);
  const threadOwnerUserId = session?.threadOwnerUserId ?? context.userId;
  const gitEnv = buildGitEnvironmentForUser(threadOwnerUserId);
  const { sessionId, created } = await getOrCreateSession(channelId, threadId, cwd, gitEnv);

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

  if (!session.threadOwnerUserId) {
    session.threadOwnerUserId = threadOwnerUserId;
  }
  saveSession(session);

  const awaitingInput = session.plan?.status === "awaiting_input";
  const usePlanAgent = awaitingInput || /plan/i.test(text);

  const threadHistory = created
    ? await fetchThreadHistory(client, channelId, threadId, messageId)
    : null;

  const messageContext: OpenCodeMessageContext = {
    threadHistory: threadHistory || undefined,
    slack: {
      channelId,
      threadId,
      userId: threadOwnerUserId,
      threadHistory: threadHistory || undefined,
    },
  };

  const onTodosUpdated = async (todos: TrackedTodo[]) => {
    await upsertPlanMessage(session, channelId, threadId, todos);
  };

  if (usePlanAgent) {
    if (!awaitingInput) {
      session.plan = { status: "planning", todos: [] };
    } else if (session.plan) {
      session.plan.status = "planning";
    }
    saveSession(session);

    const plannerResponses = await runOpenCodeRequest(
      session,
      channelId,
      threadId,
      sessionId,
      cwd,
      text,
      "Planning",
      messageContext,
      { agent: "plan" },
      onTodosUpdated
    );

    if (!plannerResponses) return;

    const plannerText = plannerResponses
      .map((response) => response.text)
      .filter((response) => response && response.trim().length > 0)
      .join("\n\n");

    if (!session.plan) {
      session.plan = { status: "planning", todos: [] };
    }
    if (plannerText) {
      session.plan.text = plannerText;
    }
    saveSession(session);

    for (const response of plannerResponses) {
      if (response.text) {
        await sendMessage(channelId, threadId, response.text, true);
      }
    }

    const hasTodos = session.plan.todos.length > 0;
    const needsInput = responsesContainQuestion(plannerResponses);
    if (!hasTodos || needsInput) {
      session.plan.status = "awaiting_input";
      saveSession(session);
      return;
    }

    const buildPrompt = buildBuildPrompt(
      text,
      session.plan.text,
      session.plan.todos,
      true
    );
    session.plan.status = "building";
    saveSession(session);

    const buildResponses = await runOpenCodeRequest(
      session,
      channelId,
      threadId,
      sessionId,
      cwd,
      buildPrompt,
      "Building",
      messageContext,
      { agent: "build" },
      onTodosUpdated
    );

    if (!buildResponses) return;

    for (const response of buildResponses) {
      if (response.text) {
        await sendMessage(channelId, threadId, response.text, true);
      }
    }

    session.plan.status = "complete";
    saveSession(session);
    return;
  }

  session.plan = { status: "building", todos: [] };
  saveSession(session);

  const buildResponses = await runOpenCodeRequest(
    session,
    channelId,
    threadId,
    sessionId,
    cwd,
    text,
    "Building",
    messageContext,
    { agent: "build" },
    onTodosUpdated
  );

  if (!buildResponses) return;

  for (const response of buildResponses) {
    if (response.text) {
      await sendMessage(channelId, threadId, response.text, true);
    }
  }

  session.plan.status = "complete";
  saveSession(session);
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
  const env = loadEnv();
  const cwd = getChannelCwd(channelId, env.DEFAULT_CWD);

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

  const agent = session?.plan?.status === "planning" || session?.plan?.status === "awaiting_input"
    ? "plan"
    : session?.plan?.status === "building"
      ? "build"
      : undefined;

  const onTodosUpdated = session
    ? async (todos: TrackedTodo[]) => upsertPlanMessage(session, channelId, threadId, todos)
    : undefined;

  // Progress timer
  const progressTimer = setInterval(async () => {
    if (request.state !== "processing") return;
    const statusText = buildRichStatusMessage(request, cwd);
    await updateMessageThrottled(channelId, statusTs, statusText, false);
  }, 2000); // 2 seconds to reduce Slack API load

  // Event watcher
  const stopWatcher = await startEventStreamWatcher(request, cwd, () => { }, onTodosUpdated);

  try {
    // Build context - the selection is the user's response
    const messageContext = {
      slack: {
        channelId,
        threadId,
        userId: threadOwnerUserId,
      },
    };

    // Send to OpenCode - the selection as the user's message
    const responses = await sendOpenCodeMessage(
      channelId,
      sessionId,
      `User selected: ${selection}`,
      cwd,
      agent ? { agent } : undefined,
      messageContext
    );

    clearInterval(progressTimer);
    stopWatcher();
    request.state = "completed";

    // Delete status message
    await deleteMessage(channelId, statusTs);

    // Post responses directly
    for (const response of responses) {
      if (response.text) {
        await sendMessage(channelId, threadId, response.text, true);
      }
    }

    completeActiveRequest(channelId, threadId);

  } catch (err) {
    clearInterval(progressTimer);
    stopWatcher();

    const { message, suggestion } = categorizeError(err);
    log.error("Button selection handling failed", { error: String(err) });

    request.state = "failed";
    request.error = message;

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

    if (!isAuthorizedChannel(channelId)) return;

    // Get bot user ID
    if (!botUserId) {
      const authResult = await client.auth.test();
      botUserId = authResult.user_id as string;
    }

    if (userId === botUserId) return;

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

    // Check if bot is mentioned or thread is active
    const isMention = text.includes(`<@${botUserId}>`);
    const threadActive = isThreadActive(channelId, threadId);

    if (!isMention && !threadActive) return;

    // If message mentions someone else (but not us), ignore it - it's not for us
    const mentionsOthers = /<@U[A-Z0-9]+>/g.test(text) && !isMention;
    if (mentionsOthers) return;

    markThreadActive(channelId, threadId);

    const cleanText = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

    log.info("[RECV] Slack message", {
      channel: channelId,
      thread: threadId,
      user: userId,
      text: cleanText.slice(0, 100) + (cleanText.length > 100 ? "..." : ""),
    });

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
    };

    await handleUserMessage(context, cleanText, client);
  });

  // Handle app mentions
  slackApp.event("app_mention", async ({ event, say, client }) => {
    const channelId = event.channel;
    const userId = event.user;
    const text = event.text;
    const threadId = event.thread_ts || event.ts;

    if (!isAuthorizedChannel(channelId)) return;
    if (!userId) return;

    if (!botUserId) {
      const authResult = await client.auth.test();
      botUserId = authResult.user_id as string;
    }

    markThreadActive(channelId, threadId);

    const cleanText = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();

    log.info("[RECV] Slack app_mention", {
      channel: channelId,
      thread: threadId,
      user: userId,
      text: cleanText.slice(0, 100) + (cleanText.length > 100 ? "..." : ""),
    });

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
      messageId: event.ts,
    };

    await handleUserMessage(context, cleanText, client);
  });
}
