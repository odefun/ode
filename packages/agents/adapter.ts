import type { AgentAdapter, NormalizedQuestion } from "@/core/types";
import { getChannelAgentProvider } from "@/config";
import type { QuestionInfo } from "@opencode-ai/sdk/v2";
import { getAgentProviderLabel } from "@/shared/agent-provider";
import { getAgentProvider, type AgentProviderId } from "./registry";
import { getSessionClient } from "./opencode";
import { replyToQuestion as replyToClaudeQuestion } from "./claude";
import {
  buildStatusMessageByProvider,
} from "@/utils/status";

/**
 * Session → provider index. Intentionally unbounded: this map is used by
 * `abortSession`, `subscribeToSession`, `ensureSession`, and the task / cron
 * schedulers to dispatch to the correct agent client for a given session id.
 * Evicting an entry and falling back to a default provider would misroute
 * those calls, so this has to stay a correctness index, not a size-capped
 * cache.
 *
 * Practical growth is bounded by the number of unique session ids the daemon
 * has observed during its lifetime (~60 bytes/entry). A typical daemon sees
 * far fewer sessions than the per-turn event buffers we optimised elsewhere,
 * so the unbounded footprint here is acceptable.
 */
const sessionProviders = new Map<string, AgentProviderId>();

function getProviderForChannel(channelId: string): AgentProviderId {
  return getChannelAgentProvider(channelId);
}

function getProviderForSession(sessionId: string): AgentProviderId {
  return sessionProviders.get(sessionId) ?? "opencode";
}

function rememberSessionProvider(sessionId: string, providerId: AgentProviderId): void {
  sessionProviders.set(sessionId, providerId);
}

export type AgentAdapterOptions = {
  /**
   * Optional per-adapter provider override. When set, `getOrCreateSession`
   * uses this provider instead of the channel's configured agent. Downstream
   * calls (sendMessage, abort, subscribe, ...) remain keyed by the session id
   * as usual, since `getOrCreateSession` writes the chosen provider into the
   * `sessionProviders` map. Intended for schedulers that carry a per-job
   * agent override (e.g. one-time tasks).
   */
  providerOverride?: AgentProviderId | null;
};

export function createAgentAdapter(options: AgentAdapterOptions = {}): AgentAdapter {
  const { providerOverride } = options;
  const resolveProviderForChannel = (channelId: string): AgentProviderId =>
    providerOverride ?? getProviderForChannel(channelId);

  return {
    supportsEventStream: true,
    getProviderForSession(sessionId) {
      return getProviderForSession(sessionId);
    },
    getDisplayNameForSession(sessionId) {
      const providerId = getProviderForSession(sessionId);
      return getAgentProviderLabel(providerId);
    },
    async getOrCreateSession(channelId, threadId, cwd, env) {
      const providerId = resolveProviderForChannel(channelId);
      const provider = getAgentProvider(providerId);
      const result = await provider.getOrCreateSession(channelId, threadId, cwd, env);
      rememberSessionProvider(result.sessionId, providerId);
      return result;
    },
    async sendMessage(channelId, sessionId, message, cwd, options, context) {
      const providerId = getProviderForSession(sessionId);
      const provider = getAgentProvider(providerId);
      const responses = await provider.sendMessage(
        channelId,
        sessionId,
        message,
        cwd,
        options,
        context
      );
      rememberSessionProvider(sessionId, providerId);
      return responses;
    },
    async abortSession(sessionId, directory) {
      const provider = getAgentProvider(getProviderForSession(sessionId));
      await provider.abortSession(sessionId, directory);
    },
    async ensureSession(sessionId) {
      const provider = getAgentProvider(getProviderForSession(sessionId));
      await provider.ensureSession(sessionId);
    },
    subscribeToSession(sessionId, handler) {
      const provider = getAgentProvider(getProviderForSession(sessionId));
      return provider.subscribeToSession(sessionId, handler);
    },
    async replyToQuestion({ requestId, sessionId, directory, answers }) {
      const providerId = getProviderForSession(sessionId);
      if (providerId === "claudecode") {
        await replyToClaudeQuestion({ sessionId, requestId, answers });
        return;
      }
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
    },
    normalizeQuestions(questions: unknown): NormalizedQuestion[] {
      if (!Array.isArray(questions) || questions.length === 0) return [];
      return (questions as Array<QuestionInfo | Record<string, unknown>>)
        .map((question) => {
          const record = question as Record<string, unknown>;
          const promptRaw = typeof record.question === "string" ? record.question : "";
          const prompt = promptRaw.trim();
          const optionsRaw = Array.isArray(record.options) ? record.options : [];
          const options = optionsRaw
            .map((option): string => {
              if (!option) return "";
              if (typeof option === "string") return option;
              if (typeof option === "object") {
                const label = (option as Record<string, unknown>).label;
                if (typeof label === "string") return label;
              }
              return "";
            })
            .filter((label): label is string => label.length > 0);
          const multipleRaw = record.multiple ?? record.multiSelect;
          const multiple = typeof multipleRaw === "boolean" ? multipleRaw : undefined;
          const customRaw = record.custom;
          const custom = typeof customRaw === "boolean" ? customRaw : undefined;
          return {
            question: prompt,
            options: options.length > 0 ? options : undefined,
            multiple,
            custom,
          };
        })
        .filter((question) => question.question.length > 0);
    },
    buildStatusMessage({ request, workingPath, state, statusMessageFormat }) {
      const providerId = getProviderForSession(request.sessionId);
      return buildStatusMessageByProvider(
        providerId,
        request,
        workingPath,
        state,
        statusMessageFormat
      );
    },
  };
}
