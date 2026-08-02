type UnknownRecord = Record<string, any>;

export type CodexAppSessionEvent = {
  type: string;
  properties: Record<string, unknown>;
};

type CodexSubagentState = {
  threadId: string;
  title?: string;
  agentPath?: string;
  startedAtMs: number;
  lastTool?: string;
  status: "running" | "completed" | "error";
};

export type CodexAppEventState = {
  rootThreadId?: string;
  textSnapshots: Map<string, string>;
  reasoningSnapshots: Map<string, string>;
  planSnapshots: Map<string, string>;
  toolItems: Map<string, UnknownRecord>;
  toolOutputs: Map<string, string>;
  subagents: Map<string, CodexSubagentState>;
};

export function createCodexAppEventState(): CodexAppEventState {
  return {
    textSnapshots: new Map(),
    reasoningSnapshots: new Map(),
    planSnapshots: new Map(),
    toolItems: new Map(),
    toolOutputs: new Map(),
    subagents: new Map(),
  };
}

const KNOWN_NOTIFICATION_METHODS = new Set([
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/closed",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/settings/updated",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "turn/moderationMetadata",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "serverRequest/resolved",
  "rawResponseItem/completed",
  "rawResponse/completed",
  "hook/started",
  "hook/completed",
  "model/rerouted",
  "model/verification",
  "model/safetyBuffering/updated",
  "warning",
  "guardianWarning",
  "deprecationNotice",
  "configWarning",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "account/login/completed",
  "app/list/updated",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "skills/changed",
  "fs/changed",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "ode/question/requested",
  "ode/serverRequest/declined",
  "ode/serverRequest/failed",
]);

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compact(value: unknown, limit = 120): string | undefined {
  const text = asNonEmptyString(value);
  if (!text) return undefined;
  const singleLine = text.replace(/\s+/g, " ");
  return singleLine.length > limit ? `${singleLine.slice(0, limit - 3)}...` : singleLine;
}

function itemLabel(item: UnknownRecord): string {
  switch (item.type) {
    case "commandExecution": return "bash";
    case "fileChange": return "editing files";
    case "mcpToolCall": return asNonEmptyString(item.tool) ? `MCP ${item.tool}` : "MCP tool";
    case "dynamicToolCall": return asNonEmptyString(item.tool) ?? "dynamic tool";
    case "webSearch": return "web search";
    case "imageView": return "viewing image";
    case "imageGeneration": return "generating image";
    default: return asNonEmptyString(item.type) ?? "working";
  }
}

function extractNotificationThreadId(notification: UnknownRecord): string | undefined {
  const params = notification.params ?? {};
  return asNonEmptyString(params.threadId)
    ?? asNonEmptyString(params.thread?.id)
    ?? asNonEmptyString(params.turn?.threadId);
}

function subagentTitle(state: CodexAppEventState, threadId: string): string {
  const subagent = state.subagents.get(threadId);
  return subagent?.title ?? subagent?.agentPath?.split("/").filter(Boolean).at(-1) ?? "subagent";
}

function subagentEvent(
  state: CodexAppEventState,
  threadId: string,
  status: "running" | "completed" | "error",
  options: { title?: string; lastTool?: string; output?: string; error?: string } = {}
): CodexAppSessionEvent {
  const existing = state.subagents.get(threadId);
  const startedAtMs = existing?.startedAtMs ?? Date.now();
  const title = options.title ?? existing?.title ?? subagentTitle(state, threadId);
  const lastTool = options.lastTool ?? existing?.lastTool;
  state.subagents.set(threadId, {
    threadId,
    title,
    agentPath: existing?.agentPath,
    startedAtMs,
    lastTool,
    status,
  });
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: `codex-subagent:${threadId}`,
        type: "tool",
        tool: "subagent",
        state: {
          status,
          title,
          input: { description: title },
          output: options.output,
          error: options.error,
          metadata: {
            provider: "codex",
            sourceThreadId: threadId,
            childSession: true,
            startedAtMs,
            lastTool,
          },
        },
      },
    },
  };
}

function normalizeTokenUsage(tokenUsage: UnknownRecord | undefined): UnknownRecord | undefined {
  if (!tokenUsage) return undefined;
  const total = tokenUsage.total ?? {};
  return {
    input_tokens: total.inputTokens,
    output_tokens: total.outputTokens,
    reasoning_tokens: total.reasoningOutputTokens,
    cached_tokens: { read: total.cachedInputTokens, write: total.cacheWriteInputTokens },
    total_tokens: total.totalTokens,
  };
}

function toolPart(item: UnknownRecord, statusOverride?: string): CodexAppSessionEvent {
  const failed = item.status === "failed" || item.status === "declined";
  const completed = statusOverride === "completed" || item.status === "completed";
  const status = statusOverride ?? (failed ? "error" : completed ? "completed" : "running");
  const tool = item.type === "commandExecution"
    ? "bash"
    : item.type === "collabAgentToolCall"
      ? "collaboration"
      : item.type;
  const input = item.command
    ? { command: item.command, cwd: item.cwd }
    : item.type === "collabAgentToolCall"
      ? {
          action: item.tool,
          prompt: item.prompt,
          receiverThreadIds: item.receiverThreadIds,
          agentsStates: item.agentsStates,
        }
      : item.arguments;
  const title = item.type === "collabAgentToolCall"
    ? compact(item.prompt) ?? compact(item.tool)
    : undefined;
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: item.id,
        type: "tool",
        tool,
        state: {
          status,
          title,
          input,
          output: item.aggregatedOutput ?? item.result,
          error: item.error,
          metadata: {
            provider: "codex",
            senderThreadId: item.senderThreadId,
            receiverThreadIds: item.receiverThreadIds,
            agentsStates: item.agentsStates,
          },
        },
      },
    },
  };
}

function normalizeChildNotification(
  state: CodexAppEventState,
  method: string,
  params: UnknownRecord,
  childThreadId: string
): CodexAppSessionEvent[] {
  const item = params.item as UnknownRecord | undefined;
  if ((method === "item/started" || method === "item/completed") && item) {
    if (item.type === "agentMessage") return [];
    if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall"
      || item.type === "dynamicToolCall" || item.type === "webSearch" || item.type === "imageView"
      || item.type === "imageGeneration") {
      return [subagentEvent(state, childThreadId, "running", { lastTool: itemLabel(item) })];
    }
  }
  if (method === "item/commandExecution/outputDelta" || method === "item/mcpToolCall/progress"
    || method === "item/fileChange/patchUpdated") {
    const label = method.includes("commandExecution")
      ? "bash"
      : method.includes("mcpToolCall")
        ? "MCP tool"
        : "editing files";
    return [subagentEvent(state, childThreadId, "running", { lastTool: label })];
  }
  if (method === "turn/completed") {
    const turn = params.turn ?? {};
    const failed = turn.status === "failed";
    return [subagentEvent(state, childThreadId, failed ? "error" : "completed", {
      error: failed ? compact(turn.error?.message) ?? "Subagent failed" : undefined,
    })];
  }
  if (method === "error") {
    const message = compact(params.error?.message) ?? "Subagent error";
    return [subagentEvent(state, childThreadId, params.willRetry ? "running" : "error", {
      error: params.willRetry ? undefined : message,
      lastTool: params.willRetry ? `retrying: ${message}` : undefined,
    })];
  }
  if (method === "thread/status/changed" && params.status?.type === "systemError") {
    return [subagentEvent(state, childThreadId, "error", { error: "Subagent system error" })];
  }
  return [];
}

export function normalizeCodexAppNotification(
  state: CodexAppEventState,
  notification: UnknownRecord
): CodexAppSessionEvent[] {
  const method = asNonEmptyString(notification.method) ?? "unknown";
  const params = notification.params ?? {};
  const sourceThreadId = extractNotificationThreadId(notification);
  const rootThreadId = state.rootThreadId;

  if (method === "ode/serverRequest/declined") {
    const requestMethod = asNonEmptyString(params.requestMethod) ?? "server request";
    return [{
      type: "session.status",
      properties: { status: `Codex request declined: ${requestMethod}` },
    }];
  }
  if (method === "ode/serverRequest/failed") {
    const requestMethod = asNonEmptyString(params.requestMethod) ?? "unknown request";
    const message = compact(params.message) ?? "unsupported client capability";
    return [{
      type: "session.status",
      properties: {
        status: params.protocolKnown === false
          ? `Codex integration update required: ${requestMethod}`
          : `Codex client capability unavailable: ${message}`,
      },
    }];
  }

  if (sourceThreadId && rootThreadId && sourceThreadId !== rootThreadId) {
    return normalizeChildNotification(state, method, params, sourceThreadId);
  }

  if (method === "ode/question/requested") {
    const questions = Array.isArray(params.questions) ? params.questions : [];
    return [{
      type: "question.asked",
      properties: {
        id: params.requestId,
        questions: questions.map((question: UnknownRecord) => ({
          question: question.question ?? question.header ?? "Question",
          options: Array.isArray(question.options)
            ? question.options.map((option: UnknownRecord) => ({
                label: option.label ?? option.description ?? String(option),
              }))
            : [],
          multiple: false,
          custom: question.isOther !== false,
        })),
      },
    }];
  }

  if (method === "turn/started") {
    return [{ type: "session.status", properties: { status: { type: "busy" } } }];
  }
  if (method === "turn/completed") {
    const failed = params.turn?.status === "failed";
    const error = compact(params.turn?.error?.message);
    return [{
      type: "session.status",
      properties: { status: failed ? `Codex error: ${error ?? "turn failed"}` : { type: "idle" } },
    }];
  }
  if (method === "thread/status/changed") {
    const status = params.status ?? {};
    if (status.type === "active") {
      const flag = Array.isArray(status.activeFlags) ? status.activeFlags[0] : undefined;
      return [{
        type: "session.status",
        properties: { status: { type: "busy", message: flag === "waitingOnApproval" ? "Waiting for approval" : undefined } },
      }];
    }
    if (status.type === "idle") {
      return [{ type: "session.status", properties: { status: { type: "idle" } } }];
    }
    if (status.type === "systemError") {
      return [{ type: "session.status", properties: { status: "Codex system error" } }];
    }
    return [];
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = normalizeTokenUsage(params.tokenUsage);
    return usage
      ? [{ type: "message.updated", properties: { info: { tokenUsage: usage } } }]
      : [];
  }
  if (method === "error") {
    const message = compact(params.error?.message) ?? "Codex error";
    return [{
      type: "session.status",
      properties: { status: params.willRetry ? { type: "retry", message } : `Codex error: ${message}` },
    }];
  }
  if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
    const key = params.itemId ?? "agent";
    const text = `${state.textSnapshots.get(key) ?? ""}${params.delta}`;
    state.textSnapshots.set(key, text);
    return [{
      type: "message.part.updated",
      properties: { part: { id: key, type: "text", text } },
    }];
  }
  if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta")
    && typeof params.delta === "string") {
    const key = params.itemId ?? "reasoning";
    const text = `${state.reasoningSnapshots.get(key) ?? ""}${params.delta}`;
    state.reasoningSnapshots.set(key, text);
    return [{
      type: "message.part.updated",
      properties: { part: { id: key, type: "reasoning", text } },
    }];
  }
  if (method === "item/plan/delta" && typeof params.delta === "string") {
    const key = params.itemId ?? "plan";
    const text = `${state.planSnapshots.get(key) ?? ""}${params.delta}`;
    state.planSnapshots.set(key, text);
    return [{ type: "session.status", properties: { status: `Planning: ${compact(text, 90) ?? "updating plan"}` } }];
  }
  if (method === "turn/plan/updated") {
    const items = Array.isArray(params.plan) ? params.plan : Array.isArray(params.items) ? params.items : [];
    return [{ type: "todo.updated", properties: { items } }];
  }
  if (method === "turn/diff/updated" && typeof params.diff === "string") {
    return [{
      type: "message.part.updated",
      properties: {
        part: {
          id: `codex-diff:${params.turnId ?? "turn"}`,
          type: "tool",
          tool: "edit",
          state: { status: "running", title: "Updating files", output: params.diff },
        },
      },
    }];
  }
  if (method === "thread/compacted") {
    return [{ type: "session.status", properties: { status: "Compacted conversation context" } }];
  }
  if (method === "model/rerouted") {
    return [{
      type: "session.status",
      properties: { status: `Model rerouted: ${params.fromModel ?? "default"} → ${params.toModel ?? "fallback"}` },
    }];
  }
  if (method === "warning" || method === "configWarning" || method === "guardianWarning" || method === "deprecationNotice") {
    const message = compact(params.message ?? params.summary ?? params.details) ?? "Codex warning";
    return [{ type: "session.status", properties: { status: `Warning: ${message}` } }];
  }
  if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
    const item = state.toolItems.get(params.itemId) ?? { id: params.itemId, type: "commandExecution" };
    const output = `${state.toolOutputs.get(params.itemId) ?? ""}${params.delta}`;
    state.toolOutputs.set(params.itemId, output);
    return [toolPart({ ...item, aggregatedOutput: output }, "running")];
  }
  if (method === "item/mcpToolCall/progress") {
    const item = state.toolItems.get(params.itemId) ?? { id: params.itemId, type: "mcpToolCall" };
    return [toolPart({ ...item, result: compact(params.message) }, "running")];
  }
  if (method === "item/fileChange/patchUpdated") {
    const item = state.toolItems.get(params.itemId) ?? { id: params.itemId, type: "fileChange" };
    return [toolPart({ ...item, result: JSON.stringify(params.changes ?? []) }, "running")];
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item as UnknownRecord | undefined;
    if (!item || typeof item.id !== "string") return [];
    state.toolItems.set(item.id, item);
    if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      return [{
        type: "message.part.updated",
        properties: { part: { id: item.id, type: "text", text: item.text } },
      }];
    }
    if (item.type === "reasoning") {
      const text = Array.isArray(item.summary) ? item.summary.join("\n") : "";
      return text
        ? [{ type: "message.part.updated", properties: { part: { id: item.id, type: "reasoning", text } } }]
        : [];
    }
    if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
      const title = item.agentPath?.split("/").filter(Boolean).at(-1) ?? "subagent";
      const existing = state.subagents.get(item.agentThreadId);
      state.subagents.set(item.agentThreadId, {
        threadId: item.agentThreadId,
        title,
        agentPath: item.agentPath,
        startedAtMs: existing?.startedAtMs ?? Date.now(),
        lastTool: existing?.lastTool,
        status: existing?.status ?? "running",
      });
      if (item.kind === "interrupted") {
        return [subagentEvent(state, item.agentThreadId, "error", { title, error: "Subagent interrupted" })];
      }
      return [subagentEvent(state, item.agentThreadId, "running", { title })];
    }
    if (item.type === "collabAgentToolCall") {
      const receiverThreadIds = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((threadId: unknown): threadId is string => typeof threadId === "string")
        : [];
      const targetThreadIds = receiverThreadIds.length > 0
        ? receiverThreadIds
        : [...state.subagents.values()]
          .filter((subagent) => subagent.status === "running")
          .map((subagent) => subagent.threadId);
      if (item.tool === "wait") {
        return method === "item/started"
          ? targetThreadIds.map((threadId) => subagentEvent(state, threadId, "running", { lastTool: "waiting for result" }))
          : [];
      }
      if (item.tool === "closeAgent") {
        return targetThreadIds.map((threadId) => subagentEvent(state, threadId, "completed"));
      }
      if (item.tool === "spawnAgent" || item.tool === "resumeAgent" || item.tool === "sendInput") {
        return targetThreadIds.map((threadId) => subagentEvent(state, threadId, "running", {
          title: compact(item.prompt) ?? state.subagents.get(threadId)?.title,
          lastTool: item.tool === "spawnAgent" ? "starting" : item.tool === "resumeAgent" ? "resuming" : "received input",
        }));
      }
      return [];
    }
    const toolTypes = new Set([
      "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
      "webSearch", "imageView", "imageGeneration", "sleep",
    ]);
    return toolTypes.has(item.type)
      ? [toolPart(item, method === "item/completed" ? undefined : "running")]
      : [];
  }
  return [];
}

export function isKnownCodexAppNotificationMethod(method: string): boolean {
  return KNOWN_NOTIFICATION_METHODS.has(method);
}

export function getCodexAppNotificationContext(
  state: CodexAppEventState,
  notification: UnknownRecord
): { rootThreadId?: string; sourceThreadId?: string; childThread: boolean } {
  const sourceThreadId = extractNotificationThreadId(notification);
  return {
    rootThreadId: state.rootThreadId,
    sourceThreadId,
    childThread: Boolean(sourceThreadId && state.rootThreadId && sourceThreadId !== state.rootThreadId),
  };
}
