import {
  applyClaudeRecordToState,
  extractClaudeRecord,
} from "@/agents/claude/session-state";
import { applyCodexRecordToState, extractCodexRecord } from "@/agents/codex/session-state";
import { applyKimiRecordToState, extractKimiRecord } from "@/agents/kimi/session-state";
import { applyKiloRecordToState, extractKiloRecord } from "@/agents/kilo/session-state";
import { applyQwenRecordToState, extractQwenRecord } from "@/agents/qwen/session-state";
import { applyGooseRecordToState, extractGooseRecord } from "@/agents/goose/session-state";
import { applyPiRecordToState, extractPiRecord } from "@/agents/pi/session-state";
import { applyOpenHandsRecordToState, extractOpenHandsRecord } from "@/agents/openhands/session-state";
import { applyCodeBuddyRecordToState, extractCodeBuddyRecord } from "@/agents/codebuddy/session-state";
import { applyCrushRecordToState, extractCrushRecord } from "@/agents/crush/session-state";
import {
  extractSessionTitle,
  type StreamStateMaps,
  type StreamToolState,
} from "@/agents/session-state/shared";
import type { AgentProviderId } from "@/shared/agent-provider";
import { getAgentProviderLabel } from "@/shared/agent-provider";

export type SessionEvent = {
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
};

export type SessionTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
};

export type SessionTool = {
  id: string;
  name: string;
  status: string;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type SessionTodo = {
  content: string;
  status: string;
};

export type SessionMessageState = {
  sessionTitle?: string;
  phaseStatus?: string;
  thinkingText?: string;
  model?: string;
  agent?: string;
  tokenUsage?: SessionTokenUsage;
  currentText: string;
  tools: SessionTool[];
  todos: SessionTodo[];
  startedAt: number;
};

export type SessionStateOptions = {
  workingDirectory?: string;
  endIndex?: number;
  baseState?: Partial<SessionMessageState>;
  provider?: AgentProviderId;
};

type ProviderParser = {
  extract: (
    type: string,
    eventData: Record<string, unknown>,
    eventProps: Record<string, unknown>
  ) => unknown | null;
  apply: (record: unknown, timestamp: number) => void;
};

function applySessionUpdatedEvent(state: SessionMessageState, eventProps: Record<string, unknown>): void {
  const sessionTitle = extractSessionTitle(eventProps);
  if (!sessionTitle) return;
  state.sessionTitle = sessionTitle;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractModelCandidate(value: unknown): string | undefined {
  if (!value) return undefined;

  const direct = asNonEmptyString(value);
  if (direct) return direct;

  const record = asRecord(value);
  if (!record) return undefined;

  const modelId =
    asNonEmptyString(record.modelID)
    ?? asNonEmptyString(record.modelId)
    ?? asNonEmptyString(record.model_id)
    ?? asNonEmptyString(record.id)
    ?? asNonEmptyString(record.name)
    ?? asNonEmptyString(record.model);
  if (modelId) return modelId;

  const nested = asRecord(record.model);
  if (nested) {
    const nestedModel = extractModelCandidate(nested);
    if (nestedModel) return nestedModel;
  }

  return undefined;
}

function extractAgentCandidate(value: unknown): string | undefined {
  if (!value) return undefined;
  const record = asRecord(value);
  if (!record) return asNonEmptyString(value);

  return asNonEmptyString(record.agent)
    ?? asNonEmptyString(record.agentName)
    ?? asNonEmptyString(record.agent_name)
    ?? asNonEmptyString(record.mode)
    ?? asNonEmptyString(record.assistant)
    ?? asNonEmptyString(record.agentType)
    ?? asNonEmptyString(record.agent_type);
}

function extractTokenUsage(value: unknown, fallbackCost?: unknown): SessionTokenUsage | undefined {
  const tokens = asRecord(value);
  if (!tokens) return undefined;

  const cacheContainer =
    asRecord(tokens.cache)
    ?? asRecord(tokens.cache_tokens)
    ?? asRecord(tokens.cacheTokens)
    ?? asRecord(tokens.cached_tokens)
    ?? asRecord(tokens.cachedTokens)
    ?? asRecord(tokens.cache_usage)
    ?? asRecord(tokens.cacheUsage);

  const hasTokenSignal = [
    tokens.input,
    tokens.input_tokens,
    tokens.inputTokens,
    tokens.prompt_tokens,
    tokens.promptTokens,
    tokens.output,
    tokens.output_tokens,
    tokens.outputTokens,
    tokens.completion_tokens,
    tokens.completionTokens,
    tokens.reasoning,
    tokens.reasoning_tokens,
    tokens.reasoningTokens,
    tokens.thinking_tokens,
    tokens.thinkingTokens,
    tokens.total,
    tokens.total_tokens,
    tokens.totalTokens,
    cacheContainer?.read,
    cacheContainer?.write,
    cacheContainer?.input_tokens,
    cacheContainer?.inputTokens,
    cacheContainer?.output_tokens,
    cacheContainer?.outputTokens,
  ].some((entry) => entry !== undefined && entry !== null);
  if (!hasTokenSignal) return undefined;

  const input =
    asNumber(tokens.input)
    ?? asNumber(tokens.input_tokens)
    ?? asNumber(tokens.inputTokens)
    ?? asNumber(tokens.prompt_tokens)
    ?? asNumber(tokens.promptTokens)
    ?? 0;
  const output =
    asNumber(tokens.output)
    ?? asNumber(tokens.output_tokens)
    ?? asNumber(tokens.outputTokens)
    ?? asNumber(tokens.completion_tokens)
    ?? asNumber(tokens.completionTokens)
    ?? 0;
  const reasoning =
    asNumber(tokens.reasoning)
    ?? asNumber(tokens.reasoning_tokens)
    ?? asNumber(tokens.reasoningTokens)
    ?? asNumber(tokens.thinking_tokens)
    ?? asNumber(tokens.thinkingTokens)
    ?? 0;
  const cacheRead =
    asNumber(cacheContainer?.read)
    ?? asNumber(cacheContainer?.input_tokens)
    ?? asNumber(cacheContainer?.inputTokens)
    ?? 0;
  const cacheWrite =
    asNumber(cacheContainer?.write)
    ?? asNumber(cacheContainer?.output_tokens)
    ?? asNumber(cacheContainer?.outputTokens)
    ?? 0;
  const reportedTotal =
    asNumber(tokens.total)
    ?? asNumber(tokens.total_tokens)
    ?? asNumber(tokens.totalTokens);
  const total = typeof reportedTotal === "number" && Number.isFinite(reportedTotal)
    ? reportedTotal
    : input + output + reasoning + cacheRead + cacheWrite;
  const cost =
    asNumber(tokens.cost)
    ?? asNumber(tokens.total_cost)
    ?? asNumber(tokens.totalCost)
    ?? asNumber(fallbackCost);

  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total,
    cost,
  };
}

function applyMetadataFromRecord(
  state: SessionMessageState,
  source: unknown,
  provider?: AgentProviderId
): void {
  const record = asRecord(source);
  if (!record) return;
  const part = asRecord(record.part);
  const event = asRecord(record.event);

  const modelCandidate =
    extractModelCandidate(record.modelID)
    ?? extractModelCandidate(record.modelId)
    ?? extractModelCandidate(record.model_id)
    ?? extractModelCandidate(record.model)
    ?? extractModelCandidate(record.modelInfo)
    ?? extractModelCandidate(record.model_info)
    ?? extractModelCandidate(part?.model)
    ?? extractModelCandidate(event?.model)
    ?? extractModelCandidate(event?.properties);
  if (modelCandidate) {
    state.model = modelCandidate;
  }

  const agentCandidate =
    extractAgentCandidate(record)
    ?? extractAgentCandidate(record.info)
    ?? extractAgentCandidate(record.message)
    ?? extractAgentCandidate(part)
    ?? extractAgentCandidate(event)
    ?? extractAgentCandidate(event?.properties);
  if (agentCandidate) {
    state.agent = agentCandidate;
  }

  const tokenUsage =
    extractTokenUsage(record.tokens, record.cost)
    ?? extractTokenUsage(record.tokenUsage, record.cost)
    ?? extractTokenUsage(record.token_usage, record.cost)
    ?? extractTokenUsage(record.usage, record.cost)
    ?? extractTokenUsage(record.usage_metadata, record.cost)
    ?? extractTokenUsage(record.metadata, record.cost)
    ?? extractTokenUsage(part?.tokens, part?.cost)
    ?? extractTokenUsage(event?.usage, record.cost)
    ?? extractTokenUsage(asRecord(event?.properties)?.usage, record.cost)
    ?? extractTokenUsage(record.message, record.cost)
    ?? extractTokenUsage(record.info, record.cost);
  if (tokenUsage) {
    const currentTotal = state.tokenUsage?.total ?? 0;
    const shouldApply = provider === "claudecode"
      ? currentTotal <= 0 || tokenUsage.total >= currentTotal
      : tokenUsage.total > 0 || currentTotal <= 0;
    if (shouldApply) {
      state.tokenUsage = tokenUsage;
    }
  }
}

function extractMessageInfo(eventProps: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = asRecord(eventProps.info);
  if (direct) return direct;

  const message = asRecord(eventProps.message);
  if (!message) return undefined;

  const nestedInfo = asRecord(message.info);
  if (nestedInfo) return nestedInfo;
  return message;
}

function applyMessageUpdatedEvent(
  state: SessionMessageState,
  eventProps: Record<string, unknown>,
  messageRoles?: Map<string, string>,
  provider?: AgentProviderId
): void {
  const info = extractMessageInfo(eventProps);
  if (!info) return;

  if (messageRoles) {
    const messageId = typeof info.id === "string" ? info.id : undefined;
    const role = typeof info.role === "string" ? info.role : undefined;
    if (messageId && role) {
      messageRoles.set(messageId, role);
    }
  }

  applyMetadataFromRecord(state, info, provider);
}

function isOpencodeThinkingStatusWithContent(status: string): boolean {
  if (!status.startsWith("Thinking:")) return false;
  return status.slice("Thinking:".length).trim().length > 0;
}

function updatePhaseStatus(
  state: SessionMessageState,
  nextStatus: string | undefined,
  provider?: AgentProviderId
): void {
  if (!nextStatus) return;
  if (provider === "opencode") {
    if (isOpencodeThinkingStatusWithContent(nextStatus)) {
      state.phaseStatus = nextStatus;
    }
    return;
  }
  state.phaseStatus = nextStatus;
}

function applySessionStatusEvent(
  state: SessionMessageState,
  eventProps: Record<string, unknown>,
  provider?: AgentProviderId
): void {
  const statusValue = (eventProps as { status?: unknown }).status;
  const formattedStatus = formatSessionStatus(statusValue);
  if (!formattedStatus) return;
  if (
    formattedStatus === "Working"
    && state.phaseStatus
    && state.phaseStatus !== "Working"
    && state.phaseStatus !== "Waiting"
  ) {
    return;
  }
  updatePhaseStatus(state, formattedStatus, provider);
}

function normalizeReasoningStatus(text: string): string {
  const compact = text
    .replace(/[*_`#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "Thinking";
  const maxLength = 90;
  const truncated = compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
  return `Thinking: ${truncated}`;
}

function applyMessagePartUpdatedEvent(
  state: SessionMessageState,
  eventProps: Record<string, unknown>,
  provider?: AgentProviderId,
  messageRoles?: Map<string, string>
): void {
  const part = (eventProps as { part?: Record<string, unknown> }).part;
  if (!part) return;
  const isSessionScopedPart = typeof part.sessionID === "string";

  // Skip parts that belong to a user message (user prompt TextParts in
  // OpenCode must not be treated as assistant output). If we don't yet
  // know the role for this messageID we fall through; tool parts and
  // assistant messages will still be applied, and any later
  // message.updated event will correct the mapping for subsequent parts.
  const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
  const role = messageId && messageRoles ? messageRoles.get(messageId) : undefined;
  const isUserMessagePart = role === "user";

  if (part.type === "tool") {
    const toolState = (part.state || {}) as Record<string, unknown>;
    const toolTime = asRecord(toolState.time);
    const eventContext = asRecord(eventProps.odeContext);
    const rawMetadata = asRecord(toolState.metadata) ?? {};
    const metadata: Record<string, unknown> = {
      ...rawMetadata,
      ...(typeof toolTime?.start === "number" ? { startedAtMs: toolTime.start } : {}),
      ...(typeof eventContext?.sourceSessionID === "string"
        ? { sourceSessionId: eventContext.sourceSessionID }
        : {}),
      ...(eventContext?.childSession === true ? { childSession: true } : {}),
      ...(typeof eventContext?.childTitle === "string"
        ? { childTitle: eventContext.childTitle }
        : {}),
    };
    const existingIdx = state.tools.findIndex((t) => t.id === part.id);
    const toolInfo: SessionTool = {
      id: typeof part.id === "string" ? part.id : "unknown-tool",
      name: typeof part.tool === "string" ? part.tool : "Unknown tool",
      status: typeof toolState.status === "string" ? toolState.status : "pending",
      title: typeof toolState.title === "string" ? toolState.title : undefined,
      input: toolState.input && typeof toolState.input === "object"
        ? toolState.input as Record<string, unknown>
        : undefined,
      output: typeof toolState.output === "string" ? toolState.output : undefined,
      error: typeof toolState.error === "string" ? toolState.error : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    if (existingIdx >= 0) {
      state.tools[existingIdx] = toolInfo;
    } else {
      state.tools.push(toolInfo);
    }

    if (!isSessionScopedPart) {
      return;
    }

    if (toolInfo.name.trim().toLowerCase() === "subagent") {
      const title = toolInfo.title?.trim();
      const progress = typeof toolInfo.metadata?.progress === "string"
        ? toolInfo.metadata.progress.trim()
        : typeof toolInfo.metadata?.lastTool === "string"
          ? toolInfo.metadata.lastTool.trim()
          : "";
      const label = title ? `: ${title}${progress ? ` — ${progress}` : ""}` : "";
      if (toolInfo.status === "running" || toolInfo.status === "pending") {
        updatePhaseStatus(state, `Running subagent${label}`, provider);
      } else if (toolInfo.status === "completed") {
        updatePhaseStatus(state, `Finished subagent${title ? `: ${title}` : ""}`, provider);
      } else if (toolInfo.status === "error") {
        updatePhaseStatus(state, `Subagent failed${title ? `: ${title}` : ""}`, provider);
      }
      return;
    }

    if (toolInfo.status === "running" || toolInfo.status === "pending") {
      updatePhaseStatus(state, `Running tool: ${toolInfo.name}`, provider);
    } else if (toolInfo.status === "completed") {
      updatePhaseStatus(state, `Finished tool: ${toolInfo.name}`, provider);
    } else if (toolInfo.status === "error") {
      updatePhaseStatus(state, `Tool failed: ${toolInfo.name}`, provider);
    }
    return;
  }

  if (part.type === "text" && typeof part.text === "string") {
    if (isUserMessagePart) {
      return;
    }
    state.currentText = part.text;
    if (isSessionScopedPart) {
      updatePhaseStatus(state, "Drafting response", provider);
    }
    return;
  }

  if (part.type === "reasoning" && typeof part.text === "string") {
    if (isUserMessagePart) {
      return;
    }
    state.thinkingText = part.text;
    if (isSessionScopedPart) {
      updatePhaseStatus(state, normalizeReasoningStatus(part.text), provider);
    }
    return;
  }

  if (part.type === "thinking" && typeof part.text === "string") {
    if (isUserMessagePart) {
      return;
    }
    state.thinkingText = part.text;
    if (isSessionScopedPart) {
      updatePhaseStatus(state, normalizeReasoningStatus(part.text), provider);
    }
  }
}

function applyTodoUpdatedEvent(state: SessionMessageState, eventProps: Record<string, unknown>): void {
  const listCandidate = (eventProps as { todos?: unknown; items?: unknown; tasks?: unknown }).todos
    ?? (eventProps as { items?: unknown }).items
    ?? (eventProps as { tasks?: unknown }).tasks;
  const todoList = Array.isArray(listCandidate) ? listCandidate : [];
  state.todos = todoList
    .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object" && !Array.isArray(todo))
    .map((todo) => ({
      content: typeof (todo.content ?? todo.text ?? todo.title ?? todo.task) === "string"
        ? String(todo.content ?? todo.text ?? todo.title ?? todo.task).trim()
        : "",
      status: typeof todo.status === "string" && todo.status.trim()
        ? todo.status.trim().replace(/\s+/g, "_")
        : "pending",
    }))
    .filter((todo) => todo.content.length > 0);
}

function unwrapEventData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const payload = record.payload;
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return record;
}

function getEventProperties(data: Record<string, unknown>): Record<string, unknown> {
  const properties = data.properties;
  if (properties && typeof properties === "object") {
    return properties as Record<string, unknown>;
  }
  return data;
}

function formatSessionStatus(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const status = value as {
    type?: string;
    message?: string;
    next?: number;
  };

  switch (status.type) {
    case "busy":
      if (typeof status.message === "string" && status.message.trim()) {
        return status.message.trim();
      }
      return "Working";
    case "idle":
      return "Waiting";
    case "retry": {
      const base = typeof status.message === "string" && status.message.trim()
        ? `Retrying: ${status.message.trim()}`
        : "Retrying";
      const seconds = typeof status.next === "number"
        ? Math.max(0, Math.ceil((status.next - Date.now()) / 1000))
        : undefined;
      return seconds !== undefined ? `${base} in ${seconds}s` : base;
    }
    default:
      return undefined;
  }
}

export function buildSessionMessageState(
  events: SessionEvent[],
  options: SessionStateOptions = {}
): SessionMessageState {
  const { endIndex, baseState, provider } = options;
  const startTime = events[0]?.timestamp ?? Date.now();
  const state: SessionMessageState = {
    sessionTitle: baseState?.sessionTitle,
    phaseStatus: baseState?.phaseStatus,
    thinkingText: baseState?.thinkingText,
    model: baseState?.model,
    agent: baseState?.agent,
    tokenUsage: baseState?.tokenUsage,
    currentText: baseState?.currentText ?? "",
    tools: baseState?.tools ? [...baseState.tools] : [],
    todos: baseState?.todos ? [...baseState.todos] : [],
    startedAt: baseState?.startedAt ?? startTime,
  };

  const relevantEvents =
    typeof endIndex === "number" ? events.slice(0, endIndex + 1) : events;

  const sharedStreamState: StreamStateMaps<StreamToolState> = {
    textByIndex: new Map<number, string>(),
    thinkingByIndex: new Map<number, string>(),
    toolByIndex: new Map<number, StreamToolState>(),
    toolById: new Map<string, StreamToolState>(),
  };
  const codexToolById = new Map<string, SessionTool>();
  const kimiToolById = new Map<string, SessionTool>();
  const kiloToolById = new Map<string, SessionTool>();
  const openHandsToolById = new Map<string, SessionTool>();
  // Map of messageID -> role ("user" | "assistant" | ...) built from
  // `message.updated` events. Used to avoid treating user prompt TextParts
  // as assistant output (OpenCode emits TextPart for both roles and
  // TextPart itself does not carry a role field).
  const messageRoles = new Map<string, string>();
  const kiloStreamState: StreamStateMaps<StreamToolState> = {
    textByIndex: sharedStreamState.textByIndex,
    thinkingByIndex: sharedStreamState.thinkingByIndex,
    toolByIndex: sharedStreamState.toolByIndex,
    toolById: kiloToolById,
  };

  for (const existingTool of state.tools) {
    sharedStreamState.toolById.set(existingTool.id, { ...existingTool });
    codexToolById.set(existingTool.id, { ...existingTool });
    kimiToolById.set(existingTool.id, { ...existingTool });
    kiloToolById.set(existingTool.id, { ...existingTool });
    openHandsToolById.set(existingTool.id, { ...existingTool });
  }

  const providerParsers: ProviderParser[] = [
    {
      extract: extractClaudeRecord,
      apply: (record, timestamp) => {
        applyClaudeRecordToState(
          state,
          record as Parameters<typeof applyClaudeRecordToState>[1],
          sharedStreamState,
          timestamp
        );
      },
    },
    {
      extract: extractCodexRecord,
      apply: (record) => {
        applyCodexRecordToState(state, record as Parameters<typeof applyCodexRecordToState>[1], codexToolById);
      },
    },
    {
      extract: extractKimiRecord,
      apply: (record) => {
        applyKimiRecordToState(state, record as Parameters<typeof applyKimiRecordToState>[1], kimiToolById);
      },
    },
    {
      extract: extractKiloRecord,
      apply: (record) => {
        applyKiloRecordToState(state, record as Parameters<typeof applyKiloRecordToState>[1], kiloStreamState);
      },
    },
    {
      extract: extractQwenRecord,
      apply: (record) => {
        applyQwenRecordToState(state, record as Parameters<typeof applyQwenRecordToState>[1], sharedStreamState);
      },
    },
    {
      extract: extractGooseRecord,
      apply: (record) => {
        applyGooseRecordToState(state, record as Parameters<typeof applyGooseRecordToState>[1], sharedStreamState);
      },
    },
    {
      extract: extractPiRecord,
      apply: (record) => {
        applyPiRecordToState(state, record as Parameters<typeof applyPiRecordToState>[1], sharedStreamState);
      },
    },
    {
      extract: extractOpenHandsRecord,
      apply: (record) => {
        applyOpenHandsRecordToState(state, record as Parameters<typeof applyOpenHandsRecordToState>[1], openHandsToolById);
      },
    },
    {
      extract: extractCodeBuddyRecord,
      apply: (record) => {
        applyCodeBuddyRecordToState(state, record as Parameters<typeof applyCodeBuddyRecordToState>[1], sharedStreamState);
      },
    },
    {
      extract: extractCrushRecord,
      apply: (record) => {
        applyCrushRecordToState(state, record as Parameters<typeof applyCrushRecordToState>[1]);
      },
    },
  ];

  for (const event of relevantEvents) {
    const eventData = unwrapEventData(event.data);
    const eventProps = getEventProperties(eventData);
    const type = event.type;

    applyMetadataFromRecord(state, eventData, provider);
    applyMetadataFromRecord(state, eventProps, provider);
    applyMetadataFromRecord(state, eventProps.record, provider);
    applyMetadataFromRecord(state, eventProps.message, provider);
    applyMetadataFromRecord(state, eventProps.info, provider);
    applyMetadataFromRecord(state, eventProps.part, provider);
    applyMetadataFromRecord(state, eventProps.event, provider);

    if (eventProps.protocolKnown === false) {
      const protocolLabel = asNonEmptyString(eventProps.protocolLabel)
        ?? asNonEmptyString(eventProps.streamEventType)
        ?? asNonEmptyString(eventProps.recordType)
        ?? type;
      const providerLabel = provider ? getAgentProviderLabel(provider) : "Coding CLI";
      state.phaseStatus = `${providerLabel} integration update required: ${protocolLabel}`;
      continue;
    }

    let handledByProvider = false;
    for (const parser of providerParsers) {
      const record = parser.extract(type, eventData, eventProps);
      if (!record) continue;
      parser.apply(record, event.timestamp);
      handledByProvider = true;
      break;
    }
    if (handledByProvider) {
      continue;
    }

    if (type === "session.updated") {
      applySessionUpdatedEvent(state, eventProps);
    }

    if (type === "message.updated") {
      applyMessageUpdatedEvent(state, eventProps, messageRoles, provider);
    }

    if (type === "session.status") {
      applySessionStatusEvent(state, eventProps, provider);
    }

    if (type === "message.part.updated") {
      applyMessagePartUpdatedEvent(state, eventProps, provider, messageRoles);
    }

    if (type === "todo.updated") {
      applyTodoUpdatedEvent(state, eventProps);
    }
  }

  return state;
}
