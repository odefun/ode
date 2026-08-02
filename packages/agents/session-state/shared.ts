import type { SessionMessageState, SessionTodo, SessionTool } from "@/utils/session-inspector";

type StreamEventRecord = {
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
};

type ToolBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text))
    .join("\n")
    .trim();
  return text || undefined;
}

export type StreamToolState = SessionTool & {
  inputBuffer?: string;
};

export type StreamStateMaps<TTool extends StreamToolState = StreamToolState> = {
  textByIndex: Map<number, string>;
  thinkingByIndex: Map<number, string>;
  toolByIndex: Map<number, TTool>;
  toolById: Map<string, TTool>;
};

export function updateTool(state: SessionMessageState, tool: SessionTool): void {
  const existingIdx = state.tools.findIndex((current) => current.id === tool.id);
  if (existingIdx >= 0) {
    state.tools[existingIdx] = tool;
    return;
  }
  state.tools.push(tool);
}

export function tryParseObject(input: string): Record<string, unknown> | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeTodoStatus(status: unknown): SessionTodo["status"] {
  if (typeof status !== "string") return "pending";
  const normalized = status.trim().toLowerCase();
  if (!normalized) return "pending";
  if (normalized === "in progress") return "in_progress";
  return normalized.replace(/\s+/g, "_");
}

export function parseTodosFromToolInput(
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

export function parseMarkdownTodos(content: string): SessionTodo[] | undefined {
  const todos = content
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*[-*]\s+\[([ xX~-])\]\s+(.+?)\s*$/);
      if (!match) return null;
      const marker = match[1] ?? " ";
      const text = (match[2] ?? "").trim();
      if (!text) return null;
      const status = marker.toLowerCase() === "x"
        ? "completed"
        : marker === "~" || marker === "-"
          ? "in_progress"
          : "pending";
      return { content: text, status };
    })
    .filter((todo): todo is SessionTodo => todo !== null);

  return todos.length > 0 ? todos : undefined;
}

function compactSingleLine(value: string, maxLength = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function firstStringValue(input: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!input) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function buildToolTitle(
  toolName: string,
  input: Record<string, unknown> | undefined
): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized || !input) return undefined;

  if (normalized.includes("todo")) {
    const todos = parseTodosFromToolInput(toolName, input);
    return todos ? `${todos.length} tasks` : undefined;
  }

  if (normalized === "bash" || normalized === "shell" || normalized.includes("terminal")) {
    return compactSingleLine(firstStringValue(input, ["command", "cmd", "script"]) ?? "");
  }

  if (normalized === "read" || normalized.includes("read")) {
    return firstStringValue(input, ["file_path", "path", "uri", "target"]);
  }

  if (normalized === "file_editor") {
    return firstStringValue(input, ["summary", "description", "title", "path"]);
  }

  if (normalized === "write" || normalized === "edit" || normalized.includes("edit")) {
    return firstStringValue(input, ["file_path", "path", "target"]);
  }

  if (normalized === "grep" || normalized.includes("grep") || normalized.includes("search")) {
    const pattern = firstStringValue(input, ["pattern", "query", "regex", "content"]);
    const path = firstStringValue(input, ["path", "include", "glob"]);
    return [pattern ? compactSingleLine(pattern, 80) : undefined, path].filter(Boolean).join(" in ") || undefined;
  }

  if (normalized === "glob" || normalized.includes("find") || normalized.includes("ls")) {
    return firstStringValue(input, ["pattern", "path", "glob", "directory"]);
  }

  if (normalized === "agent" || normalized === "subagent" || normalized.includes("task")) {
    const description = firstStringValue(input, ["description", "prompt", "task", "message"]);
    return description ? compactSingleLine(description) : undefined;
  }

  return compactSingleLine(firstStringValue(input, ["description", "title", "summary", "prompt", "query", "path", "file_path"]) ?? "");
}

export function composeIndexedText(parts: Map<number, string>): string {
  if (parts.size === 0) return "";
  const sorted = [...parts.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([, text]) => text).join("");
}

export function extractSessionTitle(value: unknown): string | undefined {
  const normalizeTitle = (candidate: unknown): string | undefined => {
    if (typeof candidate !== "string") return undefined;
    const trimmed = candidate.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("New session")) return undefined;
    if (trimmed.startsWith("<system-prompt>") || trimmed.startsWith("ODE RUNTIME CONTEXT:")) {
      return undefined;
    }
    return trimmed;
  };

  if (!value || typeof value !== "object") return undefined;

  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    const record = current as Record<string, unknown>;
    const directTitle = normalizeTitle(record.title);
    if (directTitle) return directTitle;

    const info = record.info;
    if (info && typeof info === "object" && !Array.isArray(info)) {
      const infoRecord = info as Record<string, unknown>;
      const infoTitle = normalizeTitle(infoRecord.title);
      if (infoTitle) return infoTitle;
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }

  return undefined;
}

export function extractPrefixedRecord<TRecord>(
  type: string,
  prefix: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): TRecord | null {
  if (!type.startsWith(prefix)) return null;
  const candidate = eventProps.record ?? eventData.record;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as TRecord;
}

export function applyAssistantBlocks<TTool extends StreamToolState>(
  state: SessionMessageState,
  blocks: ToolBlock[],
  streamState: Pick<StreamStateMaps<TTool>, "toolById">,
  toolPrefix: string,
  options: { startedAtMs?: number } = {}
): void {
  const { toolById } = streamState;
  const text = blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  if (text) {
    state.currentText = text;
    state.phaseStatus = "Drafting response";
  }

  for (const block of blocks) {
    if (block?.type !== "tool_use") continue;
    const toolId = typeof block.id === "string" && block.id.trim()
      ? block.id
      : `${toolPrefix}-${Date.now()}`;
    const toolName = typeof block.name === "string" && block.name.trim()
      ? block.name
      : "tool";
    const input = block.input && typeof block.input === "object"
      ? (block.input as Record<string, unknown>)
      : undefined;

    const existing = toolById.get(toolId);
    const tool = {
      id: toolId,
      name: toolName,
      status: existing?.status === "completed" || existing?.status === "error"
        ? existing.status
        : "running",
      input: input ?? existing?.input,
      output: existing?.output,
      error: existing?.error,
      title: buildToolTitle(toolName, input ?? existing?.input) ?? existing?.title,
      metadata: {
        ...(existing?.metadata ?? {}),
        startedAtMs: typeof existing?.metadata?.startedAtMs === "number"
          ? existing.metadata.startedAtMs
          : options.startedAtMs ?? Date.now(),
      },
    } as unknown as TTool;
    const parsedTodos = parseTodosFromToolInput(toolName, input);
    if (parsedTodos) {
      state.todos = parsedTodos;
    }
    toolById.set(toolId, tool);
    updateTool(state, tool);
    if (tool.status === "running") {
      state.phaseStatus = tool.title ? `Running tool: ${toolName} - ${tool.title}` : `Running tool: ${toolName}`;
    }
  }
}

export function applyUserToolResults<TTool extends StreamToolState>(
  state: SessionMessageState,
  blocks: ToolBlock[],
  streamState: Pick<StreamStateMaps<TTool>, "toolById">,
  fallbackErrorMessage = "Tool failed"
): void {
  const { toolById } = streamState;
  for (const block of blocks) {
    if (block?.type !== "tool_result") continue;
    const toolId = typeof block.tool_use_id === "string" && block.tool_use_id.trim()
      ? block.tool_use_id
      : "";
    if (!toolId) continue;

    const existing = toolById.get(toolId);
    if (!existing) continue;

    const hasError = block.is_error === true;
    const output = extractToolResultText(block.content);
    const updated = {
      ...existing,
      status: hasError ? "error" : "completed",
      output,
      error: hasError ? output || fallbackErrorMessage : existing.error,
    } as TTool;
    toolById.set(toolId, updated);
    updateTool(state, updated);
    const detail = updated.title ? `${updated.name} - ${updated.title}` : updated.name;
    state.phaseStatus = `${hasError ? "Tool failed" : "Finished tool"}: ${detail}`;
  }
}

export function applyAnthropicStyleStreamEvent<TTool extends StreamToolState>(
  state: SessionMessageState,
  record: StreamEventRecord,
  streamState: StreamStateMaps<TTool>,
  toolPrefix: string,
  options: { completeToolOnContentBlockStop?: boolean; startedAtMs?: number } = {}
): boolean {
  if (!record || !record.event?.type) return false;
  const { textByIndex, thinkingByIndex, toolByIndex, toolById } = streamState;
  const eventType = record.event.type;
  const index = typeof record.event.index === "number" ? record.event.index : undefined;

  switch (eventType) {
    case "message_start": {
      // Content block indexes are scoped to one assistant message. Claude
      // restarts them at zero after a tool result, so retaining the previous
      // message's index maps can incorrectly resurrect a completed tool when
      // the final text block stops.
      textByIndex.clear();
      thinkingByIndex.clear();
      toolByIndex.clear();
      state.currentText = "";
      state.thinkingText = undefined;
      state.phaseStatus = "Thinking";
      return true;
    }
    case "content_block_start": {
      const block = record.event.content_block;
      if (block?.type === "tool_use") {
        const toolId = typeof block.id === "string" && block.id.trim()
          ? block.id
          : typeof index === "number"
            ? `${toolPrefix}-${index}`
            : `${toolPrefix}-${Date.now()}`;
        const toolName = typeof block.name === "string" && block.name.trim()
          ? block.name
          : "tool";
        const input = block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : undefined;
        const tool = {
          id: toolId,
          name: toolName,
          status: "running",
          input,
          title: buildToolTitle(toolName, input),
          metadata: { startedAtMs: options.startedAtMs ?? Date.now() },
        } as unknown as TTool;
        const parsedTodos = parseTodosFromToolInput(toolName, input);
        if (parsedTodos) {
          state.todos = parsedTodos;
        }
        toolById.set(toolId, tool);
        if (typeof index === "number") {
          toolByIndex.set(index, tool);
        }
        updateTool(state, tool);
        state.phaseStatus = tool.title ? `Running tool: ${toolName} - ${tool.title}` : `Running tool: ${toolName}`;
        return true;
      }

      if (block?.type === "thinking") {
        const thinking = typeof block.thinking === "string" ? block.thinking : "";
        if (thinking) {
          state.thinkingText = thinking;
          if (typeof index === "number") {
            thinkingByIndex.set(index, thinking);
          }
        }
        state.phaseStatus = "Thinking";
        return true;
      }

      state.phaseStatus = "Drafting response";
      return true;
    }
    case "content_block_delta": {
      const delta = record.event.delta;
      if (delta?.type === "text_delta") {
        const chunk = typeof delta.text === "string" ? delta.text : "";
        if (!chunk) return true;
        if (typeof index === "number") {
          const next = `${textByIndex.get(index) ?? ""}${chunk}`;
          textByIndex.set(index, next);
          state.currentText = composeIndexedText(textByIndex);
        } else {
          state.currentText = `${state.currentText}${chunk}`;
        }
        state.phaseStatus = "Drafting response";
        return true;
      }

      if (delta?.type === "input_json_delta") {
        if (typeof index !== "number") {
          state.phaseStatus = "Running tool";
          return true;
        }
        const tool = toolByIndex.get(index);
        if (!tool) {
          state.phaseStatus = "Running tool";
          return true;
        }
        const chunk = typeof delta.partial_json === "string" ? delta.partial_json : "";
        if (chunk) {
          tool.inputBuffer = `${tool.inputBuffer ?? ""}${chunk}`;
          const parsedInput = tryParseObject(tool.inputBuffer);
          if (parsedInput) {
            tool.input = parsedInput;
            tool.title = buildToolTitle(tool.name, parsedInput) ?? tool.title;
            const parsedTodos = parseTodosFromToolInput(tool.name, tool.input);
            if (parsedTodos) {
              state.todos = parsedTodos;
            }
          }
        }
        tool.status = "running";
        toolById.set(tool.id, tool);
        toolByIndex.set(index, tool);
        updateTool(state, tool);
        state.phaseStatus = tool.title ? `Running tool: ${tool.name} - ${tool.title}` : `Running tool: ${tool.name}`;
        return true;
      }

      if (delta?.type === "thinking_delta") {
        const chunk = typeof delta.thinking === "string" ? delta.thinking : "";
        if (!chunk) return true;
        if (typeof index === "number") {
          const next = `${thinkingByIndex.get(index) ?? ""}${chunk}`;
          thinkingByIndex.set(index, next);
          state.thinkingText = next;
        } else {
          state.thinkingText = `${state.thinkingText ?? ""}${chunk}`;
        }
        state.phaseStatus = "Thinking";
      }
      return true;
    }
    case "content_block_stop": {
      if (typeof index !== "number") {
        state.phaseStatus = "Finished step";
        return true;
      }
      const tool = toolByIndex.get(index);
      if (!tool) {
        state.phaseStatus = "Finished step";
        return true;
      }
      if (options.completeToolOnContentBlockStop === false) {
        tool.status = "running";
        toolById.set(tool.id, tool);
        toolByIndex.set(index, tool);
        updateTool(state, tool);
        state.phaseStatus = tool.title ? `Running tool: ${tool.name} - ${tool.title}` : `Running tool: ${tool.name}`;
        return true;
      }
      tool.status = "completed";
      toolById.set(tool.id, tool);
      toolByIndex.set(index, tool);
      updateTool(state, tool);
      state.phaseStatus = tool.title ? `Finished tool: ${tool.name} - ${tool.title}` : `Finished tool: ${tool.name}`;
      return true;
    }
    case "message_stop": {
      const runningTool = [...state.tools]
        .reverse()
        .find((tool) => tool.status === "running" || tool.status === "pending");
      if (runningTool) {
        const detail = runningTool.title ? `${runningTool.name} - ${runningTool.title}` : runningTool.name;
        state.phaseStatus = `Running tool: ${detail}`;
      } else {
        state.phaseStatus = "Finalizing response";
      }
      return true;
    }
    default:
      return true;
  }
}
