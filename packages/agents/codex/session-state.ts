import type { SessionMessageState, SessionTool } from "@/utils/session-inspector";
import { updateTool } from "@/agents/session-state/shared";

export type CodexRawRecord = {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

export function extractCodexRecord(
  type: string,
  eventData: Record<string, unknown>,
  eventProps: Record<string, unknown>
): CodexRawRecord | null {
  if (!type.startsWith("codex.raw.")) return null;
  const candidate = eventProps.event ?? eventData.event;
  if (!candidate || typeof candidate !== "object") return null;
  return candidate as CodexRawRecord;
}

export function applyCodexRecordToState(
  state: SessionMessageState,
  record: CodexRawRecord,
  toolById: Map<string, SessionTool>
): void {
  const item = record.item;
  const eventType = typeof record.type === "string" ? record.type : "";

  if (eventType === "thread.started") {
    state.phaseStatus = "Thinking";
    return;
  }

  if (eventType === "turn.started") {
    state.phaseStatus = "Thinking";
    return;
  }

  if (eventType === "turn.completed") {
    const input = Number(record.usage?.input_tokens ?? 0) || 0;
    const output = Number(record.usage?.output_tokens ?? 0) || 0;
    state.tokenUsage = {
      input,
      output,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: input + output,
    };
    if (!state.phaseStatus || state.phaseStatus === "Thinking") {
      state.phaseStatus = "Finalizing response";
    }
    return;
  }

  if (eventType === "error") {
    const message = typeof record.error?.message === "string" ? record.error.message.trim() : "";
    state.phaseStatus = message ? `Codex error: ${message}` : "Codex reported an error";
    return;
  }

  if (!item || typeof item !== "object") return;
  const itemType = typeof item.type === "string" ? item.type : "";
  const itemId = typeof item.id === "string" && item.id.trim()
    ? item.id.trim()
    : `codex-item-${Date.now()}`;

  if (itemType === "reasoning") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text) {
      state.thinkingText = text;
    }
    state.phaseStatus = "Thinking";
    return;
  }

  if (itemType === "command_execution") {
    const command = typeof item.command === "string" ? item.command.trim() : "";
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : undefined;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    const itemStatus = typeof item.status === "string" ? item.status : undefined;

    const existing = toolById.get(itemId);
    const nextStatus = itemStatus === "in_progress"
      ? "running"
      : exitCode === undefined || exitCode === 0
        ? "completed"
        : "error";

    const tool: SessionTool = {
      id: itemId,
      name: "Bash",
      status: nextStatus,
      input: command ? { command } : existing?.input,
      output: output ?? existing?.output,
      error: nextStatus === "error"
        ? output || (typeof exitCode === "number" ? `Command failed with exit code ${exitCode}` : "Command failed")
        : existing?.error,
    };
    toolById.set(itemId, tool);
    updateTool(state, tool);

    if (nextStatus === "running") {
      state.phaseStatus = "Running tool: Bash";
    } else if (nextStatus === "error") {
      state.phaseStatus = "Tool failed: Bash";
    } else {
      state.phaseStatus = "Finished tool: Bash";
    }
    return;
  }

  if (itemType === "agent_message") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text) {
      state.currentText = text;
      state.phaseStatus = "Drafting response";
    }
  }
}
