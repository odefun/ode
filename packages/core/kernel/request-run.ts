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
import {
  completeAgentResult,
  failAgentResult,
  recordAgentQuestion,
  completeAgentQuestion,
} from "@/config/local/inbox";
import { getMessageUpdateIntervalMs, getUserGeneralSettings } from "@/config";
import { buildFinalResponseText, categorizeRuntimeError, createDeferred } from "@/core/runtime/helpers";
import { buildStatusMessageForAgent } from "@/core/runtime/status-message";
import { maybeGenerateSessionTitle } from "@/core/runtime/session-title";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { formatSingleQuestionPrompt } from "@/core/runtime/helpers";
import {
  buildSessionMessageState,
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
  agentResultDetailId: string | null;
  threadKey: string;
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
  agentResultDetailId: string | null;
  threadKey: string;
  sessionId: string;
  providerId: string;
  model: string | null;
};

export type RunTrackedRequestResult = {
  responses: OpenCodeMessage[] | null;
  stopFallbackText?: string;
};

function isExternallySettled(request: ActiveRequest): boolean {
  return request.state !== "processing";
}

const EVENT_STATE_MERGE_INTERVAL_MS = 1000;

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
  threadKey: string | null;
  model: string | null;
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
    onUpdate,
    onStop,
  } = params;

  if (!deps.agent.supportsEventStream) {
    return () => {};
  }

  await deps.agent.ensureSession(request.sessionId);
  const providerId = deps.agent.getProviderForSession(request.sessionId);
  const providerTag = providerId.toUpperCase();

  let messageKey = getStatusMessageKey(request);
  const eventHistory = liveEventHistory.get(messageKey) ?? [];
  if (!liveEventHistory.has(messageKey)) {
    liveEventHistory.set(messageKey, eventHistory);
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
    messageKey = newKey;
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
        try {
          const first = normalized[0]!;
          const prefix = normalized.length > 1 ? `(1/${normalized.length}) ` : "";
          if (typeof deps.im.sendQuestion === "function") {
            await deps.im.sendQuestion(
              request.channelId,
              request.replyThreadId,
              first.question,
              first.options,
              prefix
            );
          } else {
            const promptText = formatSingleQuestionPrompt(first, 0, normalized.length);
            await deps.im.sendMessage(request.channelId, request.replyThreadId, promptText);
          }
        } catch (err) {
          log.warn("Failed to post ask_user question", {
            channelId: request.channelId,
            threadId: request.threadId,
            requestId,
            error: String(err),
          });
        }

        setPendingQuestion(request.channelId, request.threadId, {
          requestId,
          sessionId: properties.sessionID ?? request.sessionId,
          askedAt: Date.now(),
          questions: normalized,
          messageTs: request.statusMessageTs,
          collectedAnswers: [],
          questionDetailId,
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
    agentResultDetailId,
    threadKey,
    isFirstMessageInThread,
    liveEventHistory,
    liveParsedState,
    publishFinalText,
  } = params;

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
  } = params;

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
      threadKey,
      model,
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

    if (isExternallySettled(request)) {
      liveEventHistory.delete(getStatusMessageKey(request));
      liveParsedState.delete(getStatusMessageKey(request));
      return { responses: [] };
    }

    request.state = "completed";
    request.statusFrozen = true;

    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const safeFallback = isPromptEcho(fallbackText, request.prompt) ? undefined : fallbackText;
      const finalText = safeFallback || "_Done_";
      await publishFinalText(finalText);
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
  }
}
