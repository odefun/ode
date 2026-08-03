import type { AgentAdapter, NormalizedQuestion } from "@/core/types";
import {
  completeAgentQuestion,
  recordAgentQuestion,
  recordOdeRunEvents,
  updateAgentResultContext,
} from "@/config/local/inbox";
import {
  clearPendingQuestion,
  getPendingQuestion,
  setPendingQuestion,
  type PendingQuestion,
} from "@/config/local/sessions";
import {
  categorizeRuntimeError,
  formatSingleQuestionPrompt,
} from "@/core/runtime/helpers";
import { createOdeRunEvent } from "@/core/runtime/ode-run-events";
import type { AgentProviderId } from "@/shared/agent-provider";
import type { OdeRunEvent, OdeRunEventType } from "@/shared/agent-protocol";
import {
  extractEventRootSessionId,
  extractEventSessionId,
  log,
  truncateEventPayload,
} from "@/utils";

type UnknownRecord = Record<string, unknown>;

export type ScheduledQuestionDelivery = {
  messageId?: string;
  realThreadId: string;
};

export type ScheduledRunInteraction = {
  requestId: string;
  sessionId: string;
  kind: "question" | "permission";
  askedAt: number;
  permission?: string;
  patterns?: string[];
  question?: string;
  realThreadId?: string;
};

export type ScheduledRunTool = {
  id?: string;
  name: string;
  status?: string;
  title?: string;
  detail?: string;
  updatedAt: number;
};

export type ScheduledRunDiagnostics = {
  sessionId: string;
  runId: string;
  lastEventAt: number;
  lastEventType: string;
  lastTool?: ScheduledRunTool;
  pendingInteractions: ScheduledRunInteraction[];
  interactionDeliveryError?: string;
};

export type ScheduledAgentRunObserver = {
  watch<T>(prompt: Promise<T>): Promise<T>;
  snapshot(): ScheduledRunDiagnostics;
  finish(status: "completed" | "failed", message?: string): Promise<void>;
};

export function categorizeScheduledRunError(
  error: unknown,
  diagnostics?: ScheduledRunDiagnostics | null,
): { message: string; suggestion: string } {
  const categorized = categorizeRuntimeError(error);
  if (!diagnostics || categorized.message !== "Request timed out") {
    return categorized;
  }

  const pending = diagnostics.pendingInteractions[0];
  if (pending) {
    const target = pending.permission
      ? `permission ${pending.permission}`
      : pending.question
        ? `question “${compact(pending.question, 120)}”`
        : pending.kind;
    const patterns = pending.patterns?.length
      ? ` (${pending.patterns.join(", ")})`
      : "";
    return {
      message: `Timed out waiting for ${target}${patterns}`,
      suggestion: "The request was posted to the IM thread but was not answered before the scheduled run limit.",
    };
  }

  if (diagnostics.lastTool) {
    const tool = diagnostics.lastTool;
    const detail = tool.detail ? `: ${tool.detail}` : tool.title ? `: ${tool.title}` : "";
    return {
      message: `Timed out while ${tool.name} was ${tool.status ?? "running"}${detail}`,
      suggestion: "Ode aborted the underlying agent session. Inspect the saved run events for the last provider response.",
    };
  }

  return {
    message: `Request timed out after the last ${diagnostics.lastEventType} event`,
    suggestion: "Ode aborted the underlying agent session. Inspect the saved run events for the provider timeline.",
  };
}

export type StartScheduledAgentRunObserverParams = {
  agent: AgentAdapter;
  sessionId: string;
  providerId: AgentProviderId;
  runId: string;
  threadKey: string;
  syntheticThreadId: string;
  channelId: string;
  workingDirectory: string;
  model?: string | null;
  agentResultDetailId?: string | null;
  requestMessageId: string;
  sendQuestion: (
    text: string,
    questions: readonly NormalizedQuestion[],
  ) => Promise<ScheduledQuestionDelivery>;
  seedRealThread: (delivery: ScheduledQuestionDelivery) => void;
};

class ScheduledInteractionDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduledInteractionDeliveryError";
  }
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function compact(value: unknown, maxLength = 280): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string"
    ? value
    : (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })();
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function requestIdFromEvent(event: UnknownRecord): string | undefined {
  const properties = asRecord(event.properties);
  return asString(properties?.requestID) ?? asString(properties?.id);
}

function sessionIdFromEvent(event: UnknownRecord, fallback: string): string {
  return extractEventSessionId(event) ?? fallback;
}

function clearPendingQuestionIfMatching(
  channelId: string,
  threadId: string | undefined,
  requestId: string,
): void {
  if (!threadId) return;
  const pending = getPendingQuestion(channelId, threadId);
  if (pending?.requestId === requestId) {
    clearPendingQuestion(channelId, threadId);
  }
}

function buildToolSnapshot(event: UnknownRecord, now: number): ScheduledRunTool | null {
  if (event.type !== "message.part.updated") return null;
  const part = asRecord(asRecord(event.properties)?.part);
  if (part?.type !== "tool") return null;
  const state = asRecord(part.state);
  const input = asRecord(state?.input);
  const detail = compact(
    input?.filePath
      ?? input?.path
      ?? input?.command
      ?? input?.pattern
      ?? input?.description,
  );
  return {
    id: asString(part.id),
    name: asString(part.tool) ?? "tool",
    status: asString(state?.status),
    title: asString(state?.title),
    detail,
    updatedAt: now,
  };
}

function toolEventType(tool: ScheduledRunTool): OdeRunEventType {
  if (tool.status === "completed") return "tool.completed";
  if (tool.status === "error" || tool.status === "failed") return "tool.failed";
  if (tool.status === "running" || tool.status === "pending") return "tool.started";
  return "tool.progress";
}

export async function startScheduledAgentRunObserver(
  params: StartScheduledAgentRunObserverParams,
): Promise<ScheduledAgentRunObserver> {
  await params.agent.ensureSession(params.sessionId);

  const startedAt = Date.now();
  const diagnostics: ScheduledRunDiagnostics = {
    sessionId: params.sessionId,
    runId: params.runId,
    lastEventAt: startedAt,
    lastEventType: "run.started",
    pendingInteractions: [],
  };
  const pendingInteractions = new Map<string, ScheduledRunInteraction>();
  const questionDetails = new Map<string, { detailId: string; realThreadId?: string }>();
  const deliveredRequestIds = new Set<string>();
  const deliveryTasks = new Set<Promise<void>>();
  let finished = false;
  let fatalReject!: (error: Error) => void;
  const fatal = new Promise<never>((_resolve, reject) => {
    fatalReject = reject;
  });
  // A provider event can arrive in the short interval between subscribing
  // and the scheduler calling watch(). Keep that rejection handled while
  // still allowing Promise.race below to observe it.
  void fatal.catch(() => {});

  const eventContext = {
    providerId: params.providerId,
    sessionId: params.sessionId,
    runId: params.runId,
  };

  function persistDiagnostics(): void {
    diagnostics.pendingInteractions = [...pendingInteractions.values()];
    if (!params.agentResultDetailId) return;
    try {
      updateAgentResultContext({
        detailId: params.agentResultDetailId,
        context: {
          runtimeDiagnostics: {
            ...diagnostics,
            pendingInteractions: [...diagnostics.pendingInteractions],
          },
        },
      });
    } catch (error) {
      log.warn("Failed to persist scheduled run diagnostics", {
        sessionId: params.sessionId,
        runId: params.runId,
        error: String(error),
      });
    }
  }

  function getSnapshot(): ScheduledRunDiagnostics {
    return {
      ...diagnostics,
      lastTool: diagnostics.lastTool ? { ...diagnostics.lastTool } : undefined,
      pendingInteractions: [...pendingInteractions.values()].map((item) => ({ ...item })),
    };
  }

  function persistEvents(events: OdeRunEvent[]): void {
    if (events.length === 0) return;
    try {
      recordOdeRunEvents(params.threadKey, events);
    } catch (error) {
      log.warn("Failed to persist scheduled run events", {
        sessionId: params.sessionId,
        runId: params.runId,
        count: events.length,
        error: String(error),
      });
    }
  }

  persistEvents([
    createOdeRunEvent(eventContext, "run.started", {
      transport: params.agent.getTransportForSession(params.sessionId),
      scheduled: true,
    }),
  ]);
  persistDiagnostics();

  function deliverQuestion(
    event: UnknownRecord,
    requestId: string,
    interaction: ScheduledRunInteraction,
  ): void {
    if (deliveredRequestIds.has(requestId)) return;
    const properties = asRecord(event.properties);
    const normalized = params.agent.normalizeQuestions(properties?.questions);
    if (normalized.length === 0) {
      const message = `Cannot deliver scheduled ${interaction.kind} ${requestId}: unsupported or empty question payload`;
      diagnostics.interactionDeliveryError = message;
      persistDiagnostics();
      void params.agent.abortSession(params.sessionId, params.workingDirectory);
      fatalReject(new ScheduledInteractionDeliveryError(message));
      return;
    }
    deliveredRequestIds.add(requestId);

    const task = (async () => {
      let questionDetailId: string | null = null;
      try {
        const detail = recordAgentQuestion({
          threadKey: params.threadKey,
          requestMessageId: params.requestMessageId,
          questionRequestId: requestId,
          questions: normalized,
          providerId: params.providerId,
          model: params.model,
          workingDirectory: params.workingDirectory,
          context: {
            runId: params.runId,
            sessionId: interaction.sessionId,
            interactionKind: interaction.kind,
            permission: interaction.permission ?? null,
            patterns: interaction.patterns ?? null,
          },
        });
        questionDetailId = detail.id;
      } catch (error) {
        log.warn("Failed to record scheduled agent question", {
          requestId,
          runId: params.runId,
          error: String(error),
        });
      }

      try {
        const text = formatSingleQuestionPrompt(normalized[0]!, 0, normalized.length);
        const delivery = await params.sendQuestion(text, normalized);
        params.seedRealThread(delivery);
        interaction.realThreadId = delivery.realThreadId;
        pendingInteractions.set(requestId, interaction);

        const pendingQuestion: PendingQuestion = {
          requestId,
          sessionId: interaction.sessionId,
          askedAt: interaction.askedAt,
          kind: interaction.kind,
          permission: interaction.permission,
          patterns: interaction.patterns,
          questions: normalized,
          messageTs: delivery.messageId,
          collectedAnswers: [],
          questionDetailId,
        };
        setPendingQuestion(params.channelId, params.syntheticThreadId, pendingQuestion);
        if (delivery.realThreadId !== params.syntheticThreadId) {
          setPendingQuestion(params.channelId, delivery.realThreadId, pendingQuestion);
        }
        questionDetails.set(requestId, {
          detailId: questionDetailId ?? "",
          realThreadId: delivery.realThreadId,
        });
        persistDiagnostics();
      } catch (error) {
        const message = `Failed to deliver scheduled agent question: ${String(error)}`;
        diagnostics.interactionDeliveryError = message;
        persistDiagnostics();
        void params.agent.abortSession(params.sessionId, params.workingDirectory);
        fatalReject(new ScheduledInteractionDeliveryError(message));
      }
    })();
    deliveryTasks.add(task);
    void task.finally(() => deliveryTasks.delete(task));
  }

  const unsubscribe = params.agent.subscribeToSession(params.sessionId, (globalEvent: unknown) => {
    const wrapper = asRecord(globalEvent);
    const event = asRecord(wrapper?.payload) ?? wrapper;
    if (!event) return;
    const eventSessionId = extractEventSessionId(event);
    const rootSessionId = extractEventRootSessionId(event);
    if (
      rootSessionId
        ? rootSessionId !== params.sessionId
        : eventSessionId && eventSessionId !== params.sessionId
    ) {
      return;
    }

    const now = Date.now();
    const eventType = asString(event.type) ?? "unknown";
    diagnostics.lastEventAt = now;
    diagnostics.lastEventType = eventType;
    const tool = buildToolSnapshot(event, now);
    if (tool) diagnostics.lastTool = tool;

    const events: OdeRunEvent[] = [
      createOdeRunEvent(
        { ...eventContext, timestamp: now },
        "provider.raw",
        { providerType: eventType, scheduled: true },
        { rawEvent: truncateEventPayload(event) },
      ),
    ];
    if (tool) {
      events.push(createOdeRunEvent(
        { ...eventContext, timestamp: now },
        toolEventType(tool),
        tool,
        { itemId: tool.id },
      ));
    }

    const properties = asRecord(event.properties);
    const requestId = requestIdFromEvent(event);
    if (eventType === "permission.asked" && requestId) {
      const autoApproved = properties?.odeAutoApproved === true;
      const patterns = Array.isArray(properties?.patterns)
        ? properties.patterns.filter((value): value is string => typeof value === "string")
        : undefined;
      const interaction: ScheduledRunInteraction = {
        requestId,
        sessionId: sessionIdFromEvent(event, params.sessionId),
        kind: "permission",
        askedAt: now,
        permission: asString(properties?.permission),
        patterns,
      };
      events.push(createOdeRunEvent(
        { ...eventContext, timestamp: now },
        "approval.requested",
        { ...interaction, autoApproved },
        { itemId: requestId },
      ));
      if (autoApproved) {
        pendingInteractions.delete(requestId);
        events.push(createOdeRunEvent(
          { ...eventContext, timestamp: now },
          "approval.resolved",
          { requestId, reply: "always", autoApproved: true },
          { itemId: requestId },
        ));
      } else {
        pendingInteractions.set(requestId, interaction);
      }
    }

    if (eventType === "question.asked" && requestId) {
      const permission = asRecord(properties?.odePermission);
      const normalized = params.agent.normalizeQuestions(properties?.questions);
      const existing = pendingInteractions.get(requestId);
      const interaction: ScheduledRunInteraction = existing ?? {
        requestId,
        sessionId: sessionIdFromEvent(event, params.sessionId),
        kind: permission ? "permission" : "question",
        askedAt: now,
        permission: asString(permission?.permission),
        patterns: Array.isArray(permission?.patterns)
          ? permission.patterns.filter((value): value is string => typeof value === "string")
          : undefined,
        question: normalized[0]?.question,
      };
      interaction.question = interaction.question ?? normalized[0]?.question;
      pendingInteractions.set(requestId, interaction);
      if (!existing) {
        events.push(createOdeRunEvent(
          { ...eventContext, timestamp: now },
          interaction.kind === "permission" ? "approval.requested" : "question.requested",
          interaction,
          { itemId: requestId },
        ));
      }
      deliverQuestion(event, requestId, interaction);
    }

    if (
      requestId
      && (
        eventType === "question.replied"
        || eventType === "question.rejected"
        || eventType === "permission.replied"
      )
    ) {
      const interaction = pendingInteractions.get(requestId);
      pendingInteractions.delete(requestId);
      const questionDetail = questionDetails.get(requestId);
      if (questionDetail?.detailId) {
        try {
          completeAgentQuestion({ detailId: questionDetail.detailId });
        } catch (error) {
          log.warn("Failed to complete scheduled agent question", {
            requestId,
            error: String(error),
          });
        }
      }
      clearPendingQuestionIfMatching(params.channelId, params.syntheticThreadId, requestId);
      clearPendingQuestionIfMatching(
        params.channelId,
        questionDetail?.realThreadId ?? interaction?.realThreadId,
        requestId,
      );
      events.push(createOdeRunEvent(
        { ...eventContext, timestamp: now },
        eventType === "permission.replied" || interaction?.kind === "permission"
          ? "approval.resolved"
          : "question.resolved",
        {
          requestId,
          resolution: eventType === "question.rejected" ? "rejected" : "replied",
        },
        { itemId: requestId },
      ));
    }

    persistEvents(events);
    persistDiagnostics();
  });

  return {
    watch<T>(prompt: Promise<T>): Promise<T> {
      return Promise.race([prompt, fatal]);
    },
    snapshot(): ScheduledRunDiagnostics {
      return getSnapshot();
    },
    async finish(status: "completed" | "failed", message?: string): Promise<void> {
      if (finished) return;
      finished = true;
      unsubscribe();
      if (deliveryTasks.size > 0) {
        await Promise.allSettled([...deliveryTasks]);
      }
      const snapshot = getSnapshot();
      persistDiagnostics();
      persistEvents([
        createOdeRunEvent(
          eventContext,
          status === "completed" ? "run.completed" : "run.failed",
          {
            message: message ?? null,
            diagnostics: snapshot,
          },
        ),
      ]);
      if (status === "failed") {
        for (const [requestId, interaction] of pendingInteractions) {
          const questionDetail = questionDetails.get(requestId);
          if (questionDetail?.detailId) {
            try {
              completeAgentQuestion({ detailId: questionDetail.detailId });
            } catch {
              // Best effort: the run failure is already persisted above.
            }
          }
          clearPendingQuestionIfMatching(params.channelId, params.syntheticThreadId, requestId);
          clearPendingQuestionIfMatching(
            params.channelId,
            questionDetail?.realThreadId ?? interaction.realThreadId,
            requestId,
          );
        }
        pendingInteractions.clear();
      }
    },
  };
}
