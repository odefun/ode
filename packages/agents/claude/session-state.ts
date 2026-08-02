import type { SessionMessageState, SessionTodo } from "@/utils/session-inspector";
import {
  applyAnthropicStyleStreamEvent,
  applyAssistantBlocks,
  applyUserToolResults,
  buildToolTitle,
  extractPrefixedRecord,
  extractSessionTitle,
  updateTool,
  type StreamStateMaps,
  type StreamToolState,
} from "@/agents/session-state/shared";

export type ClaudeRawRecord = {
  type?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  subtype?: string;
  status?: string | null;
  state?: string;
  parent_tool_use_id?: string | null;
  task_description?: string;
  subagent_type?: string;
  task_id?: string;
  task_type?: string;
  tool_use_id?: string;
  tool_name?: string;
  description?: string;
  prompt?: string;
  last_tool_name?: string;
  summary?: string;
  patch?: {
    status?: string;
    description?: string;
    end_time?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  usage?: Record<string, unknown>;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  elapsed_time_seconds?: number;
  error_status?: number | null;
  errors?: string[];
  total_cost_usd?: number;
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
};

export type ClaudeInspectorToolState = StreamToolState;

export type ClaudeStreamStateMaps = StreamStateMaps<ClaudeInspectorToolState>;

function normalizeTodoStatus(status: unknown): string {
  if (typeof status !== "string") return "pending";
  const normalized = status.trim().toLowerCase();
  if (!normalized) return "pending";
  if (normalized === "in progress") return "in_progress";
  return normalized.replace(/\s+/g, "_");
}

function parseTodosFromClaudeToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined
): SessionTodo[] | undefined {
  if (!input) return undefined;
  if (!toolName.toLowerCase().includes("todo")) return undefined;

  const todoListCandidate = input.todos ?? input.items ?? input.tasks;
  if (!Array.isArray(todoListCandidate)) return undefined;

  const todos = todoListCandidate
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const contentCandidate = entry.content ?? entry.text ?? entry.title ?? entry.task;
      const content = typeof contentCandidate === "string" ? contentCandidate.trim() : "";
      return {
        content,
        status: normalizeTodoStatus(entry.status),
      };
    })
    .filter((todo) => todo.content.length > 0);

  return todos;
}

function normalizeClaudeToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized === "agent" || normalized === "task" ? "subagent" : name;
}

function findSubagentTool(
  toolById: Map<string, ClaudeInspectorToolState>,
  record: ClaudeRawRecord
): ClaudeInspectorToolState | undefined {
  const directId = record.tool_use_id ?? record.parent_tool_use_id ?? undefined;
  if (directId) {
    const direct = toolById.get(directId);
    if (direct) return direct;
  }
  if (!record.task_id) return undefined;
  return [...toolById.values()].find((tool) => tool.metadata?.taskId === record.task_id);
}

function upsertClaudeSubagent(
  state: SessionMessageState,
  toolById: Map<string, ClaudeInspectorToolState>,
  record: ClaudeRawRecord,
  status: "running" | "completed" | "error",
  options: { title?: string; progress?: string; lastTool?: string; output?: string; error?: string } = {}
): ClaudeInspectorToolState {
  const id = record.tool_use_id
    ?? record.parent_tool_use_id
    ?? (record.task_id ? `claude-task:${record.task_id}` : `claude-subagent:${Date.now()}`);
  const existing = findSubagentTool(toolById, record) ?? toolById.get(id);
  const title = options.title
    ?? record.description
    ?? record.task_description
    ?? existing?.title
    ?? record.subagent_type
    ?? "subagent";
  const startedAtMs = typeof existing?.metadata?.startedAtMs === "number"
    ? existing.metadata.startedAtMs
    : Date.now();
  const tool: ClaudeInspectorToolState = {
    id: existing?.id ?? id,
    name: "subagent",
    status,
    title,
    input: existing?.input ?? { description: title },
    output: options.output ?? existing?.output,
    error: options.error ?? existing?.error,
    metadata: {
      ...(existing?.metadata ?? {}),
      provider: "claude",
      taskId: record.task_id ?? existing?.metadata?.taskId,
      parentToolUseId: record.tool_use_id ?? record.parent_tool_use_id ?? existing?.metadata?.parentToolUseId,
      subagentType: record.subagent_type ?? existing?.metadata?.subagentType,
      startedAtMs,
      lastTool: options.lastTool ?? record.last_tool_name ?? existing?.metadata?.lastTool,
      progress: options.progress ?? existing?.metadata?.progress,
      usage: record.usage ?? existing?.metadata?.usage,
      background: record.patch?.is_backgrounded ?? existing?.metadata?.background,
    },
  };
  toolById.set(tool.id, tool);
  if (record.tool_use_id && record.tool_use_id !== tool.id) toolById.set(record.tool_use_id, tool);
  if (record.parent_tool_use_id && record.parent_tool_use_id !== tool.id) toolById.set(record.parent_tool_use_id, tool);
  updateTool(state, tool);

  const detail = options.progress ?? options.lastTool ?? record.last_tool_name;
  if (status === "running") {
    state.phaseStatus = detail ? `Subagent ${title}: ${detail}` : `Running subagent: ${title}`;
  } else if (status === "error") {
    state.phaseStatus = `Subagent failed: ${title}`;
  } else {
    state.phaseStatus = `Finished subagent: ${title}`;
  }
  return tool;
}

function applyClaudeSystemRecord(
  state: SessionMessageState,
  record: ClaudeRawRecord,
  toolById: Map<string, ClaudeInspectorToolState>
): boolean {
  if (record.type !== "system") return false;
  switch (record.subtype) {
    case "task_started":
      if (!record.patch?.is_backgrounded) {
        upsertClaudeSubagent(state, toolById, record, "running", { title: record.description });
      }
      return true;
    case "task_progress":
      upsertClaudeSubagent(state, toolById, record, "running", {
        title: findSubagentTool(toolById, record)?.title,
        progress: record.summary ?? record.description,
        lastTool: record.last_tool_name,
      });
      return true;
    case "task_updated": {
      const taskStatus = record.patch?.status;
      if (taskStatus === "failed" || taskStatus === "killed") {
        upsertClaudeSubagent(state, toolById, record, "error", { error: record.patch?.error });
      } else if (taskStatus === "completed") {
        upsertClaudeSubagent(state, toolById, record, "completed");
      } else {
        upsertClaudeSubagent(state, toolById, record, "running", { progress: record.patch?.description });
      }
      return true;
    }
    case "task_notification":
      upsertClaudeSubagent(state, toolById, record, record.status === "completed" ? "completed" : "error", {
        output: record.summary,
        error: record.status === "completed" ? undefined : record.summary,
      });
      return true;
    case "api_retry": {
      const seconds = typeof record.retry_delay_ms === "number" ? Math.ceil(record.retry_delay_ms / 1000) : undefined;
      const attempt = typeof record.attempt === "number" ? ` ${record.attempt}/${record.max_retries ?? "?"}` : "";
      state.phaseStatus = `Retrying Claude request${attempt}${seconds !== undefined ? ` in ${seconds}s` : ""}`;
      return true;
    }
    case "session_state_changed":
      if (record.state === "running") state.phaseStatus = "Working";
      if (record.state === "idle") state.phaseStatus = "Waiting";
      if (record.state === "requires_action") state.phaseStatus = "Waiting for user action";
      return true;
    case "status":
      if (record.status === "compacting") state.phaseStatus = "Compacting conversation context";
      else if (record.status === "requesting" && !state.tools.some((tool) => tool.name === "subagent" && tool.status === "running")) {
        state.phaseStatus = "Requesting Claude response";
      }
      return true;
    case "compact_boundary":
      state.phaseStatus = "Compacted conversation context";
      return true;
    case "permission_denied":
      state.phaseStatus = "Claude permission denied";
      return true;
    case "worker_shutting_down":
      state.phaseStatus = "Claude worker is shutting down";
      return true;
    default:
      return false;
  }
}

export function extractClaudeRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): ClaudeRawRecord | null {
  return extractPrefixedRecord<ClaudeRawRecord>(type, "claude.raw.", eventData, eventProps);
}

export function applyClaudeRecordToState(
  state: SessionMessageState,
  record: ClaudeRawRecord,
  streamState: ClaudeStreamStateMaps,
  receivedAtMs = Date.now()
): void {
  const { textByIndex, thinkingByIndex, toolByIndex, toolById } = streamState;
  const sessionTitle = extractSessionTitle(record);
  if (sessionTitle) {
    state.sessionTitle = sessionTitle;
  }

  if (applyClaudeSystemRecord(state, record, toolById)) {
    return;
  }

  if (record.type === "tool_progress") {
    const parentId = record.parent_tool_use_id ?? record.tool_use_id;
    const parent = parentId ? toolById.get(parentId) : undefined;
    if (parent?.name === "subagent" || record.parent_tool_use_id || record.task_id) {
      upsertClaudeSubagent(state, toolById, record, "running", {
        title: parent?.title,
        lastTool: record.tool_name,
        progress: record.tool_name
          ? `${record.tool_name} (${Math.max(0, Math.round(record.elapsed_time_seconds ?? 0))}s)`
          : undefined,
      });
    }
    return;
  }

  if (record.type === "assistant") {
    const blocks = record.message?.content ?? [];
    if (record.parent_tool_use_id) {
      const lastToolBlock = blocks.find((block) => block?.type === "tool_use");
      const lastToolName = lastToolBlock?.name;
      const lastToolTitle = lastToolName
        ? buildToolTitle(lastToolName, lastToolBlock?.input)
        : undefined;
      upsertClaudeSubagent(state, toolById, record, "running", {
        title: record.task_description,
        lastTool: lastToolName,
        progress: [lastToolName, lastToolTitle].filter(Boolean).join(" - ") || "working",
      });
      return;
    }
    const normalizedBlocks = blocks.map((block) => block?.type === "tool_use"
      ? { ...block, name: normalizeClaudeToolName(block.name ?? "tool") }
      : block);
    for (const block of normalizedBlocks) {
      if (block?.type !== "tool_use") continue;
      const toolName = typeof block.name === "string" ? block.name : "";
      const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
        ? block.input as Record<string, unknown>
        : undefined;
      const parsedTodos = parseTodosFromClaudeToolInput(toolName, input);
      if (parsedTodos) {
        state.todos = parsedTodos;
      }
    }
    applyAssistantBlocks(state, normalizedBlocks, { toolById }, "claude-tool", { startedAtMs: receivedAtMs });
    return;
  }

  if (record.type === "user") {
    if (record.parent_tool_use_id) {
      upsertClaudeSubagent(state, toolById, record, "running", {
        title: record.task_description,
        progress: "processing tool result",
      });
      return;
    }
    applyUserToolResults(state, record.message?.content ?? [], { toolById });
    return;
  }

  if (record.type === "result") {
    const error = record.errors?.find((entry) => entry.trim()) ?? record.error;
    state.phaseStatus = record.is_error
      ? `Claude error: ${error ?? record.subtype ?? "execution failed"}`
      : "Finalizing response";
    return;
  }

  if (record.type === "rate_limit_event") {
    state.phaseStatus = "Claude rate limit updated";
    return;
  }

  if (record.type !== "stream_event") {
    return;
  }

  if (record.event?.type === "content_block_start" && record.event.content_block?.type === "tool_use") {
    const block = record.event.content_block;
    const toolName = typeof block.name === "string" ? block.name : "";
    const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : undefined;
    const parsedTodos = parseTodosFromClaudeToolInput(toolName, input);
    if (parsedTodos) {
      state.todos = parsedTodos;
    }
  }

  const streamRecord = record.event?.content_block?.type === "tool_use"
    ? {
        ...record,
        event: {
          ...record.event,
          content_block: {
            ...record.event.content_block,
            name: normalizeClaudeToolName(String(record.event.content_block.name ?? "tool")),
          },
        },
      }
    : record;
  applyAnthropicStyleStreamEvent(state, streamRecord, {
    textByIndex,
    thinkingByIndex,
    toolByIndex,
    toolById,
  }, "claude-tool", { completeToolOnContentBlockStop: false, startedAtMs: receivedAtMs });

  if (record.event?.type === "content_block_delta" && record.event.delta?.type === "input_json_delta") {
    const index = typeof record.event.index === "number" ? record.event.index : undefined;
    if (typeof index === "number") {
      const tool = toolByIndex.get(index);
      if (tool) {
        const parsedTodos = parseTodosFromClaudeToolInput(tool.name, tool.input);
        if (parsedTodos) {
          state.todos = parsedTodos;
        }
      }
    }
  }
}
