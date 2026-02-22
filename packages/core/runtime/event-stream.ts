import {
  clearPendingQuestion,
  getPendingQuestion,
  setPendingQuestion,
  type ActiveRequest,
  type TrackedTodo,
  type TrackedTool,
} from "@/config/local/sessions";
import { resolveStatusMessageFormat } from "@/config/status-message-format";
import { CoreStateMachine } from "@/core/state-machine";
import { buildStatusMessageForAgent } from "@/core/runtime/status-message";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import { formatQuestionPrompt } from "@/core/runtime/helpers";
import {
  buildSessionMessageState,
  extractEventSessionId,
  getStatusMessageKey,
  type SessionEvent,
  type SessionMessageState,
  log,
} from "@/utils";

type StartEventStreamWatcherParams = {
  deps: {
    agent: AgentAdapter;
    im: IMAdapter;
  };
  request: ActiveRequest;
  workingPath: string;
  stateMachine: CoreStateMachine;
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
  onUpdate: () => void;
  onStop?: () => void;
};

export async function startEventStreamWatcher(
  params: StartEventStreamWatcherParams
): Promise<() => void> {
  const {
    deps,
    request,
    workingPath,
    stateMachine,
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
  const unsubscribe = deps.agent.subscribeToSession(request.sessionId, (globalEvent: unknown) => {
    const event = (globalEvent as any).payload ?? globalEvent;
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
        onStop?.();
      }
    }

    const sessionEvent: SessionEvent = {
      timestamp: Date.now(),
      type: event.type || "unknown",
      data: event as Record<string, unknown>,
    };
    eventHistory.push(sessionEvent);

    const pendingQuestion = getPendingQuestion(request.channelId, request.threadId);

    if (pendingQuestion) {
      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestId = event.properties?.requestID;
        if (!requestId || requestId !== pendingQuestion.requestId) {
          return;
        }
        clearPendingQuestion(request.channelId, request.threadId);
        stateMachine.transition("resume_processing");
        onUpdate();
        return;
      }
      if (event.type !== "question.asked") {
        return;
      }
    }

    applyStateFromEvents();

    if (event.type === "question.asked") {
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
      stateMachine.transition("wait_for_user");
      const prompt = formatQuestionPrompt(normalized);
      request.currentText = prompt;
      onUpdate();

      void (async () => {
        await deps.im.updateMessage(
          request.channelId,
          request.statusMessageTs,
          buildStatusMessageForAgent({
            agent: deps.agent,
            request,
            workingPath,
            state: liveParsedState.get(messageKey),
            statusMessageFormat: resolveStatusMessageFormat(),
          }),
          false
        );
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

    onUpdate();
  });

  return unsubscribe;
}
