import {
  isMessageProcessed,
  markMessageProcessed,
  markThreadActive,
  getPendingQuestion,
} from "@/config/local/sessions";
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
import type { OpenCodeOptions } from "@/agents";
import {
  BotRuntime,
  RuntimeKernel,
  ThreadRuntimeRegistry,
} from "@/core/kernel/runtime-kernel";
import { KernelCommandService, type KernelCommandHandler } from "@/core/kernel/command-service";
import type { InboundAdapter } from "@/ims/shared/inbound-adapter";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { SlackInboundAdapter } from "@/ims/slack/slack-inbound-adapter";
import { DiscordInboundAdapter } from "@/ims/discord/discord-inbound-adapter";
import { LarkInboundAdapter } from "@/ims/lark/lark-inbound-adapter";

export type RuntimeDeps = {
  platform: "slack" | "discord" | "lark";
  im: IMAdapter;
  agent: AgentAdapter;
  handleCommand?: KernelCommandHandler;
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

export class KernelRuntimeFacade {
  private readonly runtimeDeps: RuntimeDeps;
  private readonly state = createRuntimeState();
  private readonly runtimeKernel: RuntimeKernel;
  private readonly commandService: KernelCommandService;

  constructor(private readonly deps: RuntimeDeps) {
    this.runtimeDeps = {
      ...deps,
      im: createRateLimitedImAdapter(deps.im),
    };
    this.commandService = new KernelCommandService({
      handleCommand: this.deps.handleCommand,
    });

    const threadRuntimeRegistry = new ThreadRuntimeRegistry({
      ttlMs: 30 * 60 * 1000,
      sweepIntervalMs: 5 * 60 * 1000,
      onDecision: async (_threadKey, params) => {
        const { event, decision } = params;
        if (decision.kind === "ignore" || decision.kind === "command") return;
        markThreadActive(event.channelId, event.threadId);
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

    this.runtimeKernel = new RuntimeKernel({
      createBotRuntime: (botKey) => new BotRuntime(botKey, {
        inboundAdapter: createInboundAdapter(botKey.platform),
        handleCommand: async (event, commandName, args) => {
          await this.commandService.handle(event, commandName, args);
        },
        threadRuntimeRegistry,
      }),
    });
  }

  async handleInboundEvent(event: RawInboundEvent): Promise<void> {
    await this.dispatchCoreMessage(event);
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
      isTopLevel: false,
      mentionedBot: true,
      activeThread: true,
      rawText: selection,
      normalizedText: selection,
      receivedAtMs: Date.now(),
    });
  }

  async recoverPendingRequests(): Promise<void> {
    await recoverPendingRequestsInternal(this.runtimeDeps.im, this.deps.platform);
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

  private async dispatchCoreMessage(event: RawInboundEvent): Promise<void> {
    if (isMessageProcessed(event.channelId, event.threadId, event.messageId)) {
      log.debug("Skipping duplicate message", { messageId: event.messageId });
      return;
    }

    const context: RuntimeRequestContext = {
      channelId: event.channelId,
      rawChannelId: event.rawChannelId,
      replyThreadId: event.replyThreadId,
      threadId: event.threadId,
      userId: event.userId,
      messageId: event.messageId,
      botToken: event.botId,
    };

    const text = event.normalizedText.trim();

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

    markMessageProcessed(event.channelId, event.threadId, event.messageId);
    await this.runtimeKernel.handleInbound(event);
  }

}

function createInboundAdapter(platform: RuntimeDeps["platform"]): InboundAdapter {
  switch (platform) {
    case "slack":
      return new SlackInboundAdapter();
    case "discord":
      return new DiscordInboundAdapter();
    case "lark":
      return new LarkInboundAdapter();
  }
}
