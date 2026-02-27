import type { OpenCodeMessage } from "@/agents";
import type { OpenCodeOptions } from "@/agents";
import {
  clearPendingQuestion,
  completeActiveRequest,
  createActiveRequest,
  failActiveRequest,
  getPendingQuestion,
  saveSession,
  setPendingQuestion,
  updateActiveRequest,
  type ActiveRequest,
  type PersistedSession,
  type TrackedTodo,
  type TrackedTool,
} from "@/config/local/sessions";
import { getMessageUpdateIntervalMs, getUserGeneralSettings } from "@/config";
import { buildFinalResponseText, categorizeRuntimeError, createDeferred } from "@/core/runtime/helpers";
import { buildStatusMessageForAgent } from "@/core/runtime/status-message";
import { maybeGenerateSessionTitle } from "@/core/runtime/session-title";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { formatQuestionPrompt } from "@/core/runtime/helpers";
import {
  buildSessionMessageState,
  extractEventSessionId,
  getStatusMessageKey,
  type SessionEvent,
  type SessionMessageState,
  log,
} from "@/utils";

type RunnerDeps = {
  im: IMAdapter;
  agent: AgentAdapter;
  platform?: "slack" | "discord" | "lark";
};

type RunOpenRequestParams = {
  deps: RunnerDeps;
  session: PersistedSession;
  context: RuntimeRequestContext;
  sessionId: string;
  cwd: string;
  message: string;
  agentContext: Awaited<ReturnType<IMAdapter["buildAgentContext"]>>;
  options?: OpenCodeOptions;
  isFirstMessageInThread: boolean;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  publishFinalText: (params: {
    channelId: string;
    threadId: string;
    statusTs: string;
    text: string;
  }) => Promise<void>;
};

export type RunTrackedRequestParams = {
  deps: RunnerDeps;
  request: ActiveRequest;
  workingPath: string;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  sendPrompt: () => Promise<OpenCodeMessage[]>;
  onProgressTick: () => Promise<void>;
  onComplete: () => void;
  onFail: (message: string) => void;
  publishFinalText: (text: string) => Promise<void>;
  failureLogLabel: string;
};

export type RunTrackedRequestResult = {
  responses: OpenCodeMessage[] | null;
  stopFallbackText?: string;
};

function isExternallySettled(request: ActiveRequest): boolean {
  return request.state !== "processing";
}

const EVENT_STATE_MERGE_INTERVAL_MS = 1000;

async function startKernelEventStreamWatcher(params: {
  deps: {
    agent: AgentAdapter;
    im: IMAdapter;
  };
  request: ActiveRequest;
  workingPath: string;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  onUpdate: () => void;
  onStop?: () => void;
}): Promise<() => void> {
  const {
    deps,
    request,
    workingPath,
    liveEventHistory,
    liveParsedState,
    onUpdate,
    onStop,
  } = params;

  if (!deps.agent.supportsEventStream) {
    return () => {};
  }

  await deps.agent.ensureSession(request.sessionId);
  const providerId = deps.agent.getProviderForSession(request.sessionId);
  const providerTag = providerId.toUpperCase();

  const messageKey = getStatusMessageKey(request);
  const eventHistory = liveEventHistory.get(messageKey) ?? [];
  if (!liveEventHistory.has(messageKey)) {
    liveEventHistory.set(messageKey, eventHistory);
  }

  function applyStateFromEvents(): void {
    const existingState = liveParsedState.get(messageKey);
    const parsedState = buildSessionMessageState(eventHistory, {
      workingDirectory: workingPath,
      provider: providerId,
      baseState: {
        startedAt: request.startedAt,
        sessionTitle: existingState?.sessionTitle,
      },
    });
    liveParsedState.set(messageKey, parsedState);
    request.currentText = parsedState.currentText;
    request.tools = parsedState.tools.map((tool) => ({
      id: tool.id,
      name: tool.name,
      status: tool.status as TrackedTool["status"],
      title: tool.title,
      output: tool.output,
      error: tool.error,
    }));
    request.todos = parsedState.todos.map((todo) => ({
      content: todo.content,
      status: todo.status as TrackedTodo["status"],
    }));
  }

  let stopNotified = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushStateUpdates(emitUpdate: boolean): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    applyStateFromEvents();
    if (emitUpdate) {
      onUpdate();
    }
  }

  function scheduleStateUpdates(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      applyStateFromEvents();
      onUpdate();
    }, EVENT_STATE_MERGE_INTERVAL_MS);
  }

  const unsubscribe = deps.agent.subscribeToSession(request.sessionId, (globalEvent: unknown) => {
    const event = (globalEvent as any).payload ?? globalEvent;
    let shouldNotifyStop = false;
    const eventSessionId = extractEventSessionId(event as Record<string, unknown> | undefined);
    if (eventSessionId && eventSessionId !== request.sessionId) {
      return;
    }

    log.debug(`[${providerTag}] Event`, {
      sessionId: request.sessionId,
      type: (event as any)?.type ?? "unknown",
      properties: (event as any)?.properties,
      directory: (globalEvent as any)?.directory,
    });

    if (!stopNotified && event?.type === "message.part.updated") {
      const part = (event as any)?.properties?.part;
      if (part?.type === "step-finish" && part?.reason === "stop") {
        stopNotified = true;
        shouldNotifyStop = true;
      }
    }

    const sessionEvent: SessionEvent = {
      timestamp: Date.now(),
      type: event.type || "unknown",
      data: event as Record<string, unknown>,
    };
    eventHistory.push(sessionEvent);

    if (shouldNotifyStop) {
      flushStateUpdates(true);
      onStop?.();
      return;
    }

    const pendingQuestion = getPendingQuestion(request.channelId, request.threadId);

    if (pendingQuestion) {
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = event.properties?.requestID;
        if (!requestId || requestId !== pendingQuestion.requestId) {
          return;
        }
        clearPendingQuestion(request.channelId, request.threadId);
        flushStateUpdates(true);
        return;
      }
      if (event.type !== "question.asked") {
        return;
      }
    }

    if (event.type === "question.asked") {
      flushStateUpdates(false);
      const properties = event.properties as {
        id?: string;
        sessionID?: string;
        questions?: unknown;
      };
      const requestId = properties?.id;
      if (!requestId) return;

      const existingQuestion = getPendingQuestion(request.channelId, request.threadId);
      if (existingQuestion?.requestId === requestId) return;

      const normalized = deps.agent.normalizeQuestions(properties.questions);
      if (normalized.length === 0) return;

      request.statusFrozen = true;
      const prompt = formatQuestionPrompt(normalized);
      request.currentText = prompt;
      onUpdate();

      void (async () => {
        const updatedStatusTs = await deps.im.updateMessage(
          request.channelId,
          request.statusMessageTs,
          buildStatusMessageForAgent({
            agent: deps.agent,
            request,
            workingPath,
            state: liveParsedState.get(messageKey),
            statusMessageFormat: getUserGeneralSettings().defaultStatusMessageFormat,
          })
        );
        if (typeof updatedStatusTs === "string" && updatedStatusTs !== request.statusMessageTs) {
          request.statusMessageTs = updatedStatusTs;
          updateActiveRequest(request.channelId, request.threadId, { statusMessageTs: updatedStatusTs });
        }
        setPendingQuestion(request.channelId, request.threadId, {
          requestId,
          sessionId: properties.sessionID ?? request.sessionId,
          askedAt: Date.now(),
          questions: normalized,
          messageTs: request.statusMessageTs,
        });
      })();
      return;
    }

    scheduleStateUpdates();
  });

  return () => {
    flushStateUpdates(false);
    unsubscribe();
  };
}

export async function runOpenRequest(
  params: RunOpenRequestParams
): Promise<Array<{ text: string; messageType: "assistant" | "result" | "system" | "user" | "notify" }> | null> {
  const {
    deps,
    session,
    context,
    sessionId,
    cwd,
    message,
    agentContext,
    options,
    isFirstMessageInThread,
    liveEventHistory,
    liveParsedState,
    publishFinalText,
  } = params;

  const providerLabel = deps.agent.getDisplayNameForSession(sessionId);

  const initialStatusTs = await deps.im.sendMessage(
    context.channelId,
    context.replyThreadId,
    `${providerLabel} is running...`
  );

  if (!initialStatusTs) {
    log.error("Failed to send status message");
    return null;
  }
  let statusTs = initialStatusTs;

  const request = createActiveRequest(
    sessionId,
    context.channelId,
    context.replyThreadId,
    context.threadId,
    statusTs,
    message,
    context.botToken
  );
  session.activeRequest = request;
  saveSession(session);

  const statusMessageKey = getStatusMessageKey(request);

  void maybeGenerateSessionTitle({
    prompt: message,
    stateKey: statusMessageKey,
    liveParsedState,
    startedAt: request.startedAt,
    onTitleGenerated: async (title) => {
      if (!deps.im.renameThread) return;
      if (deps.platform === "discord" && isFirstMessageInThread) {
        await deps.im.renameThread(context.channelId, context.replyThreadId, title);
      }
    },
  });

  const progressIntervalMs = getMessageUpdateIntervalMs();
  let lastHeartbeat = Date.now();
  const result = await runTrackedRequest({
    deps,
    request,
    workingPath: cwd,
    liveEventHistory,
    liveParsedState,
    sendPrompt: () =>
      deps.agent.sendMessage(
        context.channelId,
        sessionId,
        message,
        cwd,
        options,
        agentContext
      ),
    onProgressTick: async () => {
      const now = Date.now();
      if (now - lastHeartbeat > progressIntervalMs) {
        lastHeartbeat = now;
        request.lastUpdatedAt = now;
      }

      const statusText = buildStatusMessageForAgent({
        agent: deps.agent,
        request,
        workingPath: cwd,
        state: liveParsedState.get(statusMessageKey),
        statusMessageFormat: getUserGeneralSettings().defaultStatusMessageFormat,
      });
      if (!request.statusFrozen) {
        const updatedStatusTs = await deps.im.updateMessage(context.channelId, statusTs, statusText);
        if (typeof updatedStatusTs === "string" && updatedStatusTs !== statusTs) {
          statusTs = updatedStatusTs;
          request.statusMessageTs = updatedStatusTs;
        }
      }
      updateActiveRequest(context.channelId, context.threadId, {
        statusMessageTs: request.statusMessageTs,
        currentText: request.currentText,
        todos: request.todos,
        statusFrozen: request.statusFrozen,
      });
    },
    onComplete: () => {
      completeActiveRequest(context.channelId, context.threadId);
    },
    onFail: (failureMessage) => {
      failActiveRequest(context.channelId, context.threadId, failureMessage);
    },
    publishFinalText: async (text) => {
      await publishFinalText({
        channelId: context.channelId,
        threadId: context.replyThreadId,
        statusTs,
        text,
      });
    },
    failureLogLabel: "Request failed",
  });

  if (result.responses === null) return null;

  if (result.stopFallbackText) {
    return [{ text: result.stopFallbackText, messageType: "assistant" }];
  }
  return result.responses;
}

export async function runTrackedRequest(
  params: RunTrackedRequestParams
): Promise<RunTrackedRequestResult> {
  const {
    deps,
    request,
    workingPath,
    liveEventHistory,
    liveParsedState,
    sendPrompt,
    onProgressTick,
    onComplete,
    onFail,
    publishFinalText,
    failureLogLabel,
  } = params;

  const progressIntervalMs = getMessageUpdateIntervalMs();
  let progressInFlight = false;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let stopWatcher: (() => void) | null = null;

  const runProgressTick = async (): Promise<void> => {
    if (request.state !== "processing") return;
    if (progressInFlight) return;
    progressInFlight = true;
    try {
      await onProgressTick();
    } finally {
      progressInFlight = false;
    }
  };

  const stopSignal = createDeferred<void>();
  try {
    progressTimer = setInterval(() => {
      void runProgressTick();
    }, progressIntervalMs);

    stopWatcher = await startKernelEventStreamWatcher({
      deps,
      request,
      workingPath,
      liveEventHistory,
      liveParsedState,
      onUpdate: () => {},
      onStop: () => {
        stopSignal.resolve();
      },
    });

    const promptPromise = sendPrompt();
    const result = await Promise.race([
      promptPromise.then((responses) => ({ type: "prompt" as const, responses })),
      stopSignal.promise.then(() => ({ type: "stop" as const })),
    ]);

    if (isExternallySettled(request)) {
      liveEventHistory.delete(getStatusMessageKey(request));
      liveParsedState.delete(getStatusMessageKey(request));
      return { responses: [] };
    }

    request.state = "completed";

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const finalText = fallbackText || "_Done_";
      await publishFinalText(finalText);
      onComplete();

      void promptPromise.catch((err) => {
        log.debug("OpenCode prompt rejected after stop", { error: String(err) });
      });

      return { responses: [], stopFallbackText: fallbackText };
    }

    if (result.responses.length === 0) {
      log.warn("No text responses from model - tool-only response", {
        channelId: request.channelId,
        threadId: request.threadId,
        promptPreview: request.prompt.slice(0, 120),
        currentText: request.currentText,
      });
    }

    const finalText = buildFinalResponseText(result.responses) ?? (request.currentText?.trim() || "_Done_");
    await publishFinalText(finalText);
    onComplete();
    return { responses: result.responses };
  } catch (err) {
    if (isExternallySettled(request)) {
      liveEventHistory.delete(getStatusMessageKey(request));
      liveParsedState.delete(getStatusMessageKey(request));
      return { responses: [] };
    }

    const { message, suggestion } = categorizeRuntimeError(err);
    log.error(failureLogLabel, { channelId: request.channelId, threadId: request.threadId, error: String(err) });

    request.state = "failed";
    request.error = message;

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    const errorStatus = `Error: ${message}\n_${suggestion}_`;
    await deps.im.updateMessage(request.channelId, request.statusMessageTs, errorStatus);
    onFail(message);
    return { responses: null };
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
  }
}
