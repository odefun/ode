import {
  sanitizeDashboardConfig,
  type DashboardConfig,
} from "../dashboard-config";
import {
  DEFAULT_STATUS_MESSAGE_FREQUENCY_MS,
  parseStatusMessageFrequencyMs,
  type StatusMessageFrequencyMs,
} from "../status-message-frequency";
import {
  normalizeGitStrategy,
  normalizeStatusMessageFormat,
  type GitStrategy,
  type StatusMessageFormat,
} from "../baseConfig";
import {
  type WorkspaceConfig,
  type AgentProvider,
  type AgentsConfig,
  type UpdateConfig,
  type OdeConfig,
} from "./ode-schema";
import {
  loadOdeConfig,
  updateOdeConfig,
} from "./ode-store";
import { AGENT_PROVIDERS } from "@/shared/agent-provider";

export type {
  ChannelDetail,
  WorkspaceConfig,
  AgentProvider,
  AgentsConfig,
  UpdateConfig,
  OdeConfig,
  UserConfig,
} from "./ode-schema";
export { ODE_CONFIG_FILE } from "./ode-store";
export { invalidateOdeConfigCache, loadOdeConfig, saveOdeConfig, updateOdeConfig } from "./ode-store";
export {
  getDefaultCwd,
  getChannelDetails,
  resolveChannelCwd,
  setChannelCwd,
  setChannelWorkingDirectory,
  getChannelBaseBranch,
  setChannelBaseBranch,
  getChannelSystemMessage,
  setChannelSystemMessage,
  getChannelModel,
  getChannelAgentProvider,
  setChannelModel,
  setChannelAgentProvider,
  type ChannelCwdInfo,
} from "./ode-channel";

const MIN_MESSAGE_UPDATE_INTERVAL_MS = 250;
export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";

function toDashboardConfig(config: OdeConfig): DashboardConfig {
  const defaultStatusMessageFormat = normalizeStatusMessageFormat(config.user.defaultStatusMessageFormat);

  return {
    completeOnboarding: config.completeOnboarding,
    user: {
      name: config.user.name,
      email: config.user.email,
      initials: config.user.initials,
      avatar: config.user.avatar,
      gitStrategy: config.user.gitStrategy,
      defaultStatusMessageFormat,
      statusMessageFrequencyMs: parseStatusMessageFrequencyMs(config.user.IM_MESSAGE_UPDATE_INTERVAL_MS),
    },
    updates: {
      autoUpgrade: config.updates.autoUpgrade,
    },
    agents: structuredClone(config.agents),
    workspaces: structuredClone(config.workspaces),
  };
}

function mergeDashboardConfig(config: OdeConfig, dashboardConfig: DashboardConfig): OdeConfig {
  const {
    statusMessageFrequencyMs,
    ...dashboardUser
  } = dashboardConfig.user;
  const workspaces: WorkspaceConfig[] = dashboardConfig.workspaces.map((workspace) => ({
    ...workspace,
    slackStatusMode: workspace.slackStatusMode === "legacy" ? "legacy" : "ai_card",
    slackAppToken: workspace.slackAppToken ?? "",
    slackBotToken: workspace.slackBotToken ?? "",
    discordBotToken: workspace.discordBotToken ?? "",
    larkAppKey: workspace.larkAppKey ?? workspace.larkAppId ?? "",
    larkAppId: workspace.larkAppId ?? workspace.larkAppKey ?? "",
    larkAppSecret: workspace.larkAppSecret ?? "",
    channelDetails: workspace.channelDetails.map((channel) => ({
      ...channel,
      agentProvider: channel.agentProvider ?? "opencode",
      channelSystemMessage: channel.channelSystemMessage ?? "",
      ambientMode: false,
    })),
  }));

  return {
    ...config,
    completeOnboarding: dashboardConfig.completeOnboarding,
    user: {
      ...config.user,
      ...dashboardUser,
      IM_MESSAGE_UPDATE_INTERVAL_MS: parseStatusMessageFrequencyMs(statusMessageFrequencyMs),
    },
    updates: {
      ...config.updates,
      autoUpgrade: dashboardConfig.updates.autoUpgrade !== false,
    },
    agents: structuredClone(dashboardConfig.agents),
    workspaces,
  };
}

export function readDashboardConfig(): DashboardConfig {
  return sanitizeDashboardConfig(toDashboardConfig(loadOdeConfig()));
}

export function writeDashboardConfig(config: DashboardConfig): DashboardConfig {
  const sanitized = sanitizeDashboardConfig(config);
  updateOdeConfig((current) => mergeDashboardConfig(current, sanitized));
  return readDashboardConfig();
}

export function updateDashboardConfig(
  updater: (config: DashboardConfig) => DashboardConfig
): DashboardConfig {
  const next = updater(readDashboardConfig());
  return writeDashboardConfig(next);
}

export function getWorkspaces(): WorkspaceConfig[] {
  return loadOdeConfig().workspaces;
}

export function getAgentsConfig(): AgentsConfig {
  return loadOdeConfig().agents;
}

export function getEnabledAgentProviders(): AgentProvider[] {
  const agents = getAgentsConfig();
  const enabled = AGENT_PROVIDERS.filter((provider) => agents[provider].enabled);
  return enabled.length > 0 ? enabled : ["opencode"];
}

export function isAgentEnabled(agentProvider: AgentProvider): boolean {
  return getAgentsConfig()[agentProvider].enabled;
}

export function getOpenCodeModels(): string[] {
  return getAgentsConfig().opencode.models;
}

export function setOpenCodeModels(models: string[]): void {
  updateOdeConfig((config) => ({
    ...config,
    agents: {
      ...config.agents,
      opencode: {
        ...config.agents.opencode,
        models,
      },
    },
  }));
}

export function getCodexModels(): string[] {
  return getAgentsConfig().codex.models;
}

export function setCodexModels(models: string[]): void {
  updateOdeConfig((config) => ({
    ...config,
    agents: {
      ...config.agents,
      codex: {
        ...config.agents.codex,
        models,
      },
    },
  }));
}

export function getKiloModels(): string[] {
  return getAgentsConfig().kilo.models ?? [];
}

export function getPiModels(): string[] {
  return getAgentsConfig().pi.models ?? [];
}

export function getOpenHandsModels(): string[] {
  return getAgentsConfig().openhands.models ?? [];
}

export function getCodeBuddyModels(): string[] {
  return getAgentsConfig().codebuddy.models ?? [];
}

export function getCrushModels(): string[] {
  return getAgentsConfig().crush.models ?? [];
}

export function setKiloModels(models: string[]): void {
  updateOdeConfig((config) => ({
    ...config,
    agents: {
      ...config.agents,
      kilo: {
        ...config.agents.kilo,
        models,
      },
    },
  }));
}

export function getUpdateConfig(): UpdateConfig {
  return loadOdeConfig().updates;
}

export function getSlackAppTokens(): Array<{ token: string; workspaceId: string; workspaceName?: string }> {
  const active = getWorkspaces().filter((workspace) => workspace.type === "slack" && workspace.status === "active");
  const candidates = active.length > 0 ? active : getWorkspaces().filter((workspace) => workspace.type === "slack");
  return candidates
    .map((workspace) => ({
      token: workspace.slackAppToken,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }))
    .filter((entry) => entry.token && entry.token.trim().length > 0);
}

export function getSlackBotTokens(): Array<{
  token: string;
  appToken: string;
  workspaceId: string;
  workspaceName?: string;
}> {
  const active = getWorkspaces().filter((workspace) => workspace.type === "slack" && workspace.status === "active");
  const candidates = active.length > 0 ? active : getWorkspaces().filter((workspace) => workspace.type === "slack");
  return candidates.map((workspace) => ({
    token: workspace.slackBotToken,
    appToken: workspace.slackAppToken,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
  }));
}

export function getSlackTargetChannels(): string[] | null {
  const channels = getWorkspaces()
    .filter((workspace) => workspace.type === "slack")
    .flatMap((workspace) => workspace.channelDetails);
  const ids = channels.map((channel) => channel.id).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export function getSlackStatusModeForChannel(channelId: string): WorkspaceConfig["slackStatusMode"] {
  const workspace = getWorkspaces()
    .filter((item) => item.type === "slack")
    .find((item) => item.channelDetails.some((channel) => channel.id === channelId));
  return workspace?.slackStatusMode === "legacy" ? "legacy" : "ai_card";
}

export function getDiscordBotTokens(): Array<{ token: string; workspaceId: string; workspaceName?: string }> {
  const active = getWorkspaces().filter((workspace) => workspace.type === "discord" && workspace.status === "active");
  const candidates = active.length > 0 ? active : getWorkspaces().filter((workspace) => workspace.type === "discord");
  return candidates
    .map((workspace) => ({
      token: workspace.discordBotToken,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }))
    .filter((entry) => entry.token && entry.token.trim().length > 0);
}

export function getDiscordTargetChannels(): string[] | null {
  const channels = getWorkspaces()
    .filter((workspace) => workspace.type === "discord")
    .flatMap((workspace) => workspace.channelDetails);
  const ids = channels.map((channel) => channel.id).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export function getLarkAppCredentials(): Array<{
  appId: string;
  appSecret: string;
  workspaceId: string;
  workspaceName?: string;
}> {
  const active = getWorkspaces().filter((workspace) => workspace.type === "lark" && workspace.status === "active");
  const candidates = active.length > 0 ? active : getWorkspaces().filter((workspace) => workspace.type === "lark");
  return candidates
    .map((workspace) => ({
      appId: workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "",
      appSecret: workspace.larkAppSecret?.trim() ?? "",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }))
    .filter((entry) => entry.appId.length > 0 && entry.appSecret.length > 0);
}

export function getLarkTargetChannels(): string[] | null {
  const channels = getWorkspaces()
    .filter((workspace) => workspace.type === "lark")
    .flatMap((workspace) => workspace.channelDetails);
  const ids = channels.map((channel) => channel.id).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

export type GitHubInfo = {
  token?: string;
  gitName?: string;
  gitEmail?: string;
};

export type UserGeneralSettings = {
  defaultStatusMessageFormat: StatusMessageFormat;
  gitStrategy: GitStrategy;
  statusMessageFrequencyMs: StatusMessageFrequencyMs;
  autoUpdate: boolean;
};

export function getMessageUpdateIntervalMs(): number {
  const user = loadOdeConfig().user;
  const value = user.IM_MESSAGE_UPDATE_INTERVAL_MS;
  if (Number.isFinite(value) && value > 0) {
    return Math.max(value, MIN_MESSAGE_UPDATE_INTERVAL_MS);
  }
  return DEFAULT_STATUS_MESSAGE_FREQUENCY_MS;
}

export function getGitHubInfoForUser(userId: string): GitHubInfo | null {
  const info = loadOdeConfig().githubInfos?.[userId];
  if (!info) return null;
  const token = info.token?.trim() || "";
  const gitName = info.gitName?.trim() || "";
  const gitEmail = info.gitEmail?.trim() || "";
  if (!token && !gitName && !gitEmail) return null;
  return {
    token: token || undefined,
    gitName: gitName || undefined,
    gitEmail: gitEmail || undefined,
  };
}

export function getUserGeneralSettings(): UserGeneralSettings {
  const odeConfig = loadOdeConfig();
  const user = odeConfig.user;
  const updates = odeConfig.updates;
  return {
    defaultStatusMessageFormat: normalizeStatusMessageFormat(user.defaultStatusMessageFormat),
    gitStrategy: normalizeGitStrategy(user.gitStrategy),
    statusMessageFrequencyMs: parseStatusMessageFrequencyMs(user.IM_MESSAGE_UPDATE_INTERVAL_MS),
    autoUpdate: updates.autoUpgrade !== false,
  };
}

export function setUserGeneralSettings(settings: UserGeneralSettings): void {
  updateOdeConfig((config) => ({
    ...config,
    user: {
      ...config.user,
      defaultStatusMessageFormat: settings.defaultStatusMessageFormat,
      gitStrategy: settings.gitStrategy,
      IM_MESSAGE_UPDATE_INTERVAL_MS: parseStatusMessageFrequencyMs(settings.statusMessageFrequencyMs),
    },
    updates: {
      ...config.updates,
      autoUpgrade: settings.autoUpdate !== false,
    },
  }));
}

export function setGitHubInfoForUser(userId: string, info: GitHubInfo): void {
  updateOdeConfig((config) => {
    const githubInfos = { ...(config.githubInfos ?? {}) };
    const token = info.token?.trim() || "";
    const gitName = info.gitName?.trim() || "";
    const gitEmail = info.gitEmail?.trim() || "";
    if (!token && !gitName && !gitEmail) {
      delete githubInfos[userId];
    } else {
      githubInfos[userId] = {
        token,
        gitName,
        gitEmail,
      };
    }
    return { ...config, githubInfos };
  });
}

export function clearGitHubInfoForUser(userId: string): void {
  updateOdeConfig((config) => {
    const githubInfos = { ...(config.githubInfos ?? {}) };
    delete githubInfos[userId];
    return { ...config, githubInfos };
  });
}
