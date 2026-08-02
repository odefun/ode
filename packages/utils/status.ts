import {
  TOOL_DISPLAY_CONFIG,
  type StatusMessageFormat,
} from "@/config/web";
import { getAgentProviderRunningTitle, type AgentProviderId } from "@/shared/agent-provider";
import type { SessionMessageState } from "./session-inspector";

export type StatusRequest = {
  channelId: string;
  threadId: string;
  statusMessageTs: string;
  startedAt: number;
  currentText: string;
  statusFrozen?: boolean;
};

export type AgentStatusProvider = AgentProviderId;

type StatusTodo = {
  content: string;
  status: string;
};

const PLAN_TODO_LIMIT = 15;
const SUBAGENT_WAIT_THRESHOLD_MS = 30_000;

export function formatElapsedTime(startedAt: number): string {
  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  let current = Math.abs(value);
  let unitIndex = 0;
  const units = ["", "k", "m", "b", "t"];

  while (current >= 1000 && unitIndex < units.length - 1) {
    current /= 1000;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${sign}${Math.round(current)}`;
  }

  const rounded = current >= 10
    ? Math.round(current)
    : Math.round(current * 10) / 10;
  const numeric = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${sign}${numeric}${units[unitIndex]}`;
}

function formatCost(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1) return String(Math.round(value * 100) / 100);
  if (value >= 0.01) return value.toFixed(2);
  return value.toFixed(4);
}

function buildHeaderDetails(state: SessionMessageState): string {
  const details: string[] = [];
  if (state.model) {
    details.push(state.model);
  }

  const totalTokens = state.tokenUsage?.total;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    details.push(`${formatCompactCount(totalTokens)} tokens`);
  }

  if (state.agent) {
    details.push(state.agent);
  }

  const cost = state.tokenUsage?.cost;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
    details.push(`cost ${formatCost(cost)}`);
  }

  details.push(formatElapsedTime(state.startedAt));
  return details.join(", ");
}

export function getToolIcon(status: string): string {
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

export function getTodoIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✅";
    case "in_progress":
      return "▶️";
    default:
      return "⬜";
  }
}

export function getStatusMessageKey(request: StatusRequest): string {
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

export function trimToolPath(label: string, workingPath: string): string {
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

function formatTodoLines(todos: StatusTodo[], limit = PLAN_TODO_LIMIT): string[] {
  const lines: string[] = [];
  for (const todo of todos.slice(0, limit)) {
    const checkbox = todo.status === "completed"
      ? "[x]"
      : todo.status === "in_progress"
        ? "[~]"
        : "[ ]";
    lines.push(`- ${checkbox} ${todo.content}`);
  }
  if (todos.length > limit) {
    lines.push(`_(+${todos.length - limit} more)_`);
  }
  return lines;
}

function resolveLongRunningSubagentPhase(state: SessionMessageState): string | undefined {
  const runningSubagent = [...state.tools]
    .reverse()
    .find((tool) => {
      const name = typeof tool.name === "string" ? tool.name.trim().toLowerCase() : "";
      const isSubagent = name === "subagent" || name === "subtask" || name === "task";
      return (tool.status === "running" || tool.status === "pending") && isSubagent;
    });

  if (!runningSubagent) return undefined;
  const startedAtMs = typeof runningSubagent.metadata?.startedAtMs === "number"
    ? runningSubagent.metadata.startedAtMs
    : undefined;
  if (!startedAtMs) return undefined;

  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < SUBAGENT_WAIT_THRESHOLD_MS) return undefined;

  const title = runningSubagent.title?.trim();
  const progress = typeof runningSubagent.metadata?.progress === "string"
    ? runningSubagent.metadata.progress.trim()
    : typeof runningSubagent.metadata?.lastTool === "string"
      ? runningSubagent.metadata.lastTool.trim()
      : "";
  return title
    ? `Waiting for subagent: ${title}${progress ? ` — ${progress}` : ""} (${formatElapsedTime(startedAtMs)})`
    : `Waiting for subagent output (${formatElapsedTime(startedAtMs)})`;
}

function normalizeToolName(name: string): string {
  switch (name) {
    case "read_file":
    case "read_many_files":
      return "read";
    case "write_file":
      return "write";
    case "run_shell_command":
    case "shell":
      return "bash";
    case "tree":
      return "tree";
    case "grep_search":
      return "grep";
    case "list_directory":
      return "list_directory";
    default:
      return name;
  }
}

function getToolDisplayName(name: string): string {
  switch (name.toLowerCase()) {
    case "read_file":
      return "read";
    case "read_many_files":
      return "read";
    case "write_file":
      return "write";
    case "run_shell_command":
      return "bash";
    case "shell":
      return "shell";
    case "grep_search":
      return "grep";
    default:
      return name;
  }
}

function buildToolDetails(tool: SessionMessageState["tools"][number], workingPath: string): string {
  const name = normalizeToolName(tool.name?.toLowerCase?.() ?? "");
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
    const filePath = input.filePath || input.file_path || input.absolute_path || input.path || input.uri || input.target;
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
    const filePath = input.filePath || input.file_path || input.absolute_path || input.path || input.target;
    if (filePath) {
      return trimToolPath(String(filePath), workingPath);
    }
  }

  if (name === "list_directory") {
    const path = input.path || input.directory;
    if (path) {
      return trimToolPath(String(path), workingPath);
    }
  }

  if (name === "tree") {
    const path = input.path || input.directory;
    const depth = typeof input.depth === "number" ? `depth ${input.depth}` : "";
    return [path ? trimToolPath(String(path), workingPath) : "", depth].filter(Boolean).join(" ");
  }

  if (name === "bash") {
    return String(input.command || input.cmd || "");
  }

  return title ? trimToolPath(title, workingPath) : "";
}

function truncateToolDetail(detail: string, limit: number | null): string {
  if (limit === null || detail.length <= limit) return detail;
  return `${detail.slice(0, limit)}...`;
}

export function buildToolLines(
  state: SessionMessageState,
  workingPath: string,
  statusMessageFormat: StatusMessageFormat
): string[] {
  const tools = state.tools || [];
  if (tools.length === 0) return [];

  const { itemLimit, detailLimit } = TOOL_DISPLAY_CONFIG[statusMessageFormat];
  const items = tools.length > itemLimit ? tools.slice(-itemLimit) : tools;
  const header = tools.length > itemLimit
    ? `*Tool execution (Last ${itemLimit} items in ${tools.length})*`
    : "*Tool execution*";

  const lines = [header];
  const codeMark = "`";
  for (const tool of items) {
    const details = buildToolDetails(tool, workingPath);
    const truncated = details ? truncateToolDetail(details, detailLimit) : "";
    const suffix = truncated ? ` ${truncated}` : "";
    lines.push(`${getToolIcon(tool.status)} ${codeMark}${getToolDisplayName(tool.name)}${codeMark}${suffix}`);
  }

  return lines;
}

export function buildLiveStatusMessage(
  request: StatusRequest,
  workingPath: string,
  state?: SessionMessageState,
  statusMessageFormat: StatusMessageFormat = "medium"
): string {
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
  const headerDetails = buildHeaderDetails(state);

  if (state.sessionTitle) {
    lines.push(`**${state.sessionTitle}** · ${headerDetails}`);
  } else {
    lines.push(headerDetails);
  }

  const longRunningSubagentPhase = resolveLongRunningSubagentPhase(state);
  if (longRunningSubagentPhase) {
    lines.push(`*${longRunningSubagentPhase}*`);
  } else if (state.phaseStatus) {
    lines.push(`*${state.phaseStatus}*`);
  }

  if (state.thinkingText?.trim()) {
    const thinking = state.thinkingText.trim().replace(/\s+/g, " ");
    const preview = thinking.length > 420 ? `${thinking.slice(0, 419)}…` : thinking;
    lines.push("", "**Reasoning**", `> ${preview}`);
  }

  if (state.todos.length > 0) {
    const todos = state.todos.map((todo) => ({
      content: todo.content,
      status: todo.status,
    }));
    lines.push("", "**Plan**", ...formatTodoLines(todos));
  }

  const toolLines = buildToolLines(state, workingPath, statusMessageFormat);
  if (toolLines.length > 0) {
    lines.push("", "**Activity**");
    lines.push(...toolLines);
  }

  if (state.currentText?.trim()) {
    const current = state.currentText.trim();
    const preview = current.length > 900 ? `${current.slice(0, 899)}…` : current;
    lines.push("", "**Latest output**", preview);
  }

  return lines.join("\n");
}

export function buildStatusMessageByProvider(
  provider: AgentStatusProvider,
  request: StatusRequest,
  workingPath: string,
  state?: SessionMessageState,
  statusMessageFormat: StatusMessageFormat = "medium"
): string {
  const fallbackTitle = getAgentProviderRunningTitle(provider);

  const effectiveState: SessionMessageState = state
    ? {
        ...state,
        sessionTitle: state.sessionTitle || fallbackTitle,
      }
    : {
        sessionTitle: fallbackTitle,
        currentText: request.currentText,
        tools: [],
        todos: [],
        startedAt: request.startedAt,
      };

  return buildLiveStatusMessage(request, workingPath, effectiveState, statusMessageFormat);
}
