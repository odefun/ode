import type { AgentProviderId } from "@/shared/agent-provider";
import {
  LEGACY_AGENT_CAPABILITIES,
  type AgentCapabilities,
  type AgentTransport,
} from "@/shared/agent-protocol";

const fullSessions = {
  create: true,
  resume: true,
  load: true,
  list: true,
  delete: true,
  close: true,
  fork: true,
};

const structuredEvents = {
  message: true,
  reasoningSummary: true,
  plan: true,
  tool: true,
  command: true,
  fileDiff: true,
  usage: true,
};

const nativeCapabilities: AgentCapabilities = {
  sessions: fullSessions,
  input: { text: true, image: true, resource: true, fileRef: true },
  events: structuredEvents,
  interaction: { approval: true, question: true, cancel: true },
};

const acpCapabilities: AgentCapabilities = {
  // ACP guarantees new/prompt/cancel/update. All other lifecycle methods are
  // negotiated per connection and are therefore conservative here; the
  // binding is refreshed with the actual handshake after the first turn.
  sessions: {
    create: true,
    resume: false,
    load: false,
    list: false,
    delete: false,
    close: false,
    fork: false,
  },
  input: { text: true, image: true, resource: true, fileRef: true },
  events: structuredEvents,
  interaction: { approval: true, question: false, cancel: true },
};

export const AGENT_TRANSPORTS: Record<AgentProviderId, AgentTransport> = {
  opencode: "server-sdk",
  claudecode: "native-sdk",
  codex: "native-app-server",
  kimi: "acp",
  kilo: "acp",
  qwen: "cli-json",
  goose: "acp",
  pi: "cli-json",
  openhands: "cli-json",
  codebuddy: "acp",
  crush: "cli-json",
};

export const AGENT_CAPABILITIES: Record<AgentProviderId, AgentCapabilities> = {
  opencode: nativeCapabilities,
  claudecode: nativeCapabilities,
  codex: nativeCapabilities,
  kimi: acpCapabilities,
  kilo: acpCapabilities,
  qwen: LEGACY_AGENT_CAPABILITIES,
  goose: acpCapabilities,
  pi: LEGACY_AGENT_CAPABILITIES,
  openhands: LEGACY_AGENT_CAPABILITIES,
  codebuddy: acpCapabilities,
  crush: LEGACY_AGENT_CAPABILITIES,
};

export function getAgentTransport(providerId: AgentProviderId): AgentTransport {
  return AGENT_TRANSPORTS[providerId];
}

export function getAgentCapabilities(providerId: AgentProviderId): AgentCapabilities {
  return AGENT_CAPABILITIES[providerId];
}
