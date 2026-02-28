import type { SessionMessageState } from "@/utils/session-inspector";
import {
  applyAnthropicStyleStreamEvent,
  applyAssistantUserResultBranches,
  extractPrefixedRecord,
  parseTodosFromToolInput,
  extractSessionTitle,
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
      content?: string;
      is_error?: boolean;
    }>;
  };
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
};

export type ClaudeInspectorToolState = StreamToolState;

export type ClaudeStreamStateMaps = StreamStateMaps<ClaudeInspectorToolState>;

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
  streamState: ClaudeStreamStateMaps
): void {
  const { textByIndex, thinkingByIndex, toolByIndex, toolById } = streamState;
  const blocks = record.message?.content ?? [];
  const sessionTitle = extractSessionTitle(record);
  if (sessionTitle) {
    state.sessionTitle = sessionTitle;
  }

  if (applyAssistantUserResultBranches({
    state,
    blocks,
    streamState: { toolById },
    toolPrefix: "claude-tool",
    providerName: "Claude",
    isError: record.is_error,
    assistant: record.type === "assistant",
    user: record.type === "user",
    result: record.type === "result",
    beforeAssistant: (assistantBlocks) => {
      for (const block of assistantBlocks) {
        if (block?.type !== "tool_use") continue;
        const toolName = typeof block.name === "string" ? block.name : "";
        const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : undefined;
        const parsedTodos = parseTodosFromToolInput(toolName, input);
        if (parsedTodos) {
          state.todos = parsedTodos;
        }
      }
    },
  })) {
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
    const parsedTodos = parseTodosFromToolInput(toolName, input);
    if (parsedTodos) {
      state.todos = parsedTodos;
    }
  }

  applyAnthropicStyleStreamEvent(state, record, {
    textByIndex,
    thinkingByIndex,
    toolByIndex,
    toolById,
  }, "claude-tool");

  if (record.event?.type === "content_block_delta" && record.event.delta?.type === "input_json_delta") {
    const index = typeof record.event.index === "number" ? record.event.index : undefined;
    if (typeof index === "number") {
      const tool = toolByIndex.get(index);
      if (tool) {
        const parsedTodos = parseTodosFromToolInput(tool.name, tool.input);
        if (parsedTodos) {
          state.todos = parsedTodos;
        }
      }
    }
  }
}
