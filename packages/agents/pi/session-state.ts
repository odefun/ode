import type { SessionMessageState } from "@/utils/session-inspector";
import {
  buildToolTitle,
  extractPrefixedRecord,
  extractSessionTitle,
  tryParseObject,
  type StreamStateMaps,
  type StreamToolState,
  updateTool,
} from "@/agents/session-state/shared";

type PiContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  partialJson?: string;
  index?: number;
};

export type PiRawRecord = {
  type?: string;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: {
    content?: PiContentBlock[] | string;
    isError?: boolean;
  };
  message?: {
    role?: string;
    content?: PiContentBlock[] | string;
    model?: string;
    provider?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
  assistantMessageEvent?: {
    type?: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: {
      content?: PiContentBlock[];
    };
  };
};

export function extractPiRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): PiRawRecord | null {
  return extractPrefixedRecord<PiRawRecord>(type, "pi.raw.", eventData, eventProps);
}

function contentToText(content: PiContentBlock[] | string | undefined, type: "text" | "thinking"): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === type)
    .map((part) => type === "text" ? (part.text ?? "") : (part.thinking ?? ""))
    .join("")
    .trim();
}

function compactStatus(value: string, maxLength = 90): string {
  const compact = value
    .replace(/[*_`#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "Thinking";
  return `Thinking: ${compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact}`;
}

function normalizeToolInput(block: PiContentBlock): Record<string, unknown> | undefined {
  if (block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
    return block.arguments;
  }
  if (block.input && typeof block.input === "object" && !Array.isArray(block.input)) {
    return block.input;
  }
  if (typeof block.partialJson === "string") {
    return tryParseObject(block.partialJson) ?? undefined;
  }
  return undefined;
}

function upsertPiToolCall(
  state: SessionMessageState,
  block: PiContentBlock,
  streamState: StreamStateMaps<StreamToolState>
): void {
  if (block.type !== "toolCall") return;
  const toolId = typeof block.id === "string" && block.id.trim()
    ? block.id
    : typeof block.index === "number"
      ? `pi-tool-${block.index}`
      : `pi-tool-${Date.now()}`;
  const toolName = typeof block.name === "string" && block.name.trim() ? block.name : "tool";
  const input = normalizeToolInput(block);
  const existing = streamState.toolById.get(toolId);
  const nextTool: StreamToolState = {
    id: toolId,
    name: toolName,
    status: existing?.status === "completed" || existing?.status === "error" ? existing.status : "running",
    input: input ?? existing?.input,
    output: existing?.output,
    error: existing?.error,
    title: buildToolTitle(toolName, input ?? existing?.input) ?? existing?.title,
    metadata: existing?.metadata,
  };
  streamState.toolById.set(toolId, nextTool);
  if (typeof block.index === "number") {
    streamState.toolByIndex.set(block.index, nextTool);
  }
  updateTool(state, nextTool);
  state.phaseStatus = nextTool.title
    ? `Running tool: ${toolName} - ${nextTool.title}`
    : `Running tool: ${toolName}`;
}

function applyPiToolCallsFromContent(
  state: SessionMessageState,
  content: PiContentBlock[] | string | undefined,
  streamState: StreamStateMaps<StreamToolState>
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    upsertPiToolCall(state, block, streamState);
  }
}

function applyPiToolResult(
  state: SessionMessageState,
  record: PiRawRecord,
  streamState: StreamStateMaps<StreamToolState>
): void {
  const message = record.message;
  if (message?.role !== "toolResult") return;
  const toolId = typeof message.toolCallId === "string" && message.toolCallId.trim() ? message.toolCallId : "";
  if (!toolId) return;
  const existing = streamState.toolById.get(toolId);
  if (!existing) return;
  const output = contentToText(message.content, "text");
  const isError = message.isError === true;
  const nextTool: StreamToolState = {
    ...existing,
    status: isError ? "error" : "completed",
    output: output || existing.output,
    error: isError ? output || "Tool failed" : existing.error,
  };
  streamState.toolById.set(toolId, nextTool);
  updateTool(state, nextTool);
  const detail = nextTool.title ? `${nextTool.name} - ${nextTool.title}` : nextTool.name;
  state.phaseStatus = `${isError ? "Tool failed" : "Finished tool"}: ${detail}`;
}

export function applyPiRecordToState(
  state: SessionMessageState,
  record: PiRawRecord,
  streamState: StreamStateMaps<StreamToolState>
): void {
  const title = extractSessionTitle(record);
  if (title) state.sessionTitle = title;

  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (type === "session") {
    state.phaseStatus = "Started Pi session";
    return;
  }

  if (type === "tool_execution_start") {
    const toolId = typeof record.toolCallId === "string" && record.toolCallId.trim()
      ? record.toolCallId
      : `pi-tool-${Date.now()}`;
    const toolName = typeof record.toolName === "string" && record.toolName.trim()
      ? record.toolName
      : "tool";
    const tool: StreamToolState = {
      id: toolId,
      name: toolName,
      status: "running",
      input: record.args,
      title: buildToolTitle(toolName, record.args),
    };
    streamState.toolById.set(toolId, tool);
    updateTool(state, tool);
    state.phaseStatus = tool.title
      ? `Running tool: ${toolName} - ${tool.title}`
      : `Running tool: ${toolName}`;
    return;
  }

  if (type === "tool_execution_end") {
    const toolId = typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
    const existing = toolId ? streamState.toolById.get(toolId) : undefined;
    const toolName = record.toolName || existing?.name || "tool";
    const isError = record.result?.isError === true;
    const output = contentToText(record.result?.content, "text");
    const tool: StreamToolState = {
      id: toolId || existing?.id || `pi-tool-${Date.now()}`,
      name: toolName,
      status: isError ? "error" : "completed",
      input: existing?.input,
      output: output || existing?.output,
      error: isError ? output || "Tool failed" : undefined,
      title: existing?.title,
      metadata: existing?.metadata,
    };
    streamState.toolById.set(tool.id, tool);
    updateTool(state, tool);
    const detail = tool.title ? `${tool.name} - ${tool.title}` : tool.name;
    state.phaseStatus = `${isError ? "Tool failed" : "Finished tool"}: ${detail}`;
    return;
  }

  if (type === "agent_settled") {
    state.phaseStatus = "Finalizing response";
    return;
  }

  if (type === "agent_start" || type === "turn_start") {
    state.phaseStatus = "Thinking";
    return;
  }

  if (type === "message_update") {
    const event = record.assistantMessageEvent;
    const index = typeof event?.contentIndex === "number" ? event.contentIndex : 0;
    const eventType = event?.type ?? "";
    applyPiToolCallsFromContent(state, event?.partial?.content ?? record.message?.content, streamState);
    if (eventType.startsWith("text")) {
      const text = typeof event?.content === "string" ? event.content : undefined;
      const delta = typeof event?.delta === "string" ? event.delta : "";
      const next = text ?? `${streamState.textByIndex.get(index) ?? ""}${delta}`;
      streamState.textByIndex.set(index, next);
      state.currentText = next.trim();
      state.phaseStatus = "Drafting response";
      return;
    }
    if (eventType.startsWith("thinking")) {
      const text = typeof event?.content === "string" ? event.content : undefined;
      const delta = typeof event?.delta === "string" ? event.delta : "";
      const next = text ?? `${streamState.thinkingByIndex.get(index) ?? ""}${delta}`;
      streamState.thinkingByIndex.set(index, next);
      state.thinkingText = next.trim();
      state.phaseStatus = compactStatus(next);
      return;
    }
    if (eventType.startsWith("toolcall")) {
      return;
    }
  }

  if ((type === "message_start" || type === "message_end") && record.message?.role === "toolResult") {
    applyPiToolCallsFromContent(state, record.message?.content, streamState);
    applyPiToolResult(state, record, streamState);
    return;
  }

  if (type === "message_end" || type === "turn_end") {
    if (record.message?.role === "assistant") {
      const text = contentToText(record.message.content, "text");
      const thinking = contentToText(record.message.content, "thinking");
      if (text) state.currentText = text;
      if (thinking) state.thinkingText = thinking;
      applyPiToolCallsFromContent(state, record.message.content, streamState);
    }
    state.phaseStatus = type === "turn_end" ? "Finalizing response" : state.phaseStatus;
    return;
  }

  if (type === "agent_end") {
    state.phaseStatus = "Waiting";
  }
}
