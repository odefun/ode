import {
  isMessageProcessed,
  markMessageProcessed,
  markThreadActive,
  getPendingQuestion,
} from "@/config/local/sessions";
import {
  ensureMessageThread,
  recordUserPrompt,
  startAgentResult,
  buildThreadKey,
} from "@/config/local/inbox";
import { getChannelModel } from "@/config";
import { type SessionEvent, type SessionMessageState, log } from "@/utils";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import { handlePendingQuestionReply } from "@/core/kernel/pending-question";
import { recoverPendingRequests as recoverPendingRequestsInternal } from "@/core/kernel/recovery";
import { prepareRuntimeSession } from "@/core/kernel/session-bootstrap";
import { runOpenRequest } from "@/core/kernel/request-run";
import { maybeSyncBranchAndThread, publishFinalText } from "@/core/kernel/runtime-support";
import { handleStopCommand } from "@/core/kernel/stop-command";
import { buildMessageOptions } from "@/core/runtime/message-options";
import { createRateLimitedImAdapter } from "@/core/runtime/message-updates";
import { defaultInboundPolicy } from "@/ims/shared/inbound-policy";
import type { OpenCodeOptions } from "@/agents";
import {
  BotRuntime,
  RuntimeKernel,
  ThreadRuntimeRegistry,
} from "@/core/kernel/runtime-kernel";
import type { InboundAdapter } from "@/ims/shared/inbound-adapter";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";

export type RuntimeDeps = {
  platform: "slack" | "discord" | "lark";
  im: IMAdapter;
  agent: AgentAdapter;
};

type RuntimeState = {
  liveEventHistory: Map<string, SessionEvent[]>;
  liveParsedState: Map<string, SessionMessageState>;
};

function createRuntimeState(): RuntimeState {
  return {
    liveEventHistory: new Map(),
    liveParsedState: new Map(),
  };
}

function resolveInboxModel(options: OpenCodeOptions | undefined, fallbackModel: string | null): string | null {
  const explicitModel = options?.model;
  if (explicitModel?.providerID && explicitModel.modelID) {
    return `${explicitModel.providerID}/${explicitModel.modelID}`;
  }
  const normalizedFallback = fallbackModel?.trim();
  return normalizedFallback && normalizedFallback.length > 0 ? normalizedFallback : null;
}

function buildThreadContextSnapshot(params: {
  created: boolean;
  threadOwnerUserId: string;
  botToken?: string;
  branchName?: string;
  agentContext: Awaited<ReturnType<IMAdapter["buildAgentContext"]>>;
  options?: OpenCodeOptions;
}): Record<string, unknown> {
  const {
    created,
    threadOwnerUserId,
    botToken,
    branchName,
    agentContext,
    options,
  } = params;
  const platformContext = agentContext.slack;
  const threadHistory = agentContext.threadHistory ?? platformContext?.threadHistory;

  return {
    isFirstMessageInThread: created,
    threadOwnerUserId,
    botToken: botToken ?? null,
    branchName: branchName ?? null,
    agent: options?.agent ?? null,
    reasoningEffort: options?.reasoningEffort ?? null,
    hasThreadHistory: typeof threadHistory === "string" && threadHistory.length > 0,
    threadHistoryChars: typeof threadHistory === "string" ? threadHistory.length : 0,
    hasChannelSystemMessage: Boolean(platformContext?.channelSystemMessage),
    hasGitHubToken: Boolean(platformContext?.hasGitHubToken),
    platformContext: platformContext
      ? {
          platform: platformContext.platform ?? null,
          channelId: platformContext.channelId,
          threadId: platformContext.threadId,
          userId: platformContext.userId,
        }
      : null,
  };
}

function buildAgentDetailContext(params: {
  options?: OpenCodeOptions;
  created: boolean;
}): Record<string, unknown> {
  return {
    isFirstMessageInThread: params.created,
    agent: params.options?.agent ?? null,
    reasoningEffort: params.options?.reasoningEffort ?? null,
  };
}

export class KernelRuntimeFacade {
  private readonly runtimeDeps: RuntimeDeps;
  private readonly state = createRuntimeState();
  private readonly runtimeKernel: RuntimeKernel;

  constructor(private readonly deps: RuntimeDeps) {
    this.runtimeDeps = {
      ...deps,
      im: createRateLimitedImAdapter(deps.im),
    };

    const threadRuntimeRegistry = new ThreadRuntimeRegistry({
      ttlMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      onDecision: async (_threadKey, params) => {
        const { event, decision } = params;
        if (decision.kind === "ignore") return;
        if (decision.kind === "stop") {
          await handleStopCommand({ deps: this.runtimeDeps, channelId: event.channelId, threadId: event.threadId });
          return;
        }

        await this.handleUserMessageInternal(
          {
            channelId: event.channelId,
            rawChannelId: event.rawChannelId,
            replyThreadId: event.replyThreadId,
            threadId: event.threadId,
            userId: event.userId,
            messageId: event.messageId,
            botToken: event.botId,
          },
          decision.text
        );
      },
    });

    const inboundAdapter: InboundAdapter = {
      evaluate: (event) => defaultInboundPolicy({
        selfMessage: event.selfMessage,
        threadOwnerMessage: event.threadOwnerMessage,
        isTopLevel: event.isTopLevel,
        hasAnyMention: event.hasAnyMention ?? event.mentionedBot,
        mentionedBot: event.mentionedBot,
        activeThread: event.activeThread,
        ambientMode: event.ambientMode,
        normalizedText: event.normalizedText,
      }),
    };

    this.runtimeKernel = new RuntimeKernel({
      createBotRuntime: (botKey) => new BotRuntime(botKey, {
        inboundAdapter,
        threadRuntimeRegistry,
      }),
    });
  }

  async handleInboundEvent(event: RawInboundEvent): Promise<void> {
    const decision = defaultInboundPolicy({
      selfMessage: event.selfMessage,
      threadOwnerMessage: event.threadOwnerMessage,
      isTopLevel: event.isTopLevel,
      hasAnyMention: event.hasAnyMention ?? event.mentionedBot,
      mentionedBot: event.mentionedBot,
      activeThread: event.activeThread,
      ambientMode: event.ambientMode,
      normalizedText: event.normalizedText,
    });

    if (decision.kind === "ignore") {
      return;
    }

    if (decision.kind === "stop") {
      const stopped = await handleStopCommand({
        deps: this.runtimeDeps,
        channelId: event.channelId,
        threadId: event.threadId,
      });
      if (stopped) {
        await this.runtimeDeps.im.sendMessage(event.rawChannelId ?? event.channelId, event.replyThreadId, "Request stopped.");
      }
      return;
    }

    markThreadActive(event.channelId, event.threadId, event.botId);
    await this.dispatchCoreMessage(
      {
        channelId: event.channelId,
        rawChannelId: event.rawChannelId,
        replyThreadId: event.replyThreadId,
        threadId: event.threadId,
        userId: event.userId,
        messageId: event.messageId,
        botToken: event.botId,
      },
      decision.text
    );
  }

  async handleButtonSelection(params: {
    channelId: string;
    rawChannelId?: string;
    replyThreadId: string;
    threadId: string;
    userId: string;
    selection: string;
    messageTs: string;
  }): Promise<void> {
    const { channelId, rawChannelId, replyThreadId, threadId, userId, selection, messageTs } = params;
    await this.handleInboundEvent({
      platform: this.deps.platform,
      botId: "default",
      channelId,
      rawChannelId,
      threadId,
      replyThreadId,
      messageId: messageTs,
      userId,
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: true,
      activeThread: true,
      ambientMode: false,
      rawText: selection,
      normalizedText: selection,
      receivedAtMs: Date.now(),
    });
  }

  async recoverPendingRequests(options?: { startedBeforeMs?: number }): Promise<void> {
    await recoverPendingRequestsInternal(this.runtimeDeps.im, this.deps.platform, options);
  }

  private async handleUserMessageInternal(context: RuntimeRequestContext, text: string): Promise<void> {
    const { channelId, replyThreadId, threadId } = context;
    const rawChannelId = context.rawChannelId ?? channelId;
    const prepared = await prepareRuntimeSession({
      deps: this.runtimeDeps,
      context,
    });
    if (!prepared) return;

    const { session, sessionId, created, cwd, threadOwnerUserId } = prepared;

    await maybeSyncBranchAndThread({ session, cwd });

    const threadHistory = created
      ? await this.runtimeDeps.im.fetchThreadHistory(rawChannelId, replyThreadId, context.messageId)
      : null;

    const agentContext = await this.runtimeDeps.im.buildAgentContext({
      cwd,
      channelId: rawChannelId,
      replyThreadId,
      threadId,
      userId: threadOwnerUserId,
      threadHistory,
    });

    const providerId = this.deps.agent.getProviderForSession(sessionId);
    const options: OpenCodeOptions | undefined = buildMessageOptions({
      text,
      channelId,
      providerId,
    });
    const threadContextSnapshot = buildThreadContextSnapshot({
      created,
      threadOwnerUserId,
      botToken: context.botToken,
      branchName: session.branchName,
      agentContext,
      options,
    });
    const resolvedModel = resolveInboxModel(options, getChannelModel(rawChannelId));
    const threadKey = buildThreadKey(context.channelId, context.threadId);
    let agentResultDetailId: string | null = null;
    try {
      ensureMessageThread({
        platform: this.deps.platform,
        channelId: context.channelId,
        rawChannelId,
        threadId: context.threadId,
        replyThreadId: context.replyThreadId,
        sessionId,
        providerId,
        model: resolvedModel,
        workingDirectory: cwd,
        threadOwnerUserId,
        branchName: session.branchName,
        sourceKind: "user",
        context: threadContextSnapshot,
      });
      recordUserPrompt({
        threadKey,
        messageId: context.messageId,
        userId: context.userId,
        promptText: text,
      });
      const agentDetail = startAgentResult({
        threadKey,
        requestMessageId: context.messageId,
        providerId,
        model: resolvedModel,
        workingDirectory: cwd,
        context: buildAgentDetailContext({ options, created }),
      });
      agentResultDetailId = agentDetail.id;
    } catch (error) {
      log.warn("Failed to record inbox message", {
        channelId: context.channelId,
        threadId: context.threadId,
        messageId: context.messageId,
        error: String(error),
      });
    }

    const responses = await runOpenRequest({
      deps: {
        ...this.runtimeDeps,
        platform: this.deps.platform,
      },
      session,
      context,
      sessionId,
      cwd,
      message: text,
      isFirstMessageInThread: created,
      agentContext,
      options,
      agentResultDetailId,
      threadKey,
      liveEventHistory: this.state.liveEventHistory,
      liveParsedState: this.state.liveParsedState,
      publishFinalText: async (params) => {
        await publishFinalText({
          im: this.runtimeDeps.im,
          ...params,
        });
      },
    });

    if (!responses) return;
  }

  private async dispatchCoreMessage(context: RuntimeRequestContext, text: string): Promise<void> {
    if (isMessageProcessed(context.channelId, context.threadId, context.messageId)) {
      log.debug("Skipping duplicate message", { messageId: context.messageId });
      return;
    }

    const pendingQuestion = getPendingQuestion(context.channelId, context.threadId);
    if (pendingQuestion) {
      const handled = await handlePendingQuestionReply({
        deps: this.runtimeDeps,
        pendingQuestion,
        context,
        text,
      });
      if (handled) {
        return;
      }
    }

    markMessageProcessed(context.channelId, context.threadId, context.messageId);
    await this.runtimeKernel.handleInbound({
      platform: this.deps.platform,
      botId: context.botToken ?? "default",
      channelId: context.channelId,
      rawChannelId: context.rawChannelId,
      threadId: context.threadId,
      replyThreadId: context.replyThreadId,
      messageId: context.messageId,
      userId: context.userId,
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: true,
      activeThread: true,
      ambientMode: false,
      rawText: text,
      normalizedText: text,
      receivedAtMs: Date.now(),
    });
  }

}
