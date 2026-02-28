import type { SessionMessageState, SessionTool } from "@/utils/session-inspector";
import { extractPrefixedRecord, tryParseObject, updateTool } from "@/agents/session-state/shared";

type KimiToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

export type KimiRawRecord = {
  role?: string;
  tool_call_id?: string;
  content?: Array<{
    type?: string;
    text?: string;
    think?: string;
  }> | string;
  tool_calls?: KimiToolCall[];
};

function parseKimiArguments(input: unknown): Record<string, unknown> | undefined {
  if (!input) return undefined;
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== "string") return undefined;
  const parsed = tryParseObject(input);
  return parsed ?? { raw: input };
}

function mapKimiToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === "shell" || normalized === "bash") return "Bash";
  if (normalized === "readfile" || normalized === "read") return "Read";
  if (normalized === "globsearch" || normalized === "glob") return "Glob";
  if (normalized === "searchtext" || normalized === "grep") return "Grep";
  return name.trim() || "tool";
}

function kimiContentToText(content: KimiRawRecord["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.think === "string") return part.think;
      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n")
    .trim();
}

function getSystemMessages(text: string): string[] {
  if (!text) return [];
  const matches = [...text.matchAll(/<system>([\s\S]*?)<\/system>/gi)];
  return matches
    .map((match) => (match[1] ?? "").trim())
    .filter((value) => value.length > 0);
}

function inferKimiToolOutcome(output: string): { status: "completed" | "error"; error?: string } {
  const systemMessages = getSystemMessages(output);
  if (systemMessages.length > 0) {
    const joined = systemMessages.join("\n").trim();
    const hasExplicitFailure = /\b(command failed|execution failed|error:|exception|permission denied|not found|enoent)\b/i.test(joined);
    if (hasExplicitFailure) {
      return { status: "error", error: joined || "Tool failed" };
    }
    return { status: "completed" };
  }

  const trimmed = output.trim();
  if (/^(error|exception)\b[:\s-]/i.test(trimmed)) {
    return { status: "error", error: trimmed };
  }
  return { status: "completed" };
}

export function extractKimiRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): KimiRawRecord | null {
  return extractPrefixedRecord<KimiRawRecord>(type, "kimi.raw.", eventData, eventProps);
}

export function applyKimiRecordToState(
  state: SessionMessageState,
  record: KimiRawRecord,
  toolById: Map<string, SessionTool>
): void {
  const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";

  if (role === "assistant") {
    const content = Array.isArray(record.content) ? record.content : [];
    const thinkingText = content
      .filter((part) => part?.type === "think")
      .map((part) => (typeof part?.think === "string" ? part.think : ""))
      .join("")
      .trim();
    const responseText = typeof record.content === "string"
      ? record.content.trim()
      : content
          .filter((part) => part?.type === "text")
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim();

    if (thinkingText) {
      state.thinkingText = thinkingText;
      state.phaseStatus = "Thinking";
    }

    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    for (const call of toolCalls) {
      const toolId = typeof call?.id === "string" && call.id.trim()
        ? call.id.trim()
        : `kimi-tool-${Date.now()}`;
      const toolName = mapKimiToolName(typeof call?.function?.name === "string" ? call.function.name : "tool");
      const parsedInput = parseKimiArguments(call?.function?.arguments);
      const input = toolName === "Read" && parsedInput?.path && !parsedInput.filePath
        ? { ...parsedInput, filePath: parsedInput.path }
        : parsedInput;
      const existing = toolById.get(toolId);
      const tool: SessionTool = {
        id: toolId,
        name: toolName,
        status: existing?.status === "completed" || existing?.status === "error"
          ? existing.status
          : "running",
        input: input ?? existing?.input,
        output: existing?.output,
        error: existing?.error,
      };
      toolById.set(toolId, tool);
      updateTool(state, tool);
      if (tool.status === "running") {
        state.phaseStatus = `Running tool: ${toolName}`;
      }
    }

    if (responseText) {
      state.currentText = responseText;
      state.phaseStatus = "Drafting response";
    }
    return;
  }

  if (role === "tool") {
    const toolId = typeof record.tool_call_id === "string" ? record.tool_call_id.trim() : "";
    if (!toolId) return;
    const existing = toolById.get(toolId);
    if (!existing) return;

    const output = kimiContentToText(record.content);
    const outcome = inferKimiToolOutcome(output);
    const next: SessionTool = {
      ...existing,
      status: outcome.status,
      output: output || existing.output,
      error: outcome.status === "error" ? (outcome.error || output || "Tool failed") : undefined,
    };
    toolById.set(toolId, next);
    updateTool(state, next);
    state.phaseStatus = `${outcome.status === "error" ? "Tool failed" : "Finished tool"}: ${next.name}`;
  }
}
