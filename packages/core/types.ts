import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
} from "@/agents";
import type { StatusMessageFormat } from "@/config";
import type { AgentProviderId } from "@/shared/agent-provider";
import type { SessionMessageState } from "@/utils/session-inspector";

export type CoreMessageContext = {
  channelId: string;
  rawChannelId?: string;
  replyThreadId: string;
  threadId: string;
  userId: string;
  messageId: string;
  workspaceName?: string;
  botToken?: string;
};

export type AgentContextBuilderParams = {
  cwd: string;
  channelId: string;
  replyThreadId: string;
  threadId: string;
  userId: string;
  threadHistory?: string | null;
};

export type NormalizedQuestion = {
  question: string;
  options?: string[];
  multiple?: boolean;
  custom?: boolean;
};

export type StatusMessageRequest = {
  sessionId: string;
  channelId: string;
  threadId: string;
  statusMessageTs: string;
  startedAt: number;
  currentText: string;
  statusFrozen?: boolean;
};

export type AgentStatusMessageParams = {
  request: StatusMessageRequest;
  workingPath: string;
  state?: SessionMessageState;
  statusMessageFormat: StatusMessageFormat;
};

export interface IMAdapter {
  maxEditableMessageChars?: number;
  sendMessage(channelId: string, threadId: string, text: string): Promise<string | undefined>;
  updateMessage(
    channelId: string,
    messageTs: string,
    text: string
  ): Promise<string | undefined | void>;
  wasRateLimited?(channelId: string, messageTs: string): boolean;
  getRateLimitError?(channelId: string, messageTs: string): string | undefined;
  deleteMessage(channelId: string, messageTs: string): Promise<void>;
  fetchThreadHistory(channelId: string, threadId: string, messageId: string): Promise<string | null>;
  buildAgentContext(params: AgentContextBuilderParams): Promise<OpenCodeMessageContext>;
  renameThread?(channelId: string, threadId: string, name: string): Promise<void>;
}

export interface AgentAdapter {
  supportsEventStream: boolean;
  enqueueMessage(
    context: CoreMessageContext,
    text: string,
    process: (context: CoreMessageContext, text: string) => Promise<void>
  ): void;
  getProviderForSession(sessionId: string): AgentProviderId;
  getDisplayNameForSession(sessionId: string): string;
  getOrCreateSession(
    channelId: string,
    threadId: string,
    cwd: string,
    env: Record<string, string>
  ): Promise<OpenCodeSessionInfo>;
  sendMessage(
    channelId: string,
    sessionId: string,
    message: string,
    cwd: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ): Promise<OpenCodeMessage[]>;
  abortSession(sessionId: string, directory?: string): Promise<void>;
  ensureSession(sessionId: string): Promise<void>;
  subscribeToSession(sessionId: string, handler: (event: unknown) => void): () => void;
  replyToQuestion(params: {
    requestId: string;
    sessionId: string;
    directory?: string;
    answers: Array<Array<string>>;
  }): Promise<void>;
  normalizeQuestions(questions: unknown): NormalizedQuestion[];
  buildStatusMessage?(params: AgentStatusMessageParams): string;
}
