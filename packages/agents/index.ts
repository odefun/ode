import { getAgentProvider, getSelectedAgentProvider } from "./registry";
import { AGENT_PROVIDERS } from "@/shared/agent-provider";

export type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
  AgentInput,
  AgentInputPart,
  AgentCapabilities,
  AgentSessionBinding,
  AgentTransport,
} from "./types";

const agent = getSelectedAgentProvider();

export const selectedAgent = agent.id;
export const supportsEventStream = agent.supportsEventStream;

export const startServer = agent.startServer;
export const stopServer = agent.stopServer;
export const createSession = agent.createSession;
export const getOrCreateSession = agent.getOrCreateSession;
export const sendMessage = agent.sendMessage;
export const abortSession = agent.abortSession;
export const cancelActiveRequest = agent.cancelActiveRequest;
export const ensureSession = agent.ensureSession;
export const subscribeToSession = agent.subscribeToSession;

export async function stopAllServers(): Promise<void> {
  await Promise.allSettled(
    AGENT_PROVIDERS.map((providerId) => Promise.resolve().then(() => getAgentProvider(providerId).stopServer()))
  );
}
