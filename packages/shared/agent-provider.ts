export const AGENT_PROVIDERS = [
  "opencode",
  "claudecode",
  "codex",
  "kimi",
  "kilo",
  "qwen",
  "goose",
  "pi",
  "openhands",
  "codebuddy",
  "crush",
] as const;

export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];

export const AGENT_PROVIDER_LABELS: Record<AgentProviderId, string> = {
  opencode: "OpenCode",
  claudecode: "Claude Code",
  codex: "Codex",
  kimi: "Kimi",
  kilo: "Kilo",
  qwen: "Qwen Code",
  goose: "Goose",
  pi: "Pi",
  openhands: "OpenHands",
  codebuddy: "CodeBuddy",
  crush: "Crush",
};

export const AGENT_PROVIDER_COMMANDS: Record<AgentProviderId, string> = {
  opencode: "opencode",
  claudecode: "claude",
  codex: "codex",
  kimi: "kimi",
  kilo: "kilo",
  qwen: "qwen",
  goose: "goose",
  pi: "pi",
  openhands: "openhands",
  codebuddy: "codebuddy",
  crush: "crush",
};

type AgentProviderMetadata = {
  aliases: readonly string[];
  supportsEventStream: boolean;
  supportsModelSelection: boolean;
};

export const AGENT_PROVIDER_MANIFEST: Record<AgentProviderId, AgentProviderMetadata> = {
  opencode: {
    aliases: [],
    supportsEventStream: true,
    supportsModelSelection: true,
  },
  claudecode: {
    aliases: ["claude"],
    supportsEventStream: false,
    supportsModelSelection: false,
  },
  codex: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
  kimi: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: false,
  },
  kilo: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
  qwen: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: false,
  },
  goose: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: false,
  },
  pi: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
  openhands: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
  codebuddy: {
    aliases: ["cbc"],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
  crush: {
    aliases: [],
    supportsEventStream: false,
    supportsModelSelection: true,
  },
};

const AGENT_PROVIDER_SET = new Set<string>(AGENT_PROVIDERS);
const AGENT_PROVIDER_ALIAS_MAP = new Map<string, AgentProviderId>(
  AGENT_PROVIDERS.flatMap((provider) =>
    AGENT_PROVIDER_MANIFEST[provider].aliases.map((alias) => [alias, provider] as const)
  )
);

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && AGENT_PROVIDER_SET.has(value);
}

export function normalizeAgentProviderId(
  value: unknown,
  fallback: AgentProviderId = "opencode"
): AgentProviderId {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (isAgentProviderId(normalized)) return normalized;
  return AGENT_PROVIDER_ALIAS_MAP.get(normalized) ?? fallback;
}

export function providerSupportsModelSelection(provider: AgentProviderId): boolean {
  return AGENT_PROVIDER_MANIFEST[provider].supportsModelSelection;
}

export function providerSupportsEventStream(provider: AgentProviderId): boolean {
  return AGENT_PROVIDER_MANIFEST[provider].supportsEventStream;
}

export function getAgentProviderLabel(provider: AgentProviderId): string {
  return AGENT_PROVIDER_LABELS[provider];
}

export function getAgentProviderRunningTitle(provider: AgentProviderId): string {
  return `${getAgentProviderLabel(provider)} is running...`;
}
