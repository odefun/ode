import type { OpenCodeMessage } from "@/agents";
import type { OpenCodeOptions } from "@/agents";
import { randomUUID } from "node:crypto";
import {
  clearPendingQuestion,
  completeActiveRequest,
  createActiveRequest,
  failActiveRequest,
  getPendingQuestion,
  loadSession,
  saveSession,
  setPendingQuestion,
  updateActiveRequest,
  type ActiveRequest,
  type PendingQuestion,
  type PersistedSession,
  type TrackedTodo,
  type TrackedTool,
} from "@/config/local/sessions";
import {
  completeAgentResult,
  failAgentResult,
  recordAgentQuestion,
  completeAgentQuestion,
  recordOdeRunEvents,
  updateAgentResultContext,
} from "@/config/local/inbox";
import { getMessageUpdateIntervalMs, getUserGeneralSettings } from "@/config";
import { buildFinalResponseText, categorizeRuntimeError, createDeferred } from "@/core/runtime/helpers";
import { buildStatusMessageForAgent } from "@/core/runtime/status-message";
import { maybeGenerateSessionTitle } from "@/core/runtime/session-title";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { formatSingleQuestionPrompt } from "@/core/runtime/helpers";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import { getAgentInputText, type AgentInput } from "@/shared/agent-protocol";
import type { OdeRunEvent } from "@/shared/agent-protocol";
import type { AgentProviderId } from "@/shared/agent-provider";
import {
  createOdeRunEvent,
  deriveOdeRunEventsFromState,
} from "@/core/runtime/ode-run-events";
import {
  appendCoalescedSessionEvent,
  getSessionEventCoalesceKey,
  orderSessionEventsChronologically,
  SampledRawEventBuffer,
} from "@/core/runtime/session-event-buffer";
import {
  buildSessionMessageState,
  extractEventRootSessionId,
  extractEventSessionId,
  getStatusMessageKey,
  truncateEventPayload,
  type SessionEvent,
  type SessionMessageState,
  log,
} from "@/utils";

/**
 * Guard against publishing the user's own prompt as the bot's final reply.
 *
 * OpenCode streams a TextPart for user messages too, and `request.currentText`
 * may end up holding that user prompt if the turn produced no assistant text
 * (e.g. tool-only turn or an empty `result.responses`). Previously this
 * caused the bot to echo the user back into Slack verbatim.
 */
function isPromptEcho(candidate: string | undefined, prompt: string | undefined): boolean {
  if (!candidate || !prompt) return false;
  const c = candidate.trim();
  const p = prompt.trim();
  if (!c || !p) return false;
  return c === p;
}

/**
 * A provider may stream events from child/sub-agent sessions through the
 * root-session subscription. Their `step-finish(reason=stop)` marks only the
 * child as complete and must not end the parent Ode request.
 */
function isRootSessionStopEvent(event: Record<string, unknown> | undefined): boolean {
  if (!event || event.type !== "message.part.updated") return false;
  const properties = event.properties && typeof event.properties === "object"
    ? event.properties as Record<string, unknown>
    : undefined;
  const part = properties?.part && typeof properties.part === "object"
    ? properties.part as Record<string, unknown>
    : undefined;
  if (part?.type !== "step-finish" || part.reason !== "stop") return false;

  const contextValue = event.odeContext ?? properties?.odeContext;
  const context = contextValue && typeof contextValue === "object"
    ? contextValue as Record<string, unknown>
    : undefined;
  if (context?.childSession === true) return false;

  const sourceSessionId = extractEventSessionId(event);
  const rootSessionId = extractEventRootSessionId(event);
  return !(sourceSessionId && rootSessionId && sourceSessionId !== rootSessionId);
}

export function mirrorPendingQuestionToRealThread(params: {
  channelId: string;
  syntheticThreadId: string;
  realThreadId: string | undefined;
  pendingQuestion: PendingQuestion;
}): void {
  const { channelId, syntheticThreadId, realThreadId, pendingQuestion } = params;
  if (!realThreadId || realThreadId === syntheticThreadId || !isSyntheticOwner(syntheticThreadId)) {
    return;
  }

  const syntheticSession = loadSession(channelId, syntheticThreadId);
  if (!syntheticSession) return;

  const existingRealSession = loadSession(channelId, realThreadId);
  if (existingRealSession) {
    existingRealSession.pendingQuestion = pendingQuestion;
    saveSession(existingRealSession);
    return;
  }

  const { activeRequest: _activeRequest, ...syntheticRest } = syntheticSession;
  saveSession({
    ...syntheticRest,
    threadId: realThreadId,
    pendingQuestion,
  });
}

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
  input: AgentInput;
  agentContext: Awaited<ReturnType<IMAdapter["buildAgentContext"]>>;
  options?: OpenCodeOptions;
  agentResultDetailId: string | null;
  threadKey: string;
  isFirstMessageInThread: boolean;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  liveRunEvents: Map<string, OdeRunEvent[]>;
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
  liveRunEvents?: Map<string, OdeRunEvent[]>;
  sendPrompt: () => Promise<OpenCodeMessage[]>;
  onProgressTick: () => Promise<void>;
  onComplete: () => void;
  onFail: (message: string) => void;
  publishFinalText: (text: string) => Promise<void>;
  failureLogLabel: string;
  agentResultDetailId: string | null;
  threadKey: string;
  sessionId: string;
  providerId: string;
  model: string | null;
  runId?: string;
};

export type RunTrackedRequestResult = {
  responses: OpenCodeMessage[] | null;
  stopFallbackText?: string;
};

function isExternallySettled(request: ActiveRequest): boolean {
  return request.state !== "processing";
}

const EVENT_STATE_MERGE_INTERVAL_MS = 1000;
const MAX_RAW_PROVIDER_EVENTS_PER_RUN = 500;

function tryCompleteAgentResult(params: {
  detailId: string | null;
  resultText: string;
  sessionId: string;
  providerId: string;
  model: string | null;
  workingDirectory: string;
}): void {
  if (!params.detailId) return;
  try {
    completeAgentResult({
      detailId: params.detailId,
      resultText: params.resultText,
      providerId: params.providerId,
      model: params.model,
      workingDirectory: params.workingDirectory,
    });
  } catch (error) {
    log.warn("Failed to complete agent result detail", {
      detailId: params.detailId,
      sessionId: params.sessionId,
      error: String(error),
    });
  }
}

function tryFailAgentResult(params: {
  detailId: string | null;
  errorText: string;
  sessionId: string;
  providerId: string;
  model: string | null;
  workingDirectory: string;
}): void {
  if (!params.detailId) return;
  try {
    failAgentResult({
      detailId: params.detailId,
      errorText: params.errorText,
      providerId: params.providerId,
      model: params.model,
      workingDirectory: params.workingDirectory,
    });
  } catch (error) {
    log.warn("Failed to mark agent result detail as failed", {
      detailId: params.detailId,
      sessionId: params.sessionId,
      error: String(error),
    });
  }
}

async function startKernelEventStreamWatcher(params: {
  deps: {
    agent: AgentAdapter;
    im: IMAdapter;
  };
  request: ActiveRequest;
  workingPath: string;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  liveRunEvents: Map<string, OdeRunEvent[]>;
  threadKey: string | null;
  model: string | null;
  runId: string;
  agentResultDetailId: string | null;
  onUpdate: () => void;
  onStop?: () => void;
}): Promise<() => void> {
  const {
    deps,
    request,
    workingPath,
    liveEventHistory,
    liveParsedState,
    threadKey,
    model,
    runId,
    agentResultDetailId,
    onUpdate,
    onStop,
  } = params;
  const liveRunEvents = params.liveRunEvents ?? new Map<string, OdeRunEvent[]>();

  if (!deps.agent.supportsEventStream) {
    return () => {};
  }

  await deps.agent.ensureSession(request.sessionId);
  const providerId = deps.agent.getProviderForSession(request.sessionId);
  const providerTag = providerId.toUpperCase();

  let messageKey = getStatusMessageKey(request);
  const eventHistory = liveEventHistory.get(messageKey) ?? [];
  const runEvents = liveRunEvents.get(messageKey) ?? [];
  let persistedRunEventCount = 0;
  const rawEventBuffer = new SampledRawEventBuffer(MAX_RAW_PROVIDER_EVENTS_PER_RUN);
  const eventIndexByKey = new Map<string, number>();
  for (let index = 0; index < eventHistory.length; index += 1) {
    const existing = eventHistory[index];
    if (!existing) continue;
    const key = getSessionEventCoalesceKey(existing);
    if (key) eventIndexByKey.set(key, index);
  }
  if (!liveEventHistory.has(messageKey)) {
    liveEventHistory.set(messageKey, eventHistory);
  }
  if (!liveRunEvents.has(messageKey)) liveRunEvents.set(messageKey, runEvents);

  function persistRunEvents(): void {
    if (!threadKey || persistedRunEventCount >= runEvents.length) return;
    const pending = runEvents.slice(persistedRunEventCount);
    try {
      recordOdeRunEvents(threadKey, pending);
      persistedRunEventCount = runEvents.length;
    } catch (error) {
      log.warn("Failed to persist Ode run events", {
        threadKey,
        count: pending.length,
        error: String(error),
      });
    }
  }

  function queueRawProviderEvent(event: SessionEvent): void {
    rawEventBuffer.enqueue(event);
  }

  function flushRawProviderEvents(force: boolean): void {
    const drained = rawEventBuffer.drain(force);
    for (const sessionEvent of drained.events) {
      runEvents.push(createOdeRunEvent(
        {
          providerId,
          sessionId: request.sessionId,
          runId,
          timestamp: sessionEvent.timestamp,
        },
        "provider.raw",
        { providerType: sessionEvent.type },
        { rawEvent: sessionEvent.data }
      ));
    }

    if (drained.summary) {
      runEvents.push(createOdeRunEvent(
        { providerId, sessionId: request.sessionId, runId },
        "provider.raw",
        {
          providerType: "ode.raw_events.sampled",
          dropped: drained.summary.dropped,
          retained: drained.summary.retained,
        }
      ));
    }
  }

  /**
   * Re-home the live-state buffers to a new key after the status message
   * is rotated (e.g. after the user answers a question and we delete +
   * resend the status message). `eventHistory` itself is the same array
   * object as before — only the Map keys move.
   */
  function migrateMessageKey(newKey: string): void {
    if (newKey === messageKey) return;
    liveEventHistory.delete(messageKey);
    liveEventHistory.set(newKey, eventHistory);
    const parsed = liveParsedState.get(messageKey);
    liveParsedState.delete(messageKey);
    if (parsed) liveParsedState.set(newKey, parsed);
    liveRunEvents.delete(messageKey);
    liveRunEvents.set(newKey, runEvents);
    messageKey = newKey;
  }

  function applyStateFromEvents(forceRaw = false): void {
    flushRawProviderEvents(forceRaw);
    const existingState = liveParsedState.get(messageKey);
    const parsedState = buildSessionMessageState(orderSessionEventsChronologically(eventHistory), {
      workingDirectory: workingPath,
      provider: providerId,
      baseState: {
        startedAt: request.startedAt,
        sessionTitle: existingState?.sessionTitle,
      },
    });
    const canonicalEvents = deriveOdeRunEventsFromState({
      previous: existingState,
      next: parsedState,
      context: { providerId, sessionId: request.sessionId, runId },
    });
    runEvents.push(...canonicalEvents);
    persistRunEvents();
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

    if (agentResultDetailId) {
      const lastEvent = eventHistory[eventHistory.length - 1];
      const lastTool = parsedState.tools[parsedState.tools.length - 1];
      const pendingQuestion = getPendingQuestion(request.channelId, request.threadId);
      try {
        updateAgentResultContext({
          detailId: agentResultDetailId,
          context: {
            runtimeDiagnostics: {
              sessionId: request.sessionId,
              runId,
              lastEventAt: lastEvent?.timestamp ?? request.startedAt,
              lastEventType: lastEvent?.type ?? "run.started",
              lastTool: lastTool
                ? {
                    id: lastTool.id,
                    name: lastTool.name,
                    status: lastTool.status,
                    title: lastTool.title,
                    input: lastTool.input,
                  }
                : null,
              pendingInteractions: pendingQuestion
                ? [{
                    requestId: pendingQuestion.requestId,
                    sessionId: pendingQuestion.sessionId,
                    kind: pendingQuestion.kind ?? "question",
                    askedAt: pendingQuestion.askedAt,
                    permission: pendingQuestion.permission,
                    patterns: pendingQuestion.patterns,
                    question: pendingQuestion.questions[0]?.question,
                  }]
                : [],
            },
          },
        });
      } catch (error) {
        log.warn("Failed to persist request runtime diagnostics", {
          detailId: agentResultDetailId,
          error: String(error),
        });
      }
    }
  }

  let stopNotified = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushStateUpdates(emitUpdate: boolean, forceRaw = false): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    applyStateFromEvents(forceRaw);
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
    const eventRootSessionId = extractEventRootSessionId(
      event as Record<string, unknown> | undefined
    );
    if (
      eventRootSessionId
        ? eventRootSessionId !== request.sessionId
        : eventSessionId && eventSessionId !== request.sessionId
    ) {
      return;
    }

    log.debug(`[${providerTag}] Event`, {
      sessionId: request.sessionId,
      type: (event as any)?.type ?? "unknown",
      properties: (event as any)?.properties,
      directory: (globalEvent as any)?.directory,
    });

    if (!stopNotified && isRootSessionStopEvent(event as Record<string, unknown> | undefined)) {
      stopNotified = true;
      shouldNotifyStop = true;
    }

    // Decide up-front which string fields inside this event must be kept
    // verbatim (i.e. never replaced by a truncation marker). Assistant text /
    // reasoning / thinking parts inside `message.part.updated` feed
    // `state.currentText` in session-inspector.ts, which request-run.ts later
    // publishes to Slack as the final reply on `stop` and tool-only turns —
    // truncating them here would post `...[truncated N bytes]` to the user.
    const preserveAssistantText =
      event?.type === "message.part.updated" &&
      ((): boolean => {
        const partType = (event as any)?.properties?.part?.type;
        return partType === "text" || partType === "reasoning" || partType === "thinking";
      })();
    const preserveStringAtPath = preserveAssistantText
      ? (path: string): boolean => path === "properties.part.text"
      : undefined;

    const sessionEvent: SessionEvent = {
      timestamp: Date.now(),
      type: event.type || "unknown",
      // Truncate any multi-KB strings inside the raw payload before we buffer
      // it for the turn. The live-status renderer never shows full tool output
      // — it only reads a short preview of tool input and a 90-char slice of
      // thinking text — so capping most strings at ~4 KB is lossless for the
      // UI. See packages/utils/event-truncation.ts.
      data: truncateEventPayload(event as Record<string, unknown>, {
        preserveStringAtPath,
      }),
    };
    appendCoalescedSessionEvent(eventHistory, eventIndexByKey, sessionEvent);
    queueRawProviderEvent(sessionEvent);

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
        if (threadKey && pendingQuestion.questionDetailId) {
          try {
            completeAgentQuestion({ detailId: pendingQuestion.questionDetailId });
          } catch (err) {
            log.warn("Failed to complete agent_question detail", {
              detailId: pendingQuestion.questionDetailId,
              error: String(err),
            });
          }
        }
        clearPendingQuestion(request.channelId, request.threadId);

        // The old status message now sits above the question/answer
        // messages, so any subsequent live updates would render out of
        // order in the thread. Replace it with a fresh status message
        // posted at the bottom so resumed progress stays in context.
        const oldStatusTs = request.statusMessageTs;
        void (async () => {
          try {
            deps.im.cancelPendingUpdates?.(request.channelId, oldStatusTs);
            const statusRateLimited = deps.im.wasRateLimited?.(request.channelId, oldStatusTs) ?? false;

            if (!statusRateLimited) {
              try {
                await deps.im.deleteMessage(request.channelId, oldStatusTs);
              } catch (err) {
                log.warn("Failed to delete stale status message after question reply", {
                  channelId: request.channelId,
                  threadId: request.threadId,
                  statusTs: oldStatusTs,
                  error: String(err),
                });
              }
            } else {
              log.warn("Skipping status message delete due to prior 429", {
                channelId: request.channelId,
                threadId: request.threadId,
                statusTs: oldStatusTs,
              });
            }
            deps.im.markMessageFinalized?.(request.channelId, oldStatusTs);

            // Render the new status message from the already-parsed
            // state so the user doesn't see a stale `_Working_` stub —
            // the tools, current text and todos captured before the
            // question are still relevant context for what the agent
            // is about to continue doing. Progress tick will keep
            // updating this new ts as new events arrive.
            const statusText = buildStatusMessageForAgent({
              agent: deps.agent,
              request,
              workingPath,
              state: liveParsedState.get(messageKey),
              statusMessageFormat: getUserGeneralSettings().defaultStatusMessageFormat,
            });
            const newStatusTs = await deps.im.sendMessage(
              request.channelId,
              request.replyThreadId,
              statusText,
            );
            if (typeof newStatusTs === "string" && newStatusTs.length > 0) {
              request.statusMessageTs = newStatusTs;
              updateActiveRequest(request.channelId, request.threadId, {
                statusMessageTs: newStatusTs,
              });
              // Move the live-state buffers to the new ts key so the
              // subscription handler and the progress tick keep reading
              // and writing the same Map entries.
              migrateMessageKey(getStatusMessageKey(request));
            }
          } catch (err) {
            log.warn("Failed to rotate status message after question reply", {
              channelId: request.channelId,
              threadId: request.threadId,
              error: String(err),
            });
          }
        })();

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
        odePermission?: {
          permission?: unknown;
          patterns?: unknown;
        };
      };
      const requestId = properties?.id;
      if (!requestId) return;

      const existingQuestion = getPendingQuestion(request.channelId, request.threadId);
      if (existingQuestion?.requestId === requestId) return;

      const normalized = deps.agent.normalizeQuestions(properties.questions);
      if (normalized.length === 0) return;

      // Post the first question as a standalone thread reply instead of
      // editing the live-status message. Editing the status used to work
      // but it left the status "frozen": once the user answered, the
      // agent would keep producing tool/text events while the status
      // message was still pinned to the question text, so the UI saw
      // nothing until the final result arrived. Keeping the status free
      // means resumed progress updates flow normally and the question
      // persists as its own message in Slack.
      let questionDetailId: string | null = null;
      if (threadKey) {
        try {
          const detail = recordAgentQuestion({
            threadKey,
            requestMessageId: request.statusMessageTs,
            questionRequestId: requestId,
            questions: normalized,
            providerId,
            model,
            workingDirectory: workingPath,
          });
          questionDetailId = detail.id;
        } catch (err) {
          log.warn("Failed to record agent_question detail", {
            threadKey,
            requestId,
            error: String(err),
          });
        }
      }

      void (async () => {
        let questionMessageTs: string | undefined;
        try {
          const first = normalized[0]!;
          const promptText = formatSingleQuestionPrompt(first, 0, normalized.length);
          questionMessageTs = await deps.im.sendMessage(
            request.channelId,
            request.replyThreadId,
            promptText
          );
        } catch (err) {
          log.warn("Failed to post ask_user question", {
            channelId: request.channelId,
            threadId: request.threadId,
            requestId,
            error: String(err),
          });
        }

        const pendingQuestion: PendingQuestion = {
          requestId,
          sessionId: properties.sessionID ?? request.sessionId,
          askedAt: Date.now(),
          kind: properties.odePermission ? "permission" : "question",
          permission: typeof properties.odePermission?.permission === "string"
            ? properties.odePermission.permission
            : undefined,
          patterns: Array.isArray(properties.odePermission?.patterns)
            ? properties.odePermission.patterns.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined,
          questions: normalized,
          messageTs: questionMessageTs ?? request.statusMessageTs,
          collectedAnswers: [],
          questionDetailId,
        };
        setPendingQuestion(request.channelId, request.threadId, pendingQuestion);
        mirrorPendingQuestionToRealThread({
          channelId: request.channelId,
          syntheticThreadId: request.threadId,
          realThreadId: questionMessageTs,
          pendingQuestion,
        });
        if (agentResultDetailId) {
          try {
            updateAgentResultContext({
              detailId: agentResultDetailId,
              context: {
                runtimeDiagnostics: {
                  lastEventAt: Date.now(),
                  lastEventType: "question.asked",
                  pendingInteractions: [{
                    requestId: pendingQuestion.requestId,
                    sessionId: pendingQuestion.sessionId,
                    kind: pendingQuestion.kind ?? "question",
                    askedAt: pendingQuestion.askedAt,
                    permission: pendingQuestion.permission,
                    patterns: pendingQuestion.patterns,
                    question: pendingQuestion.questions[0]?.question,
                  }],
                },
              },
            });
          } catch (error) {
            log.warn("Failed to persist pending request interaction", {
              detailId: agentResultDetailId,
              requestId,
              error: String(error),
            });
          }
        }
      })();
      return;
    }

    scheduleStateUpdates();
  });

  return () => {
    flushStateUpdates(false, true);
    persistRunEvents();
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
    input,
    agentContext,
    options,
    agentResultDetailId,
    threadKey,
    isFirstMessageInThread,
    liveEventHistory,
    liveParsedState,
    liveRunEvents,
    publishFinalText,
  } = params;

  const message = getAgentInputText(input);

  const providerLabel = deps.agent.getDisplayNameForSession(sessionId);

  let initialStatusTs: string | undefined;
  try {
    initialStatusTs = await deps.im.sendMessage(
      context.channelId,
      context.replyThreadId,
      `${providerLabel} is running...`
    );
  } catch (err) {
    // Swallow initial-status send failure so the request lifecycle below never
    // gets skipped by an unhandled rejection. A transient Slack error on the
    // very first chat.postMessage should not abort the whole run: the user
    // already sent us a message and is waiting for agent output.
    log.error("Initial status message send threw", {
      channelId: context.channelId,
      threadId: context.replyThreadId,
      error: String(err),
    });
    initialStatusTs = undefined;
  }

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
    message
  );
  session.activeRequest = request;
  saveSession(session);

  // Title generation races with the agent event stream — use a getter so
  // the final write lands on whatever key `liveParsedState` is using at
  // the moment the title arrives, even if a status-message rotation
  // re-keyed the buffers in the interim.
  void maybeGenerateSessionTitle({
    prompt: message,
    getStateKey: () => getStatusMessageKey(request),
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
  const resolvedModel = options?.model?.providerID && options.model.modelID
    ? `${options.model.providerID}/${options.model.modelID}`
    : null;
  const providerId = deps.agent.getProviderForSession(sessionId);
  const runId = agentResultDetailId ?? randomUUID();
  const statusKey = getStatusMessageKey(request);
  const runEvents = liveRunEvents.get(statusKey) ?? [];
  if (!liveRunEvents.has(statusKey)) liveRunEvents.set(statusKey, runEvents);
  runEvents.push(createOdeRunEvent(
    { providerId, sessionId, runId },
    "run.started",
    { transport: deps.agent.getTransportForSession(sessionId) }
  ));
  for (const part of input.parts) {
    if (part.type === "text") continue;
    runEvents.push(createOdeRunEvent(
      { providerId, sessionId, runId },
      "attachment.received",
      { filename: part.filename, mimeType: part.mimeType, size: part.size, kind: part.type }
    ));
  }
  const result = await runTrackedRequest({
    deps,
    request,
    workingPath: cwd,
    liveEventHistory,
    liveParsedState,
    liveRunEvents,
    sendPrompt: () =>
      deps.agent.sendMessage(
        context.channelId,
        sessionId,
        input,
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

      // Pull the live ts / key from `request` fresh each tick. The
      // subscription handler may have rotated the status message (e.g.
      // after a question was answered), so `statusTs` captured at setup
      // time can go stale. Always read the current values to keep
      // progress updates pointed at the actual live message.
      statusTs = request.statusMessageTs;
      const currentStatusKey = getStatusMessageKey(request);

      const statusText = buildStatusMessageForAgent({
        agent: deps.agent,
        request,
        workingPath: cwd,
        state: liveParsedState.get(currentStatusKey),
        statusMessageFormat: getUserGeneralSettings().defaultStatusMessageFormat,
      });
      if (!request.statusFrozen) {
        const updatedStatusTs = await deps.im.updateMessage(context.channelId, statusTs, statusText);
        if (typeof updatedStatusTs === "string" && updatedStatusTs !== statusTs) {
          statusTs = updatedStatusTs;
          request.statusMessageTs = updatedStatusTs;
        }

        const updateError = deps.im.takeUpdateError?.(context.channelId, statusTs);
        // Only post a fallback replacement if the request is still processing.
        // A stop command or failure could have transitioned us to "failed"
        // between the update attempt and now; posting a replacement status
        // after stop would ghost-write the status back into the channel.
        if (updateError && request.state === "processing") {
          const compactError = updateError.replace(/\s+/g, " ").trim().slice(0, 180);
          const fallbackNotice = compactError.length > 0
            ? `Status update failed: ${compactError}`
            : "Status update failed due to an unknown error.";
          try {
            await deps.im.sendMessage(
              context.channelId,
              context.replyThreadId,
              `${fallbackNotice}\nSwitching to a new status message below.`
            );
            const replacementStatusTs = await deps.im.sendMessage(
              context.channelId,
              context.replyThreadId,
              statusText
            );
            if (typeof replacementStatusTs === "string" && replacementStatusTs.length > 0) {
              statusTs = replacementStatusTs;
              request.statusMessageTs = replacementStatusTs;
              // Persist the new statusTs immediately so a crash before the
              // next debounced save doesn't leave disk pointing at the old
              // rate-limited TS (which would mis-route recovery edits).
              updateActiveRequest(
                context.channelId,
                context.threadId,
                { statusMessageTs: replacementStatusTs },
                { immediate: true }
              );
            }
          } catch (err) {
            // Replacement send failed (likely also rate-limited or channel-
            // level throttled). Don't crash the tick — keep statusTs pointing
            // at the old message; the next tick will try to update again.
            log.warn("Fallback status replacement send failed", {
              channelId: context.channelId,
              threadId: context.replyThreadId,
              error: String(err),
            });
          }
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
        statusTs: request.statusMessageTs,
        text,
      });
    },
    failureLogLabel: "Request failed",
    agentResultDetailId,
    threadKey,
    sessionId,
    providerId,
    model: resolvedModel,
    runId,
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
    agentResultDetailId,
    threadKey,
    sessionId,
    providerId,
    model,
    runId: requestedRunId,
  } = params;

  const liveRunEvents = params.liveRunEvents ?? new Map<string, OdeRunEvent[]>();
  const runId = requestedRunId ?? request.statusMessageTs;

  const progressIntervalMs = getMessageUpdateIntervalMs();
  let progressInFlight = false;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let stopWatcher: (() => void) | null = null;

  const waitForProgressDrain = async (): Promise<void> => {
    const deadline = Date.now() + Math.max(progressIntervalMs, 1_000);
    while (progressInFlight && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };

  const runProgressTick = async (): Promise<void> => {
    if (request.state !== "processing") return;
    if (progressInFlight) return;
    progressInFlight = true;
    try {
      await onProgressTick();
    } catch (err) {
      // A throw from onProgressTick would otherwise become an unhandled
      // rejection via `void runProgressTick()` in setInterval below, leaving
      // the status message frozen for the rest of the run. Log and continue;
      // the next tick will retry.
      log.warn("Progress tick failed", {
        sessionId: request.sessionId,
        channelId: request.channelId,
        error: String(err),
      });
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
      liveRunEvents,
      threadKey,
      model,
      runId,
      agentResultDetailId,
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

    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    await waitForProgressDrain();

    if (isExternallySettled(request)) return { responses: [] };

    request.state = "completed";
    request.statusFrozen = true;

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const safeFallback = isPromptEcho(fallbackText, request.prompt) ? undefined : fallbackText;
      const finalText = safeFallback || "_Done_";
      await publishFinalText(finalText);
      liveRunEvents.get(getStatusMessageKey(request))?.push(createOdeRunEvent(
        { providerId: providerId as AgentProviderId, sessionId, runId },
        "run.completed",
        { reason: "stop", text: finalText }
      ));
      tryCompleteAgentResult({
        detailId: agentResultDetailId,
        resultText: finalText,
        sessionId,
        providerId,
        model,
        workingDirectory: workingPath,
      });
      onComplete();

      void promptPromise.catch((err) => {
        log.debug("OpenCode prompt rejected after stop", { error: String(err) });
      });

      return { responses: [], stopFallbackText: safeFallback };
    }

    if (result.responses.length === 0) {
      log.warn("No text responses from model - tool-only response", {
        channelId: request.channelId,
        threadId: request.threadId,
        promptPreview: request.prompt.slice(0, 120),
        currentText: request.currentText,
      });
    }

    const builtText = buildFinalResponseText(result.responses);
    const rawFallback = request.currentText?.trim();
    const safeFallback = isPromptEcho(rawFallback, request.prompt) ? undefined : rawFallback;
    const finalText = builtText ?? (safeFallback || "_Done_");
    await publishFinalText(finalText);
    liveRunEvents.get(getStatusMessageKey(request))?.push(createOdeRunEvent(
      { providerId: providerId as AgentProviderId, sessionId, runId },
      "run.completed",
      { text: finalText }
    ));
    tryCompleteAgentResult({
      detailId: agentResultDetailId,
      resultText: finalText,
      sessionId,
      providerId,
      model,
      workingDirectory: workingPath,
    });
    onComplete();
    return { responses: result.responses };
  } catch (err) {
    if (isExternallySettled(request)) {
      return { responses: [] };
    }

    const { message, suggestion } = categorizeRuntimeError(err);
    log.error(failureLogLabel, { channelId: request.channelId, threadId: request.threadId, error: String(err) });

    request.state = "failed";
    request.error = message;

    const errorStatus = `Error: ${message}\n_${suggestion}_`;
    liveRunEvents.get(getStatusMessageKey(request))?.push(createOdeRunEvent(
      { providerId: providerId as AgentProviderId, sessionId, runId },
      "run.failed",
      { message, suggestion }
    ));
    tryFailAgentResult({
      detailId: agentResultDetailId,
      errorText: message,
      sessionId,
      providerId,
      model,
      workingDirectory: workingPath,
    });
    deps.im.cancelPendingUpdates?.(request.channelId, request.statusMessageTs);
    await deps.im.updateMessage(request.channelId, request.statusMessageTs, errorStatus);
    deps.im.markMessageFinalized?.(request.channelId, request.statusMessageTs);
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
    const statusKey = getStatusMessageKey(request);
    liveEventHistory.delete(statusKey);
    liveParsedState.delete(statusKey);
    liveRunEvents.delete(statusKey);
  }
}
