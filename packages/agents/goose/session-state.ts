import type { SessionMessageState, SessionTodo } from "@/utils/session-inspector";
import {
  applyAnthropicStyleStreamEvent,
  applyAssistantUserResultBranches,
  extractPrefixedRecord,
  parseTodosFromToolInput,
  extractSessionTitle,
  tryParseObject,
  type StreamStateMaps,
  type StreamToolState,
  updateTool,
} from "@/agents/session-state/shared";

export type GooseRawRecord = {
  type?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  message?: {
    id?: string;
    role?: string;
    created?: number;
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
      toolCall?: {
        status?: string;
        value?: {
          name?: string;
          arguments?: unknown;
        };
      };
      toolResult?: {
        status?: string;
        value?: {
          content?: Array<{ type?: string; text?: string }>;
          isError?: boolean;
        };
      };
    }>;
  };
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
};

export type GooseInspectorToolState = StreamToolState;

export type GooseStreamStateMaps = StreamStateMaps<GooseInspectorToolState>;

function resolveGooseToolResponseId(block: {
  id?: string;
  tool_use_id?: string;
}): string {
  if (typeof block.id === "string" && block.id.trim()) {
    return block.id;
  }
  if (typeof block.tool_use_id === "string" && block.tool_use_id.trim()) {
    return block.tool_use_id;
  }
  return "";
}

function extractGooseToolResponseText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const record = entry as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string") {
        return record.text;
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function parseTodosFromGooseToolInput(toolName: string, input: Record<string, unknown> | undefined): SessionTodo[] | undefined {
  const direct = parseTodosFromToolInput(toolName, input);
  if (direct) return direct;
  const content = typeof input?.content === "string" ? input.content : "";
  if (!content) return undefined;
  const parsed = tryParseObject(content);
  return parsed ? parseTodosFromToolInput(toolName, parsed) : undefined;
}

export function extractGooseRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): GooseRawRecord | null {
  return extractPrefixedRecord<GooseRawRecord>(type, "goose.raw.", eventData, eventProps);
}

export function applyGooseRecordToState(
  state: SessionMessageState,
  record: GooseRawRecord,
  streamState: GooseStreamStateMaps
): void {
  const { textByIndex, thinkingByIndex, toolByIndex, toolById } = streamState;
  const blocks = record.message?.content ?? [];
  const sessionTitle = extractSessionTitle(record);
  if (sessionTitle) {
    state.sessionTitle = sessionTitle;
  }

  if (record.type === "complete") {
    state.phaseStatus = "Waiting";
    return;
  }

  if (record.type === "message") {
    const role = typeof record.message?.role === "string" ? record.message.role : "";
    const blocks = record.message?.content ?? [];

    if (role === "assistant") {
      const messageCreatedAtMs = typeof record.message?.created === "number"
        ? record.message.created * 1000
        : Date.now();
      for (const block of blocks) {
        if (block?.type === "text") {
          const chunk = typeof block.text === "string" ? block.text : "";
          if (!chunk) continue;
          const next = `${textByIndex.get(-1) ?? ""}${chunk}`;
          textByIndex.set(-1, next);
          state.currentText = next;
          state.phaseStatus = "Drafting response";
          continue;
        }

        if (block?.type !== "toolRequest") continue;

        const call = block.toolCall?.value;
        const toolName = typeof call?.name === "string" && call.name.trim()
          ? call.name
          : "tool";
        const callId = typeof block.id === "string" && block.id.trim()
          ? block.id
          : `goose-tool-${Date.now()}`;
        const rawArgs = call?.arguments;
        const input = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
          ? rawArgs as Record<string, unknown>
          : typeof rawArgs === "string"
            ? { content: rawArgs }
            : undefined;
        const parsedTodos = parseTodosFromGooseToolInput(toolName, input);
        if (parsedTodos) {
          state.todos = parsedTodos;
        }
        const existing = toolById.get(callId);
        textByIndex.delete(-1);
        state.currentText = "";
        const tool: GooseInspectorToolState = {
          id: callId,
          name: toolName,
          status: "running",
          input: input ?? existing?.input,
          output: existing?.output,
          error: existing?.error,
          title: existing?.title,
          metadata: {
            ...(existing?.metadata ?? {}),
            startedAtMs: typeof existing?.metadata?.startedAtMs === "number"
              ? existing.metadata.startedAtMs
              : messageCreatedAtMs,
          },
        };
        toolById.set(callId, tool);
        updateTool(state, tool);
        state.phaseStatus = `Running tool: ${toolName}`;
      }
      return;
    }

    if (role === "user") {
      for (const block of blocks) {
        if (block?.type !== "toolResponse") continue;
        const callId = resolveGooseToolResponseId(block);
        if (!callId) continue;
        const existing = toolById.get(callId);
        if (!existing) continue;
        const result = block.toolResult?.value;
        const output = extractGooseToolResponseText(result?.content);
        const hasError = result?.isError === true || block.toolResult?.status === "error";
        const updated: GooseInspectorToolState = {
          ...existing,
          status: hasError ? "error" : "completed",
          output: output || existing.output,
          error: hasError ? output || "Tool execution failed" : undefined,
        };
        toolById.set(callId, updated);
        updateTool(state, updated);
        state.phaseStatus = `${hasError ? "Tool failed" : "Finished tool"}: ${updated.name}`;
      }
      return;
    }
  }

  if (applyAssistantUserResultBranches({
    state,
    blocks,
    streamState: { toolById },
    toolPrefix: "goose-tool",
    providerName: "Goose",
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

  if (record.event?.type === "content_block_start" && record.event.content_block?.type === "tool_use") {
    const block = record.event.content_block;
    const toolName = typeof block.name === "string" ? block.name : "";
    const input = block.input && typeof block.input === "object" && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : undefined;
    const parsedTodos = parseTodosFromGooseToolInput(toolName, input);
    if (parsedTodos) {
      state.todos = parsedTodos;
    }
  }

  applyAnthropicStyleStreamEvent(state, record, {
    textByIndex,
    thinkingByIndex,
    toolByIndex,
    toolById,
  }, "goose-tool");
}
