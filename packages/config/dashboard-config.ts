export type DashboardConfig = {
  user: {
    name: string;
    email: string;
    initials?: string;
    avatar?: string;
    gitStrategy: "default" | "worktree";
    defaultMessageFrequency: "aggressive" | "medium" | "minimum";
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
    };
  };
  workspaces: {
    id: string;
    name: string;
    domain: string;
    status: "active" | "paused";
    channels: number;
    members: number;
    lastSync: string;
    slackAppToken?: string;
    slackBotToken?: string;
    channelDetails: {
      id: string;
      name: string;
      agentProvider?: "opencode" | "claudecode" | "codex";
      model: string;
      workingDirectory: string;
    }[];
  }[];
};

const defaultWorkspace: DashboardConfig["workspaces"][number] = {
  id: "workspace-1",
  name: "Workspace 1",
  domain: "",
  status: "active",
  channels: 0,
  members: 0,
  lastSync: "",
  channelDetails: [],
};

export const defaultDashboardConfig: DashboardConfig = {
  user: {
    name: "",
    email: "",
    gitStrategy: "worktree",
    defaultMessageFrequency: "medium",
  },
  agents: {
    opencode: { enabled: true, models: [] },
    claudecode: { enabled: true },
    codex: { enabled: true },
  },
  workspaces: [defaultWorkspace],
};

const cloneDefaultDashboardConfig = (): DashboardConfig => structuredClone(defaultDashboardConfig);

const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

const asNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const asFrequency = (
  value: unknown
): DashboardConfig["user"]["defaultMessageFrequency"] => {
  if (value === "aggressive" || value === "minimum") return value;
  return "medium";
};

const asGitStrategy = (
  value: unknown
): DashboardConfig["user"]["gitStrategy"] =>
  value === "default" ? "default" : "worktree";

const asStatus = (value: unknown): DashboardConfig["workspaces"][number]["status"] =>
  value === "paused" ? "paused" : "active";

const asAgentProvider = (
  value: unknown
): DashboardConfig["workspaces"][number]["channelDetails"][number]["agentProvider"] =>
  value === "claudecode" ? "claudecode" : value === "codex" ? "codex" : "opencode";

const sanitizeChannelDetail = (
  channel: unknown
): DashboardConfig["workspaces"][number]["channelDetails"][number] | null => {
  if (!channel || typeof channel !== "object") return null;
  const detail = channel as Record<string, unknown>;
  return {
    id: asString(detail.id),
    name: asString(detail.name),
    agentProvider: asAgentProvider(detail.agentProvider),
    model: asString(detail.model),
    workingDirectory: asString(detail.workingDirectory),
  };
};

const sanitizePrimaryWorkspace = (workspaces: unknown): DashboardConfig["workspaces"][number] => {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return structuredClone(defaultWorkspace);
  }
  const first = workspaces[0];
  if (!first || typeof first !== "object") {
    return structuredClone(defaultWorkspace);
  }

  const workspace = first as Record<string, unknown>;
  const channelDetails = Array.isArray(workspace.channelDetails)
    ? (workspace.channelDetails
        .map((channel) => sanitizeChannelDetail(channel))
        .filter(Boolean) as DashboardConfig["workspaces"][number]["channelDetails"])
    : [];
  const slackAppToken = asString(workspace.slackAppToken, "");
  const slackBotToken = asString(workspace.slackBotToken, "");

  return {
    id: asString(workspace.id) || defaultWorkspace.id,
    name: asString(workspace.name) || defaultWorkspace.name,
    domain: asString(workspace.domain),
    status: asStatus(workspace.status),
    channels: asNumber(workspace.channels),
    members: asNumber(workspace.members),
    lastSync: asString(workspace.lastSync),
    slackAppToken: slackAppToken || undefined,
    slackBotToken: slackBotToken || undefined,
    channelDetails,
  };
};

export const sanitizeDashboardConfig = (config: unknown): DashboardConfig => {
  if (!config || typeof config !== "object") {
    return cloneDefaultDashboardConfig();
  }

  const record = config as Record<string, unknown>;
  const user = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : {};

  const agentsRecord = record.agents && typeof record.agents === "object"
    ? (record.agents as Record<string, unknown>)
    : {};
  const opencodeRecord = agentsRecord.opencode && typeof agentsRecord.opencode === "object"
    ? (agentsRecord.opencode as Record<string, unknown>)
    : {};
  const claudecodeRecord = agentsRecord.claudecode && typeof agentsRecord.claudecode === "object"
    ? (agentsRecord.claudecode as Record<string, unknown>)
    : {};
  const codexRecord = agentsRecord.codex && typeof agentsRecord.codex === "object"
    ? (agentsRecord.codex as Record<string, unknown>)
    : {};

  const opencodeModels = asStringArray(opencodeRecord.models);

  const primaryWorkspace = sanitizePrimaryWorkspace(record.workspaces);

  return {
    user: {
      name: asString(user.name),
      email: asString(user.email),
      initials: asString(user.initials, "") || undefined,
      avatar: asString(user.avatar, "") || undefined,
      gitStrategy: asGitStrategy(user.gitStrategy),
      defaultMessageFrequency: asFrequency(user.defaultMessageFrequency),
    },
    agents: {
      opencode: {
        enabled: opencodeRecord.enabled !== false,
        models: Array.from(new Set(opencodeModels.filter(Boolean))),
      },
      claudecode: {
        enabled: claudecodeRecord.enabled !== false,
      },
      codex: {
        enabled: codexRecord.enabled !== false,
      },
    },
    workspaces: [primaryWorkspace],
  };
};
