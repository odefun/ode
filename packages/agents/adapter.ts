import type {
  AgentAdapter,
  AgentStatusMessageParams,
  CoreMessageContext,
  NormalizedQuestion,
} from "@/core/types";
import { getChannelAgentProvider } from "@/config";
import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { getAgentProviderLabel } from "@/shared/agent-provider";
import { getAgentProvider, type AgentProviderId } from "./registry";
import { getSessionClient } from "./opencode";
import { buildStatusMessageByProvider } from "@/utils/status";
import { log } from "@/utils";
import type { OpenCodeMessageContext, OpenCodeOptions } from "./types";

type QueueItem = {
  context: CoreMessageContext;
  text: string;
  process: (context: CoreMessageContext, text: string) => Promise<void>;
};

type QueueState = {
  processing: boolean;
  items: QueueItem[];
};

class AgentMessageProcessor implements AgentAdapter {
  readonly supportsEventStream = true;
  private readonly sessionProviders = new Map<string, AgentProviderId>();
  private readonly queues = new Map<string, QueueState>();

  enqueueMessage(
    context: CoreMessageContext,
    text: string,
    process: (context: CoreMessageContext, text: string) => Promise<void>
  ): void {
    const queueKey = `${context.channelId}-${context.threadId}`;
    const queue = this.queues.get(queueKey) ?? { processing: false, items: [] };
    queue.items.push({ context, text, process });
    this.queues.set(queueKey, queue);

    if (!queue.processing) {
      void this.processQueue(queueKey);
    }
  }

  private async processQueue(queueKey: string): Promise<void> {
    const queue = this.queues.get(queueKey);
    if (!queue || queue.processing) return;

    queue.processing = true;
    while (queue.items.length > 0) {
      const batch = queue.items.splice(0);
      const next = batch[0];
      if (!next) continue;
      const combinedText = batch.map((item) => item.text).join("\n");
      try {
        await next.process(next.context, combinedText);
      } catch (err) {
        log.error("Queued message processing failed", { error: String(err) });
      }
    }
    queue.processing = false;

    if (queue.items.length === 0) {
      this.queues.delete(queueKey);
      return;
    }

    void this.processQueue(queueKey);
  }

  getProviderForSession(sessionId: string): AgentProviderId {
    return this.sessionProviders.get(sessionId) ?? "opencode";
  }

  getDisplayNameForSession(sessionId: string): string {
    const providerId = this.getProviderForSession(sessionId);
    return getAgentProviderLabel(providerId);
  }

  private rememberSessionProvider(sessionId: string, providerId: AgentProviderId): void {
    this.sessionProviders.set(sessionId, providerId);
  }

  async getOrCreateSession(channelId: string, threadId: string, cwd: string, env: Record<string, string>) {
    const providerId = getChannelAgentProvider(channelId);
    const provider = getAgentProvider(providerId);
    const result = await provider.getOrCreateSession(channelId, threadId, cwd, env);
    this.rememberSessionProvider(result.sessionId, providerId);
    return result;
  }

  async sendMessage(
    channelId: string,
    sessionId: string,
    message: string,
    cwd: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ) {
    const providerId = this.getProviderForSession(sessionId);
    const provider = getAgentProvider(providerId);
    const responses = await provider.sendMessage(
      channelId,
      sessionId,
      message,
      cwd,
      options,
      context
    );
    this.rememberSessionProvider(sessionId, providerId);
    return responses;
  }

  async abortSession(sessionId: string, directory?: string) {
    const provider = getAgentProvider(this.getProviderForSession(sessionId));
    await provider.abortSession(sessionId, directory);
  }

  async ensureSession(sessionId: string) {
    const provider = getAgentProvider(this.getProviderForSession(sessionId));
    await provider.ensureSession(sessionId);
  }

  subscribeToSession(sessionId: string, handler: (event: unknown) => void) {
    const provider = getAgentProvider(this.getProviderForSession(sessionId));
    return provider.subscribeToSession(sessionId, handler);
  }

  async replyToQuestion(params: {
    requestId: string;
    sessionId: string;
    directory?: string;
    answers: Array<Array<string>>;
  }) {
    const { requestId, sessionId, directory, answers } = params;
    const providerId = this.getProviderForSession(sessionId);
    if (providerId !== "opencode") {
      throw new Error(`Question replies are not supported for agent: ${providerId}`);
    }
    const client = await getSessionClient(sessionId);
    const response = await client.question.reply({
      requestID: requestId,
      directory,
      answers,
    });
    if (response.error) {
      throw new Error(`OpenCode question reply error: ${response.error}`);
    }
  }

  normalizeQuestions(questions: unknown): NormalizedQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) return [];
    return (questions as QuestionInfo[])
      .map((question) => {
        const prompt = typeof question.question === "string" ? question.question.trim() : "";
        const options = Array.isArray(question.options)
          ? question.options
              .map((option) => (typeof option?.label === "string" ? option.label : ""))
              .filter((label) => label.length > 0)
          : undefined;
        return {
          question: prompt,
          options: options && options.length > 0 ? options : undefined,
          multiple: question.multiple,
          custom: question.custom,
        };
      })
      .filter((question) => question.question.length > 0);
  }

  buildStatusMessage(params: AgentStatusMessageParams) {
    const { request, workingPath, state, statusMessageFormat } = params;
    const providerId = this.getProviderForSession(request.sessionId);
    return buildStatusMessageByProvider(
      providerId,
      request,
      workingPath,
      state,
      statusMessageFormat
    );
  }
}

export function createAgentAdapter(): AgentAdapter {
  return new AgentMessageProcessor();
}
