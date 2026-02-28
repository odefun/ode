import type { SessionMessageState } from "@/utils/session-inspector";
import {
  applyAnthropicStyleStreamEvent,
  applyAssistantUserResultBranches,
  extractPrefixedRecord,
  extractSessionTitle,
  type StreamStateMaps,
  type StreamToolState,
  updateTool,
} from "@/agents/session-state/shared";

type KiloContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  thinking?: string;
};

export type KiloRawRecord = {
  type?: string;
  role?: string;
  timestamp?: number;
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  part?: {
    id?: string;
    sessionID?: string;
    messageID?: string;
    type?: string;
    callID?: string;
    tool?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    };
    text?: string;
    reason?: string;
  };
  message?: {
    content?: KiloContentBlock[];
  };
  content?: KiloContentBlock[] | string;
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
};

export type KiloInspectorToolState = StreamToolState;

export type KiloStreamStateMaps = StreamStateMaps<KiloInspectorToolState>;

function getContentBlocks(record: KiloRawRecord): KiloContentBlock[] {
  if (Array.isArray(record.message?.content)) return record.message?.content;
  if (Array.isArray(record.content)) return record.content as KiloContentBlock[];
  return [];
}

export function extractKiloRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): KiloRawRecord | null {
  return extractPrefixedRecord<KiloRawRecord>(type, "kilo.raw.", eventData, eventProps);
}

export function applyKiloRecordToState(
  state: SessionMessageState,
  record: KiloRawRecord,
  streamState: KiloStreamStateMaps
): void {
  const { textByIndex, thinkingByIndex, toolByIndex, toolById } = streamState;
  const sessionTitle = extractSessionTitle(record);
  if (sessionTitle) {
    state.sessionTitle = sessionTitle;
  }

  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
  const recordType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  const blocks = getContentBlocks(record);

  if (recordType === "text") {
    const text = typeof record.part?.text === "string" ? record.part.text.trim() : "";
    if (text) {
      state.currentText = text;
      state.phaseStatus = "Drafting response";
    }
    return;
  }

  if (recordType === "tool_use") {
    const toolName = record.part?.tool || "tool";
    const toolId = record.part?.callID || record.part?.id || `kilo-tool-${Date.now()}`;
    const toolState = record.part?.state || {};
    const status = typeof toolState.status === "string" ? toolState.status : "running";
    const tool: KiloInspectorToolState = {
      id: toolId,
      name: toolName,
      status: status === "completed" || status === "error" ? status : "running",
      input: toolState.input,
      output: toolState.output,
      title: toolState.title,
      metadata: toolState.metadata,
    };
    toolById.set(toolId, tool);
    updateTool(state, tool);
    state.phaseStatus = tool.title
      ? `${tool.status === "completed" ? "Finished tool" : "Running tool"}: ${tool.title}`
      : `${tool.status === "completed" ? "Finished tool" : "Running tool"}: ${toolName}`;
    return;
  }

  if (recordType === "step_start") {
    state.phaseStatus = "Thinking";
    return;
  }

  if (recordType === "step_finish") {
    state.phaseStatus = record.part?.reason ? "Working" : "Finished step";
    return;
  }

  const fallbackText = typeof record.content === "string" ? record.content.trim() : "";
  if (applyAssistantUserResultBranches({
    state,
    blocks,
    streamState: { toolById },
    toolPrefix: "kilo-tool",
    providerName: "Kilo",
    isError: record.is_error,
    assistant: record.type === "assistant" || role === "assistant",
    user: record.type === "user" || role === "tool",
    result: record.type === "result",
    beforeAssistant: (assistantBlocks) => {
      const text = assistantBlocks
        .filter((block) => block?.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      if (text || fallbackText) {
        state.currentText = text || fallbackText;
        state.phaseStatus = "Drafting response";
      }
    },
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
  }, "kilo-tool");
}
