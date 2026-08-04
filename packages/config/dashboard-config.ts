import {
  DEFAULT_STATUS_MESSAGE_FREQUENCY_MS,
  parseStatusMessageFrequencyMs,
  type StatusMessageFrequencyMs,
} from "./status-message-frequency";
import {
  normalizeGitStrategy,
  normalizeStatusMessageFormat,
  type GitStrategy,
  type StatusMessageFormat,
} from "./baseConfig";
import {
  AGENT_PROVIDERS,
  normalizeAgentProviderId,
  providerSupportsModelSelection,
  type AgentProviderId,
} from "@/shared/agent-provider";

export type DashboardConfig = {
  completeOnboarding: boolean;
  user: {
    name: string;
    email: string;
    initials?: string;
    avatar?: string;
    gitStrategy: GitStrategy;
    defaultStatusMessageFormat: StatusMessageFormat;
    statusMessageFrequencyMs?: StatusMessageFrequencyMs;
  };
  updates: {
    autoUpgrade: boolean;
  };
  computerGateway: {
    enabled: boolean;
    browserDriver: "agent-browser";
    desktopDriver: "ode";
    browserExecutable: string;
    desktopExecutable: string;
    browserHeaded: boolean;
    commandTimeoutMs: number;
    approvalTimeoutMs: number;
  };
  agents: {
    opencode: {
      enabled: boolean;
      models: string[];
    };
    claudecode: {
      enabled: boolean;
    };
    codex: {
      enabled: boolean;
      models: string[];
    };
    kimi: {
      enabled: boolean;
    };
    kilo: {
      enabled: boolean;
      models: string[];
    };
    qwen: {
      enabled: boolean;
    };
    goose: {
      enabled: boolean;
    };
    pi: {
      enabled: boolean;
      models: string[];
    };
    openhands: {
      enabled: boolean;
      models: string[];
    };
    codebuddy: {
      enabled: boolean;
      models: string[];
    };
    crush: {
      enabled: boolean;
      models: string[];
    };
  };
  workspaces: {
    id: string;
    type: "slack" | "discord" | "lark";
    name: string;
    domain: string;
    status: "active" | "paused";
    channels: number;
    members: number;
    lastSync: string;
    slackAppToken?: string;
    slackBotToken?: string;
    discordBotToken?: string;
    larkAppKey?: string;
    larkAppId?: string;
    larkAppSecret?: string;
    channelDetails: {
      id: string;
      name: string;
      agentProvider?: AgentProviderId;
      model: string;
      workingDirectory: string;
      baseBranch: string;
      channelSystemMessage?: string;
      computerUse?: {
        browser: "off" | "observe" | "interact";
        desktop: "off" | "observe" | "control";
        browserProfile: string;
        allowedOrigins: string[];
        allowedApps: string[];
        approvalPolicy: "consequential" | "always" | "never";
      };
    }[];
  }[];
};

const defaultWorkspace: DashboardConfig["workspaces"][number] = {
  id: "workspace-1",
  type: "slack",
  name: "Workspace 1",
  domain: "",
  status: "active",
  channels: 0,
  members: 0,
  lastSync: "",
  channelDetails: [],
};

export const defaultDashboardConfig: DashboardConfig = {
  completeOnboarding: false,
  user: {
    name: "",
    email: "",
    gitStrategy: "worktree",
    defaultStatusMessageFormat: "medium",
    statusMessageFrequencyMs: DEFAULT_STATUS_MESSAGE_FREQUENCY_MS,
  },
  updates: {
    autoUpgrade: true,
  },
  computerGateway: {
    enabled: false,
    browserDriver: "agent-browser",
    desktopDriver: "ode",
    browserExecutable: "agent-browser",
    desktopExecutable: "ode",
    browserHeaded: false,
    commandTimeoutMs: 30_000,
    approvalTimeoutMs: 10 * 60_000,
  },
  agents: createDefaultAgentsConfig(),
  workspaces: [],
};

const cloneDefaultDashboardConfig = (): DashboardConfig => structuredClone(defaultDashboardConfig);

const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const asBaseBranch = (value: unknown) => {
  const normalized = asString(value).trim();
  return normalized.length > 0 ? normalized : "main";
};

const asNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const asFrequency = (
  value: unknown
): DashboardConfig["user"]["defaultStatusMessageFormat"] => {
  return normalizeStatusMessageFormat(value);
};

const asStatusMessageFrequencyMs = (value: unknown): StatusMessageFrequencyMs =>
  parseStatusMessageFrequencyMs(value);

const asGitStrategy = (
  value: unknown
): DashboardConfig["user"]["gitStrategy"] =>
  normalizeGitStrategy(value);

const asStatus = (value: unknown): DashboardConfig["workspaces"][number]["status"] =>
  value === "paused" ? "paused" : "active";

const asAgentProvider = (
  value: unknown
): DashboardConfig["workspaces"][number]["channelDetails"][number]["agentProvider"] =>
  normalizeAgentProviderId(value);

function createDefaultAgentsConfig(): DashboardConfig["agents"] {
  return Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => [
      provider,
      providerSupportsModelSelection(provider)
        ? { enabled: true, models: [] }
        : { enabled: true },
    ])
  ) as unknown as DashboardConfig["agents"];
}

function sanitizeAgents(input: unknown): DashboardConfig["agents"] {
  const agentsRecord = input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};

  return Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => {
      const providerRecord = agentsRecord[provider] && typeof agentsRecord[provider] === "object"
        ? (agentsRecord[provider] as Record<string, unknown>)
        : {};

      if (providerSupportsModelSelection(provider)) {
        return [
          provider,
          {
            enabled: providerRecord.enabled !== false,
            models: Array.from(new Set(asStringArray(providerRecord.models).filter(Boolean))),
          },
        ] as const;
      }

      return [
        provider,
        {
          enabled: providerRecord.enabled !== false,
        },
      ] as const;
    })
  ) as unknown as DashboardConfig["agents"];
}

const sanitizeChannelDetail = (
  channel: unknown
): DashboardConfig["workspaces"][number]["channelDetails"][number] | null => {
  if (!channel || typeof channel !== "object") return null;
  const detail = channel as Record<string, unknown>;
  const computerUse = detail.computerUse && typeof detail.computerUse === "object"
    ? detail.computerUse as Record<string, unknown>
    : {};
  return {
    id: asString(detail.id),
    name: asString(detail.name),
    agentProvider: asAgentProvider(detail.agentProvider),
    model: asString(detail.model),
    workingDirectory: asString(detail.workingDirectory),
    baseBranch: asBaseBranch(detail.baseBranch),
    channelSystemMessage: asString(detail.channelSystemMessage),
    computerUse: {
      browser: computerUse.browser === "interact" ? "interact" : computerUse.browser === "observe" ? "observe" : "off",
      desktop: computerUse.desktop === "control" ? "control" : computerUse.desktop === "observe" ? "observe" : "off",
      browserProfile: asString(computerUse.browserProfile),
      allowedOrigins: Array.isArray(computerUse.allowedOrigins)
        ? asStringArray(computerUse.allowedOrigins)
        : ["http://localhost:*", "http://127.0.0.1:*"],
      allowedApps: asStringArray(computerUse.allowedApps),
      approvalPolicy: computerUse.approvalPolicy === "always"
        ? "always"
        : computerUse.approvalPolicy === "never"
          ? "never"
          : "consequential",
    },
  };
};

const sanitizeWorkspace = (
  workspaceInput: unknown,
  fallbackId: string,
  fallbackName: string
): DashboardConfig["workspaces"][number] => {
  if (!workspaceInput || typeof workspaceInput !== "object") {
    return {
      ...structuredClone(defaultWorkspace),
      id: fallbackId,
      name: fallbackName,
    };
  }

  const workspace = workspaceInput as Record<string, unknown>;
  const channelDetails = Array.isArray(workspace.channelDetails)
    ? (workspace.channelDetails
        .map((channel) => sanitizeChannelDetail(channel))
        .filter(Boolean) as DashboardConfig["workspaces"][number]["channelDetails"])
    : [];
  const slackAppToken = asString(workspace.slackAppToken, "");
  const slackBotToken = asString(workspace.slackBotToken, "");
  const discordBotToken = asString(workspace.discordBotToken, "");
  const larkAppKey = asString(workspace.larkAppKey, "") || asString(workspace.larkAppId, "");
  const larkAppSecret = asString(workspace.larkAppSecret, "");
  const type = workspace.type === "discord" ? "discord" : workspace.type === "lark" ? "lark" : "slack";

  return {
    id: asString(workspace.id) || fallbackId,
    type,
    name: asString(workspace.name) || fallbackName,
    domain: asString(workspace.domain),
    status: asStatus(workspace.status),
    channels: asNumber(workspace.channels),
    members: asNumber(workspace.members),
    lastSync: asString(workspace.lastSync),
    slackAppToken: slackAppToken || undefined,
    slackBotToken: slackBotToken || undefined,
    discordBotToken: discordBotToken || undefined,
    larkAppKey: larkAppKey || undefined,
    larkAppId: larkAppKey || undefined,
    larkAppSecret: larkAppSecret || undefined,
    channelDetails,
  };
};

const sanitizeWorkspaces = (workspaces: unknown): DashboardConfig["workspaces"] => {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return [];
  }

  return workspaces.map((workspace, index) =>
    sanitizeWorkspace(workspace, `workspace-${index + 1}`, `Workspace ${index + 1}`)
  );
};

export const sanitizeDashboardConfig = (config: unknown): DashboardConfig => {
  if (!config || typeof config !== "object") {
    return cloneDefaultDashboardConfig();
  }

  const record = config as Record<string, unknown>;
  const user = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : {};

  const workspaces = sanitizeWorkspaces(record.workspaces);
  const computerGateway = record.computerGateway && typeof record.computerGateway === "object"
    ? record.computerGateway as Record<string, unknown>
    : {};

  return {
    completeOnboarding: record.completeOnboarding === true,
    user: {
      name: asString(user.name),
      email: asString(user.email),
      initials: asString(user.initials, "") || undefined,
      avatar: asString(user.avatar, "") || undefined,
      gitStrategy: asGitStrategy(user.gitStrategy),
      defaultStatusMessageFormat: asFrequency(user.defaultStatusMessageFormat),
      statusMessageFrequencyMs: asStatusMessageFrequencyMs(user.statusMessageFrequencyMs),
    },
    updates: {
      autoUpgrade: record.updates && typeof record.updates === "object"
        ? (record.updates as Record<string, unknown>).autoUpgrade !== false
        : true,
    },
    computerGateway: {
      enabled: computerGateway.enabled === true,
      browserDriver: "agent-browser",
      desktopDriver: "ode",
      browserExecutable: asString(computerGateway.browserExecutable, "agent-browser") || "agent-browser",
      desktopExecutable: computerGateway.desktopExecutable === "peekaboo"
        ? "ode"
        : asString(computerGateway.desktopExecutable, "ode") || "ode",
      browserHeaded: computerGateway.browserHeaded === true,
      commandTimeoutMs: asNumber(computerGateway.commandTimeoutMs, 30_000),
      approvalTimeoutMs: asNumber(computerGateway.approvalTimeoutMs, 10 * 60_000),
    },
    agents: sanitizeAgents(record.agents),
    workspaces,
  };
};
