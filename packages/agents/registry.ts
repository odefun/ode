import * as claude from "./claude";
import * as codex from "./codex";
import * as kimi from "./kimi";
import * as kilo from "./kilo";
import * as opencode from "./opencode";
import * as qwen from "./qwen";
import * as goose from "./goose";
import * as pi from "./pi";
import * as openhands from "./openhands";
import * as codebuddy from "./codebuddy";
import * as crush from "./crush";
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
  AgentInput,
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
    input: AgentInput,
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
  opencode,
  claudecode: claude,
  codex,
  kimi,
  kilo,
  qwen,
  goose,
  pi,
  openhands,
  codebuddy,
  crush,
} satisfies Record<AgentProviderId, AgentProviderRuntime>;

function createProvider(providerId: AgentProviderId): AgentProvider {
  return {
    id: providerId,
    supportsEventStream: providerSupportsEventStream(providerId),
    ...providerModules[providerId],
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
