import { randomUUID } from "node:crypto";
import type { AgentProviderId } from "@/shared/agent-provider";
import {
  ODE_RUN_EVENT_SCHEMA_VERSION,
  type OdeRunEvent,
  type OdeRunEventType,
} from "@/shared/agent-protocol";
import type { SessionMessageState } from "@/utils/session-inspector";

type EventContext = {
  providerId: AgentProviderId;
  sessionId: string;
  runId?: string;
  timestamp?: number;
};

export function createOdeRunEvent(
  context: EventContext,
  type: OdeRunEventType,
  data: Record<string, unknown>,
  options: { itemId?: string; rawEvent?: Record<string, unknown> } = {}
): OdeRunEvent {
  return {
    id: randomUUID(),
    schemaVersion: ODE_RUN_EVENT_SCHEMA_VERSION,
    timestamp: context.timestamp ?? Date.now(),
    type,
    providerId: context.providerId,
    sessionId: context.sessionId,
    runId: context.runId,
    itemId: options.itemId,
    data,
    rawEvent: options.rawEvent,
  };
}

export function deriveOdeRunEventsFromState(params: {
  previous?: SessionMessageState;
  next: SessionMessageState;
  context: EventContext;
}): OdeRunEvent[] {
  const { previous, next, context } = params;
  const events: OdeRunEvent[] = [];
  if (next.phaseStatus && next.phaseStatus !== previous?.phaseStatus) {
    events.push(createOdeRunEvent(context, "run.progress", { phase: next.phaseStatus }));
  }
  if (next.thinkingText && next.thinkingText !== previous?.thinkingText) {
    events.push(createOdeRunEvent(context, "reasoning.summary.delta", {
      text: next.thinkingText,
      snapshot: true,
    }));
  }
  if (next.currentText && next.currentText !== previous?.currentText) {
    events.push(createOdeRunEvent(context, "message.delta", {
      text: next.currentText,
      snapshot: true,
    }));
  }

  const previousTools = new Map((previous?.tools ?? []).map((tool) => [tool.id, tool]));
  for (const tool of next.tools) {
    const old = previousTools.get(tool.id);
    if (old && JSON.stringify(old) === JSON.stringify(tool)) continue;
    const type = tool.status === "error"
      ? "tool.failed"
      : tool.status === "completed"
        ? "tool.completed"
        : old
          ? "tool.progress"
          : "tool.started";
    events.push(createOdeRunEvent(context, type, {
      name: tool.name,
      title: tool.title,
      status: tool.status,
      input: tool.input,
      output: tool.output,
      error: tool.error,
      metadata: tool.metadata,
    }, { itemId: tool.id }));
  }

  if (JSON.stringify(next.todos) !== JSON.stringify(previous?.todos ?? [])) {
    events.push(createOdeRunEvent(context, "plan.updated", {
      items: next.todos.map((todo) => ({ content: todo.content, status: todo.status })),
    }));
  }
  if (next.tokenUsage && JSON.stringify(next.tokenUsage) !== JSON.stringify(previous?.tokenUsage)) {
    events.push(createOdeRunEvent(context, "usage.updated", { ...next.tokenUsage }));
  }
  return events;
}
