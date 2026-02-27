import { claudeCodeAgent } from "./claude";
import { codexAgent } from "./codex";
import { kimiAgent } from "./kimi";
import { kiroAgent } from "./kiro";
import { kiloAgent } from "./kilo";
import { openCodeAgent } from "./opencode";
import { qwenAgent } from "./qwen";
import { gooseAgent } from "./goose";
import { geminiAgent } from "./gemini";
import {
  AGENT_PROVIDERS,
  normalizeAgentProviderId,
  providerSupportsEventStream,
  type AgentProviderId,
} from "@/shared/agent-provider";
export type { AgentProviderId } from "@/shared/agent-provider";
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
} from "./types";

export type AgentProvider = {
  id: AgentProviderId;
  supportsEventStream: boolean;
  startServer: () => Promise<void>;
  stopServer: () => void | Promise<void>;
  createSession: (workingPath: string, env?: Record<string, string>) => Promise<string>;
  getOrCreateSession: (
    channelId: string,
    threadId: string,
    workingPath: string,
    env?: Record<string, string>
  ) => Promise<OpenCodeSessionInfo>;
  sendMessage: (
    channelId: string,
    sessionId: string,
    message: string,
    workingPath: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ) => Promise<OpenCodeMessage[]>;
  abortSession: (sessionId: string, directory?: string) => Promise<void>;
  cancelActiveRequest: (channelId: string, sessionId: string, directory?: string) => Promise<boolean>;
  ensureSession: (sessionId: string) => Promise<void>;
  subscribeToSession: (sessionId: string, handler: (event: unknown) => void) => () => void;
};

type AgentProviderRuntime = Omit<AgentProvider, "id" | "supportsEventStream">;

const providerModules = {
  opencode: openCodeAgent,
  claudecode: claudeCodeAgent,
  codex: codexAgent,
  kimi: kimiAgent,
  kiro: kiroAgent,
  kilo: kiloAgent,
  qwen: qwenAgent,
  goose: gooseAgent,
  gemini: geminiAgent,
} satisfies Record<AgentProviderId, AgentProviderRuntime>;

function createProvider(providerId: AgentProviderId): AgentProvider {
  const runtime = providerModules[providerId] as AgentProviderRuntime;
  return {
    id: providerId,
    supportsEventStream: providerSupportsEventStream(providerId),
    startServer: (...args) => runtime.startServer(...args),
    stopServer: (...args) => runtime.stopServer(...args),
    createSession: (...args) => runtime.createSession(...args),
    getOrCreateSession: (...args) => runtime.getOrCreateSession(...args),
    sendMessage: (...args) => runtime.sendMessage(...args),
    abortSession: (...args) => runtime.abortSession(...args),
    cancelActiveRequest: (...args) => runtime.cancelActiveRequest(...args),
    ensureSession: (...args) => runtime.ensureSession(...args),
    subscribeToSession: (...args) => runtime.subscribeToSession(...args),
  };
}

const providers: Record<AgentProviderId, AgentProvider> = Object.fromEntries(
  AGENT_PROVIDERS.map((providerId) => [providerId, createProvider(providerId)])
) as Record<AgentProviderId, AgentProvider>;

export function getSelectedAgentProviderId(): AgentProviderId {
  return normalizeAgentProviderId(process.env.ODE_AGENT_PROVIDER);
}

export function getSelectedAgentProvider(): AgentProvider {
  return providers[getSelectedAgentProviderId()];
}

export function getAgentProvider(providerId: AgentProviderId): AgentProvider {
  return providers[providerId];
}
