import type { SessionMessageState, SessionTool } from "@/utils/session-inspector";
import {
  buildToolTitle,
  extractPrefixedRecord,
  tryParseObject,
  updateTool,
} from "@/agents/session-state/shared";

export type OpenHandsRawRecord = {
  type?: string;
  kind?: string;
  id?: string;
  source?: string;
  model?: string;
  prompt?: string;
  elapsedMs?: number;
  reasoning_content?: string | null;
  summary?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_call?: {
    id?: string;
    name?: string;
    arguments?: unknown;
  } | null;
  action?: {
    command?: string;
    path?: string;
    view_range?: number[] | null;
    kind?: string;
  } | null;
  observation?: {
    is_error?: boolean;
    content?: Array<{ type?: string; text?: string }> | string;
    path?: string;
  } | null;
  llm_message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }> | null;
  };
};

export function extractOpenHandsRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): OpenHandsRawRecord | null {
  return extractPrefixedRecord<OpenHandsRawRecord>(type, "openhands.raw.", eventData, eventProps);
}

function contentToText(content: Array<{ type?: string; text?: string }> | string | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function normalizeToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  return tryParseObject(value) ?? { content: value };
}

function compactStatus(value: string, maxLength = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function applyOpenHandsAction(
  state: SessionMessageState,
  record: OpenHandsRawRecord,
  toolById: Map<string, SessionTool>
): void {
  const toolId = record.tool_call_id || record.tool_call?.id || record.id || `openhands-tool-${Date.now()}`;
  const toolName = record.tool_name || record.tool_call?.name || record.action?.kind || "tool";
  const callInput = normalizeToolArguments(record.tool_call?.arguments);
  const input = {
    ...(callInput ?? {}),
    ...(record.action?.command ? { command: record.action.command } : {}),
    ...(record.action?.path ? { path: record.action.path } : {}),
    ...(record.summary ? { summary: record.summary } : {}),
  };
  if (record.reasoning_content?.trim()) {
    state.thinkingText = record.reasoning_content.trim();
  }
  const tool: SessionTool = {
    id: toolId,
    name: toolName,
    status: "running",
    input,
    title: buildToolTitle(toolName, input),
  };
  toolById.set(toolId, tool);
  updateTool(state, tool);
  state.phaseStatus = tool.title ? `Running tool: ${toolName} - ${tool.title}` : `Running tool: ${toolName}`;
}

function applyOpenHandsObservation(
  state: SessionMessageState,
  record: OpenHandsRawRecord,
  toolById: Map<string, SessionTool>
): void {
  const toolId = record.tool_call_id || "";
  if (!toolId) return;
  const existing = toolById.get(toolId);
  if (!existing) return;
  const isError = record.observation?.is_error === true;
  const output = contentToText(record.observation?.content);
  const updated: SessionTool = {
    ...existing,
    status: isError ? "error" : "completed",
    output: output || existing.output,
    error: isError ? output || "OpenHands tool failed" : existing.error,
  };
  toolById.set(toolId, updated);
  updateTool(state, updated);
  const detail = updated.title ? `${updated.name} - ${updated.title}` : updated.name;
  state.phaseStatus = `${isError ? "Tool failed" : "Finished tool"}: ${detail}`;
}

export function applyOpenHandsRecordToState(
  state: SessionMessageState,
  record: OpenHandsRawRecord,
  toolById: Map<string, SessionTool>
): void {
  if (record.type === "start") {
    if (record.model) state.model = record.model;
    state.phaseStatus = record.prompt
      ? `Starting task: ${compactStatus(record.prompt)}`
      : "Starting OpenHands";
    return;
  }

  if (record.type === "progress") {
    if (record.model) state.model = record.model;
    const elapsedSeconds = typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs)
      ? ` (${Math.max(1, Math.round(record.elapsedMs / 1000))}s)`
      : "";
    state.phaseStatus = record.prompt
      ? `Waiting for OpenHands output${elapsedSeconds}: ${compactStatus(record.prompt)}`
      : `Waiting for OpenHands output${elapsedSeconds}`;
    return;
  }

  if (record.kind === "SystemPromptEvent") {
    state.phaseStatus = "Preparing OpenHands context";
    return;
  }

  if (record.kind === "ActionEvent") {
    applyOpenHandsAction(state, record, toolById);
    return;
  }

  if (record.kind === "ObservationEvent") {
    applyOpenHandsObservation(state, record, toolById);
    return;
  }

  const role = record.llm_message?.role ?? "";
  const source = record.source ?? "";
  if (source === "user" || role === "user") {
    state.phaseStatus = "Thinking";
    return;
  }
  if (source === "agent" || role === "assistant") {
    const text = contentToText(record.llm_message?.content);
    if (text) {
      state.currentText = text;
      state.phaseStatus = "Drafting response";
    }
    for (const call of record.llm_message?.tool_calls ?? []) {
      const toolId = call.id || `openhands-tool-${Date.now()}`;
      const toolName = call.function?.name || "tool";
      const input = normalizeToolArguments(call.function?.arguments);
      const tool: SessionTool = {
        id: toolId,
        name: toolName,
        status: "running",
        input,
        title: buildToolTitle(toolName, input),
      };
      toolById.set(toolId, tool);
      updateTool(state, tool);
      state.phaseStatus = tool.title ? `Running tool: ${toolName} - ${tool.title}` : `Running tool: ${toolName}`;
    }
  }
}
