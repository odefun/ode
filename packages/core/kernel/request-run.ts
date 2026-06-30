import type { OpenCodeMessage } from "@/agents";
import type { OpenCodeOptions } from "@/agents";
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
} from "@/config/local/inbox";
import { getMessageUpdateIntervalMs, getSlackStatusModeForChannel, getUserGeneralSettings } from "@/config";
import { buildFinalResponseText, categorizeRuntimeError, createDeferred } from "@/core/runtime/helpers";
import { buildStatusMessageForAgent } from "@/core/runtime/status-message";
import { maybeGenerateSessionTitle } from "@/core/runtime/session-title";
import type { AgentAdapter, IMAdapter, StatusStreamChunk } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { formatSingleQuestionPrompt } from "@/core/runtime/helpers";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import {
  buildSessionMessageState,
  createStatusStreamDiffer,
  extractEventSessionId,
  getStatusMessageKey,
  truncateEventPayload,
  type SessionEvent,
  type SessionMessageState,
  type StatusStreamDiffer,
  log,
} from "@/utils";

/**
 * Slack defaults to AI card status streams when the IM adapter supports the
 * Slack-style streaming API (chat.startStream/appendStream/stopStream). The
 * per-workspace setting can switch Slack back to legacy chat.update status
 * messages, while ODE_SLACK_STATUS_STREAMING remains a debug override.
 */
function isStatusStreamingEnabled(
  platform: "slack" | "discord" | "lark" | undefined,
  channelId: string
): boolean {
  const override = process.env.ODE_SLACK_STATUS_STREAMING?.toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  if (platform && platform !== "slack") return false;
  return getSlackStatusModeForChannel(channelId) !== "legacy";
}

function mirrorPendingQuestionToRealThread(params: {
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

  saveSession({
    ...syntheticSession,
    threadId: realThreadId,
    pendingQuestion,
  });
}

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

function compactFinalResultForStream(text: string): string | undefined {
  const compact = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
  if (!compact) return undefined;
  return compact.length > 220 ? `${compact.slice(0, 219)}…` : compact;
}

function buildFinalResultStreamChunk(text: string): StatusStreamChunk | undefined {
  const output = compactFinalResultForStream(text);
  if (!output) return undefined;
  return {
    type: "task_update",
    id: "result",
    title: "Result",
    status: "complete",
    output,
  };
}

const STREAM_STATUS_HEARTBEAT_MS = 1_000;

function migrateLiveStatusMessageKey(params: {
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  oldKey: string;
  newKey: string;
  eventHistory?: SessionEvent[];
}): void {
  const { liveEventHistory, liveParsedState, oldKey, newKey, eventHistory } = params;
  if (newKey === oldKey) return;

  const history = eventHistory ?? liveEventHistory.get(oldKey);
  if (history) {
    liveEventHistory.delete(oldKey);
    liveEventHistory.set(newKey, history);
  }

  const parsed = liveParsedState.get(oldKey);
  if (parsed) {
    liveParsedState.delete(oldKey);
    liveParsedState.set(newKey, parsed);
  }
}

function isNonRecoverableStreamStateError(error: unknown): boolean {
  const message = String(error);
  return /message_not_in_streaming_state|streaming_state_conflict/i.test(message);
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
  progressIntervalMs?: number;
  /**
   * Optional. When the runner used the streaming API for live status, the
   * failure path needs to stop the stream before chat.update would 409 with
   * `streaming_state_conflict`. The kernel passes a closure that knows how
   * to terminate the stream and preserve the full markdown error status.
   */
  publishErrorStatus?: (errorStatusText: string) => Promise<void>;
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
    migrateLiveStatusMessageKey({
      liveEventHistory,
      liveParsedState,
      oldKey: messageKey,
      newKey,
      eventHistory,
    });
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
                if (request.statusStreamActive && request.statusStreamTs === oldStatusTs && deps.im.stopStatusStream) {
                  try {
                    await deps.im.stopStatusStream(request.channelId, oldStatusTs);
                  } catch (err) {
                    log.warn("Failed to stop stale stream after question reply", {
                      channelId: request.channelId,
                      threadId: request.threadId,
                      statusTs: oldStatusTs,
                      error: String(err),
                    });
                  }
                  request.statusStreamActive = false;
                  request.statusStreamTs = undefined;
                  updateActiveRequest(request.channelId, request.threadId, {
                    statusStreamActive: false,
                    statusStreamTs: undefined,
                  }, { immediate: true });
                }
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
                statusStreamActive: false,
                statusStreamTs: undefined,
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
        let questionMessageTs: string | undefined;
        try {
          const first = normalized[0]!;
          const prefix = normalized.length > 1 ? `(1/${normalized.length}) ` : "";
          if (typeof deps.im.sendQuestion === "function") {
            questionMessageTs = await deps.im.sendQuestion(
              request.channelId,
              request.replyThreadId,
              first.question,
              first.options,
              prefix
            );
          } else {
            const promptText = formatSingleQuestionPrompt(first, 0, normalized.length);
            questionMessageTs = await deps.im.sendMessage(request.channelId, request.replyThreadId, promptText);
          }
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

  // Streaming-API path is enabled by Slack workspace config by default,
  // requires live agent events, and requires the adapter to implement the
  // stream lifecycle methods. When unavailable we silently fall back to the
  // chat.postMessage + chat.update path.
  const streamingRequested = isStatusStreamingEnabled(deps.platform, context.channelId)
    && deps.agent.supportsEventStream
    && typeof deps.im.startStatusStream === "function"
    && typeof deps.im.appendStatusStream === "function";

  // Tracks whether the *current* statusTs is a live stream. Set to true
  // only after startStatusStream returns a TS; cleared if we fall back to
  // sendMessage at startup or if a status rotation later replaces the TS
  // with a chat.postMessage-issued one.
  let useStreaming = false;
  // The TS that we actually started a stream against. Used to detect
  // status-message rotation (post-question / 429-fallback), which posts a
  // brand-new chat.postMessage message — appendStream against that TS
  // would fail with `message_not_in_streaming_state`.
  let streamingStatusTs: string | undefined;

  let initialStatusTs: string | undefined;
  try {
    if (streamingRequested && deps.im.startStatusStream) {
      try {
        initialStatusTs = await deps.im.startStatusStream(
          context.channelId,
          context.replyThreadId,
          {
            recipientUserId: context.userId,
            seedPlanTitle: `${providerLabel} is running...`,
          }
        );
      } catch (err) {
        // startStream itself threw — log and fall through to the
        // chat.postMessage path below. Common causes: missing
        // recipient_team_id, the workspace hasn't opted into the streaming
        // API, network blip on the very first request.
        log.warn("startStatusStream threw; falling back to chat.postMessage", {
          channelId: context.channelId,
          threadId: context.replyThreadId,
          error: String(err),
        });
        initialStatusTs = undefined;
      }
      if (initialStatusTs) {
        useStreaming = true;
        streamingStatusTs = initialStatusTs;
      } else {
        // Adapter returned undefined (e.g. resolveWorkspaceAuth couldn't
        // produce a team id). Fall back to plain chat.postMessage instead
        // of aborting the whole request.
        log.warn("startStatusStream returned no ts; falling back to chat.postMessage", {
          channelId: context.channelId,
          threadId: context.replyThreadId,
        });
        initialStatusTs = await deps.im.sendMessage(
          context.channelId,
          context.replyThreadId,
          `${providerLabel} is running...`
        );
      }
    } else {
      initialStatusTs = await deps.im.sendMessage(
        context.channelId,
        context.replyThreadId,
        `${providerLabel} is running...`
      );
    }
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
  if (useStreaming && streamingStatusTs) {
    request.statusStreamActive = true;
    request.statusStreamTs = streamingStatusTs;
  }
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

  const legacyProgressIntervalMs = getMessageUpdateIntervalMs();
  const progressIntervalMs = useStreaming ? STREAM_STATUS_HEARTBEAT_MS : legacyProgressIntervalMs;
  let lastHeartbeat = Date.now();
  let lastLegacyStatusUpdateAt = useStreaming ? Date.now() : 0;
  const resolvedModel = options?.model?.providerID && options.model.modelID
    ? `${options.model.providerID}/${options.model.modelID}`
    : null;
  const providerId = deps.agent.getProviderForSession(sessionId);
  const runMode = options?.agent === "plan" ? "plan mode" : "build mode";
  const statusMessageFormat = getUserGeneralSettings().defaultStatusMessageFormat;

  // One differ instance per run; keeps last-seen fingerprints so we only
  // send chunks for tools whose shape actually changed.
  let streamDiffer: StatusStreamDiffer | null = useStreaming ? createStatusStreamDiffer() : null;

  async function stopTrackedStatusStream(reason: string, appendChunks?: StatusStreamChunk[]): Promise<void> {
    const streamTs = streamingStatusTs ?? request.statusStreamTs;
    if (!streamTs || !deps.im.stopStatusStream) {
      useStreaming = false;
      streamingStatusTs = undefined;
      request.statusStreamActive = false;
      request.statusStreamTs = undefined;
      updateActiveRequest(context.channelId, context.threadId, {
        statusStreamActive: false,
        statusStreamTs: undefined,
      }, { immediate: true });
      return;
    }

    try {
      if (appendChunks && appendChunks.length > 0 && deps.im.appendStatusStream) {
        try {
          await deps.im.appendStatusStream(context.channelId, streamTs, appendChunks);
        } catch (err) {
          log.debug("Final stream append failed before stop", {
            reason,
            channelId: context.channelId,
            statusTs: streamTs,
            error: String(err),
          });
        }
      }
      await deps.im.stopStatusStream(context.channelId, streamTs);
      useStreaming = false;
      streamingStatusTs = undefined;
      request.statusStreamActive = false;
      request.statusStreamTs = undefined;
      updateActiveRequest(context.channelId, context.threadId, {
        statusStreamActive: false,
        statusStreamTs: undefined,
      }, { immediate: true });
    } catch (err) {
      if (isNonRecoverableStreamStateError(err)) {
        useStreaming = false;
        streamingStatusTs = undefined;
        request.statusStreamActive = false;
        request.statusStreamTs = undefined;
        updateActiveRequest(context.channelId, context.threadId, {
          statusStreamActive: false,
          statusStreamTs: undefined,
        }, { immediate: true });
        log.warn("Slack status stream was already non-streaming; cleared active stream state", {
          reason,
          channelId: context.channelId,
          statusTs: streamTs,
          error: String(err),
        });
        return;
      }
      useStreaming = true;
      streamingStatusTs = streamTs;
      request.statusStreamActive = true;
      request.statusStreamTs = streamTs;
      updateActiveRequest(context.channelId, context.threadId, {
        statusStreamActive: true,
        statusStreamTs: streamTs,
      }, { immediate: true });
      log.warn("Slack stopStatusStream failed", {
        reason,
        channelId: context.channelId,
        statusTs: streamTs,
        error: String(err),
      });
    }
  }

  async function switchToLegacyStatusFromSnapshot(
    currentState: SessionMessageState,
    extra?: {
      failedStreamTs?: string;
      oldStatusTs?: string;
      oldStreamTs?: string;
    }
  ): Promise<void> {
    const oldStatusKey = getStatusMessageKey(request);
    useStreaming = false;
    streamingStatusTs = undefined;
    streamDiffer = null;
    request.statusStreamActive = false;
    request.statusStreamTs = undefined;

    const statusText = buildStatusMessageForAgent({
      agent: deps.agent,
      request,
      workingPath: cwd,
      state: currentState,
      statusMessageFormat,
    });
    const legacyStatusTs = await deps.im.sendMessage(
      context.channelId,
      context.replyThreadId,
      statusText
    );
    if (typeof legacyStatusTs === "string" && legacyStatusTs.length > 0) {
      statusTs = legacyStatusTs;
      request.statusMessageTs = legacyStatusTs;
      lastLegacyStatusUpdateAt = Date.now();
      migrateLiveStatusMessageKey({
        liveEventHistory,
        liveParsedState,
        oldKey: oldStatusKey,
        newKey: getStatusMessageKey(request),
      });
      updateActiveRequest(context.channelId, context.threadId, {
        statusMessageTs: legacyStatusTs,
        statusStreamActive: false,
        statusStreamTs: undefined,
      }, { immediate: true });
      log.info("Switched Slack status to legacy message after stream recreation failed", {
        channelId: context.channelId,
        statusTs: legacyStatusTs,
        ...extra,
      });
      return;
    }

    updateActiveRequest(context.channelId, context.threadId, {
      statusStreamActive: false,
      statusStreamTs: undefined,
    }, { immediate: true });
  }

  async function recreateStatusStreamFromSnapshot(currentState: SessionMessageState): Promise<boolean> {
    if (!streamingRequested || !deps.im.startStatusStream || !deps.im.appendStatusStream) return false;

    const oldStatusTs = request.statusMessageTs;
    const oldStreamTs = streamingStatusTs ?? request.statusStreamTs;
    const oldStatusKey = getStatusMessageKey(request);

    try {
      await deps.im.deleteMessage(context.channelId, oldStatusTs);
    } catch (err) {
      log.warn("Failed to delete stale Slack AI status card before recreation", {
        channelId: context.channelId,
        statusTs: oldStatusTs,
        error: String(err),
      });
    }

    let nextStatusTs: string | undefined;
    try {
      nextStatusTs = await deps.im.startStatusStream(
        context.channelId,
        context.replyThreadId,
        {
          recipientUserId: context.userId,
          seedPlanTitle: `${providerLabel} is running...`,
        }
      );
    } catch (err) {
      log.warn("Failed to start replacement Slack AI status card; falling back to legacy status updates", {
        channelId: context.channelId,
        oldStatusTs,
        oldStreamTs,
        error: String(err),
      });
      await switchToLegacyStatusFromSnapshot(currentState, { oldStatusTs, oldStreamTs });
      return false;
    }
    if (!nextStatusTs) {
      log.warn("Failed to recreate Slack AI status card; falling back to legacy status updates", {
        channelId: context.channelId,
        oldStatusTs,
        oldStreamTs,
      });
      await switchToLegacyStatusFromSnapshot(currentState, { oldStatusTs, oldStreamTs });
      return false;
    }

    const nextDiffer = createStatusStreamDiffer();
    const { chunks, commit } = nextDiffer.diff({
      state: currentState,
      workingPath: cwd,
      startedAt: request.startedAt,
      agentLabel: providerLabel,
      runMode,
      statusMessageFormat,
    });
    try {
      if (chunks.length > 0) {
        await deps.im.appendStatusStream(context.channelId, nextStatusTs, chunks);
      }
      commit();
    } catch (err) {
      log.warn("Failed to seed replacement Slack AI status card; falling back to legacy status updates", {
        channelId: context.channelId,
        oldStatusTs,
        oldStreamTs,
        newStatusTs: nextStatusTs,
        error: String(err),
      });
      if (deps.im.stopStatusStream) {
        try {
          await deps.im.stopStatusStream(context.channelId, nextStatusTs);
        } catch (stopErr) {
          log.debug("Failed to stop unseeded replacement Slack AI status card", {
            channelId: context.channelId,
            statusTs: nextStatusTs,
            error: String(stopErr),
          });
        }
      }
      try {
        await deps.im.deleteMessage(context.channelId, nextStatusTs);
      } catch (deleteErr) {
        log.debug("Failed to delete unseeded replacement Slack AI status card", {
          channelId: context.channelId,
          statusTs: nextStatusTs,
          error: String(deleteErr),
        });
      }
      await switchToLegacyStatusFromSnapshot(currentState, {
        failedStreamTs: nextStatusTs,
        oldStatusTs,
        oldStreamTs,
      });
      return false;
    }

    statusTs = nextStatusTs;
    request.statusMessageTs = nextStatusTs;
    request.statusStreamActive = true;
    request.statusStreamTs = nextStatusTs;
    useStreaming = true;
    streamingStatusTs = nextStatusTs;
    streamDiffer = nextDiffer;
    migrateLiveStatusMessageKey({
      liveEventHistory,
      liveParsedState,
      oldKey: oldStatusKey,
      newKey: getStatusMessageKey(request),
    });

    updateActiveRequest(context.channelId, context.threadId, {
      statusMessageTs: nextStatusTs,
      statusStreamActive: true,
      statusStreamTs: nextStatusTs,
    }, { immediate: true });

    log.info("Recreated Slack AI status card after stale stream state", {
      channelId: context.channelId,
      oldStatusTs,
      newStatusTs: nextStatusTs,
      oldStreamTs,
    });
    return true;
  }

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
      const currentState = liveParsedState.get(currentStatusKey);

      // If a status-message rotation replaced our stream TS with a fresh
      // chat.postMessage TS (happens after a question.replied flow, or
      // after a 429-fallback elsewhere in this tick), the streaming-API
      // path no longer applies: appendStream against the new TS would
      // fail with `message_not_in_streaming_state`. Downgrade to plain
      // chat.update for the rest of the run. We do NOT try to re-start a
      // fresh stream — that would post a second message in the thread for
      // the same turn, which is more confusing than a continuation card.
      if (useStreaming && streamingStatusTs && statusTs !== streamingStatusTs) {
        log.info("Status TS rotated; disabling Slack streaming for the rest of the run", {
          channelId: context.channelId,
          previousStreamingTs: streamingStatusTs,
          newStatusTs: statusTs,
        });
        if (request.statusStreamActive && request.statusStreamTs === streamingStatusTs) {
          await stopTrackedStatusStream("status message rotated");
        } else {
          useStreaming = false;
          streamingStatusTs = undefined;
        }
        lastLegacyStatusUpdateAt = now;
      }

      // Streaming path: diff state -> chunks -> chat.appendStream.
      // Falls back to plain-text chat.update when the differ produced no
      // chunks (nothing changed) so we don't waste a Tier-4 round-trip.
      if (streamDiffer && currentState && deps.im.appendStatusStream && useStreaming && !request.statusFrozen) {
        const { chunks, commit } = streamDiffer.diff({
          state: currentState,
          workingPath: cwd,
          startedAt: request.startedAt,
          agentLabel: providerLabel,
          runMode,
          statusMessageFormat,
        });
        if (chunks.length > 0) {
          try {
            await deps.im.appendStatusStream(context.channelId, statusTs, chunks);
            // Only advance the differ's fingerprint cache after the
            // network call confirms. If commit() is skipped due to a
            // throw above, the next tick re-emits the same chunks
            // (idempotent for Slack's task_update / plan_update).
            commit();
          } catch (err) {
            if (isNonRecoverableStreamStateError(err)) {
              log.warn("Slack AI status stream is no longer active; recreating card", {
                channelId: context.channelId,
                statusTs,
                error: String(err),
              });
              try {
                if (await recreateStatusStreamFromSnapshot(currentState) || !useStreaming) {
                  return;
                }
              } catch (recreateErr) {
                log.warn("Slack AI status card recreation failed; falling back to legacy status updates", {
                  channelId: context.channelId,
                  statusTs,
                  error: String(recreateErr),
                });
                useStreaming = false;
                streamingStatusTs = undefined;
                request.statusStreamActive = false;
                request.statusStreamTs = undefined;
                updateActiveRequest(context.channelId, context.threadId, {
                  statusStreamActive: false,
                  statusStreamTs: undefined,
                }, { immediate: true });
              }
            }
            // appendStream failed (rate limit, streaming_state_conflict,
            // network blip…). Don't crash the tick and don't commit() —
            // the next tick will re-emit the still-pending delta.
            log.warn("Slack appendStatusStream failed; will retry next tick", {
              channelId: context.channelId,
              statusTs,
              chunkCount: chunks.length,
              error: String(err),
            });
          }
        }
        updateActiveRequest(context.channelId, context.threadId, {
          statusMessageTs: request.statusMessageTs,
          currentText: request.currentText,
          todos: request.todos,
          statusFrozen: request.statusFrozen,
        });
        return;
      }

      const statusText = buildStatusMessageForAgent({
        agent: deps.agent,
        request,
        workingPath: cwd,
        state: currentState,
        statusMessageFormat,
      });
      if (!request.statusFrozen) {
        if (now - lastLegacyStatusUpdateAt < legacyProgressIntervalMs) {
          updateActiveRequest(context.channelId, context.threadId, {
            statusMessageTs: request.statusMessageTs,
            currentText: request.currentText,
            todos: request.todos,
            statusFrozen: request.statusFrozen,
          });
          return;
        }
        lastLegacyStatusUpdateAt = now;

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
              lastLegacyStatusUpdateAt = Date.now();
              // Persist the new statusTs immediately so a crash before the
              // next debounced save doesn't leave disk pointing at the old
              // rate-limited TS (which would mis-route recovery edits).
              updateActiveRequest(
                context.channelId,
                context.threadId,
                {
                  statusMessageTs: replacementStatusTs,
                  statusStreamActive: false,
                  statusStreamTs: undefined,
                },
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
    progressIntervalMs,
    publishFinalText: async (text) => {
      // If we were rendering status via the streaming API, terminate the
      // stream first. This converts the live plan card to a static block
      // (no more spinner), prevents `streaming_state_conflict` on the
      // subsequent chat.update/delete in publishFinalText, and gives us a
      // place to record a one-line "done in 12s" summary via a final
      // plan_update chunk (chunks-mode streams can't accept markdown_text
      // on stop, so we use an appendStream first if we need a summary).
      if ((useStreaming || request.statusStreamActive) && streamDiffer && deps.im.stopStatusStream) {
        const currentState = liveParsedState.get(getStatusMessageKey(request));
        if (currentState) {
          const summary = streamDiffer.finalize({
            state: currentState,
            workingPath: cwd,
            startedAt: request.startedAt,
          }, text);
          const finalChunks: StatusStreamChunk[] = [{ type: "plan_update", title: summary }];
          const resultChunk = buildFinalResultStreamChunk(text);
          if (resultChunk) finalChunks.push(resultChunk);
          await stopTrackedStatusStream("final text", finalChunks);
        } else {
          await stopTrackedStatusStream("final text");
        }
      }
      await publishFinalText({
        channelId: context.channelId,
        threadId: context.replyThreadId,
        statusTs: request.statusMessageTs,
        text,
      });
    },
    publishErrorStatus: useStreaming && deps.im.stopStatusStream
      ? async (errorStatusText: string) => {
          if (!useStreaming && !request.statusStreamActive && !request.statusStreamTs) {
            await deps.im.updateMessage(context.channelId, request.statusMessageTs, errorStatusText);
            return;
          }
          // Append the error as a final plan_update chunk so the streamed
          // card surfaces the failure inline, then stop the stream. Chunks-
          // mode streams can't carry markdown_text on stop, so we publish
          // the full error text as a normal message after the stream is no
          // longer active.
          try {
            await stopTrackedStatusStream("error status", [
              { type: "plan_update", title: `Error: ${errorStatusText.split("\n")[0]?.slice(0, 200) ?? ""}` },
            ]);
            const errorStatusTs = await deps.im.sendMessage(
              context.channelId,
              context.replyThreadId,
              errorStatusText
            );
            if (typeof errorStatusTs === "string" && errorStatusTs.length > 0) {
              request.statusMessageTs = errorStatusTs;
              updateActiveRequest(context.channelId, context.threadId, {
                statusMessageTs: errorStatusTs,
                statusStreamActive: false,
                statusStreamTs: undefined,
              }, { immediate: true });
            }
          } catch (err) {
            log.warn("Streaming error status publish failed; falling back to chat.update", {
              channelId: context.channelId,
              statusTs: request.statusMessageTs,
              error: String(err),
            });
            // Best-effort: still try a plain update so the user sees something.
            try {
              await deps.im.updateMessage(
                context.channelId,
                request.statusMessageTs,
                errorStatusText
              );
            } catch (updateErr) {
              log.warn("Fallback chat.update after stopStream failure also failed", {
                channelId: context.channelId,
                error: String(updateErr),
              });
            }
          }
        }
      : undefined,
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
    progressIntervalMs: requestedProgressIntervalMs,
    failureLogLabel,
    agentResultDetailId,
    threadKey,
    sessionId,
    providerId,
    model,
  } = params;

  const progressIntervalMs = requestedProgressIntervalMs ?? getMessageUpdateIntervalMs();
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

    if (result.type === "stop") {
      const fallbackText = request.currentText?.trim();
      const safeFallback = isPromptEcho(fallbackText, request.prompt) ? undefined : fallbackText;
      const finalText = safeFallback || "_Done_";
      await publishFinalText(finalText);
      liveEventHistory.delete(getStatusMessageKey(request));
      liveParsedState.delete(getStatusMessageKey(request));
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
    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));
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
    if (params.publishErrorStatus) {
      // Streaming path: caller-supplied closure terminates the live stream
      // (via chat.stopStream) and posts a new message with the error text,
      // because chat.update against a streaming message returns
      // `streaming_state_conflict`.
      try {
        await params.publishErrorStatus(errorStatus);
      } catch (err) {
        log.warn("publishErrorStatus failed; falling back to chat.update", {
          channelId: request.channelId,
          statusTs: request.statusMessageTs,
          error: String(err),
        });
        await deps.im.updateMessage(request.channelId, request.statusMessageTs, errorStatus);
      }
    } else {
      await deps.im.updateMessage(request.channelId, request.statusMessageTs, errorStatus);
    }
    deps.im.markMessageFinalized?.(request.channelId, request.statusMessageTs);
    liveEventHistory.delete(getStatusMessageKey(request));
    liveParsedState.delete(getStatusMessageKey(request));
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
