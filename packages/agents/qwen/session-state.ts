import type { SessionMessageState } from "@/utils/session-inspector";
import {
  applyAnthropicStyleStreamEvent,
  applyAssistantUserResultBranches,
  extractPrefixedRecord,
  extractSessionTitle,
  type StreamStateMaps,
  type StreamToolState,
} from "@/agents/session-state/shared";

export type QwenRawRecord = {
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

export type QwenInspectorToolState = StreamToolState;

export type QwenStreamStateMaps = StreamStateMaps<QwenInspectorToolState>;

export function extractQwenRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): QwenRawRecord | null {
  return extractPrefixedRecord<QwenRawRecord>(type, "qwen.raw.", eventData, eventProps);
}

export function applyQwenRecordToState(
  state: SessionMessageState,
  record: QwenRawRecord,
  streamState: QwenStreamStateMaps
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
    toolPrefix: "qwen-tool",
    providerName: "Qwen",
    isError: record.is_error,
    assistant: record.type === "assistant",
    user: record.type === "user",
    result: record.type === "result",
  })) {
    return;
  }

  if (record.type !== "stream_event") {
    return;
  }
  applyAnthropicStyleStreamEvent(state, record, {
    textByIndex,
    thinkingByIndex,
    toolByIndex,
    toolById,
  }, "qwen-tool");
}
