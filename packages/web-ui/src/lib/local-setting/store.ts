import { get, writable } from "svelte/store";
import {
  defaultDashboardConfig,
  parseStatusMessageFrequencyMs,
  type DashboardConfig,
} from "../localConfig";
import { AGENT_PROVIDERS, type AgentProviderId } from "@/shared/agent-provider";

export type CliCheckResult = Partial<Record<AgentProviderId, boolean>> & {
  claude?: boolean;
  opencodeModels?: string[];
  opencodeModelError?: string;
  kiloModels?: string[];
  kiloModelError?: string;
  piModels?: string[];
  piModelError?: string;
  openhandsModels?: string[];
  openhandsModelError?: string;
  codebuddyModels?: string[];
  codebuddyModelError?: string;
  crushModels?: string[];
  crushModelError?: string;
};

type LocalSettingState = {
  config: DashboardConfig;
  appVersion: string;
  devEnabled: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isSyncingSlack: boolean;
  isAddingWorkspace: boolean;
  isCheckingCli: boolean;
  loaded: boolean;
  message: string;
  agentMessage: string;
  cliCheckResult: CliCheckResult | null;
  checkingAgents: Partial<Record<AgentProviderId, boolean>>;
};

const initialState: LocalSettingState = {
  config: defaultDashboardConfig,
  appVersion: "",
  devEnabled: false,
  isLoading: false,
  isSaving: false,
  isSyncingSlack: false,
  isAddingWorkspace: false,
  isCheckingCli: false,
  loaded: false,
  message: "",
  agentMessage: "",
  cliCheckResult: null,
  checkingAgents: {},
};

const store = writable<LocalSettingState>(initialState);

function validateWorkspaceConfig(config: DashboardConfig): string | null {
  const idCounts = new Map<string, number>();
  const slackBotTokenCounts = new Map<string, number>();
  const discordBotTokenCounts = new Map<string, number>();
  const larkAppKeyCounts = new Map<string, number>();
  for (const workspace of config.workspaces) {
    const workspaceId = workspace.id.trim();
    if (!workspaceId) {
      return "Workspace id is required for every workspace.";
    }
    idCounts.set(workspaceId, (idCounts.get(workspaceId) ?? 0) + 1);

    if (workspace.type === "discord") {
      const botToken = workspace.discordBotToken?.trim() ?? "";
      if (botToken) {
        discordBotTokenCounts.set(botToken, (discordBotTokenCounts.get(botToken) ?? 0) + 1);
      }
    } else if (workspace.type === "lark") {
      const appKey = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      if (appKey) {
        larkAppKeyCounts.set(appKey, (larkAppKeyCounts.get(appKey) ?? 0) + 1);
      }
    } else {
      const botToken = workspace.slackBotToken?.trim() ?? "";
      if (botToken) {
        slackBotTokenCounts.set(botToken, (slackBotTokenCounts.get(botToken) ?? 0) + 1);
      }
    }
  }

  const duplicateIds = Array.from(idCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length > 0) {
    return `Duplicate workspace ids: ${duplicateIds.join(", ")}`;
  }

  const duplicatedBotTokens = Array.from(slackBotTokenCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([token]) => token);
  if (duplicatedBotTokens.length > 0) {
    return `Duplicate Slack bot tokens found across workspaces.`;
  }

  const duplicatedDiscordBotTokens = Array.from(discordBotTokenCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([token]) => token);
  if (duplicatedDiscordBotTokens.length > 0) {
    return `Duplicate Discord bot tokens found across workspaces.`;
  }

  const duplicatedLarkAppKeys = Array.from(larkAppKeyCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([appKey]) => appKey);
  if (duplicatedLarkAppKeys.length > 0) {
    return `Duplicate Lark app keys found across workspaces.`;
  }

  const missingTokenWorkspaces = config.workspaces.filter((workspace: DashboardConfig["workspaces"][number]) => {
    if (workspace.type === "discord") {
      return !(workspace.discordBotToken?.trim() ?? "");
    }
    if (workspace.type === "lark") {
      const appId = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      const appSecret = workspace.larkAppSecret?.trim() ?? "";
      return !appId || !appSecret;
    }
    const appToken = workspace.slackAppToken?.trim() ?? "";
    const botToken = workspace.slackBotToken?.trim() ?? "";
    return !appToken || !botToken;
  });
  if (missingTokenWorkspaces.length > 0) {
    const labels = missingTokenWorkspaces
      .map((workspace: DashboardConfig["workspaces"][number]) => workspace.name.trim() || workspace.id)
      .join(", ");
    return `Missing workspace token(s) for: ${labels}`;
  }

  return null;
}

function normalizeConfig(input: DashboardConfig): DashboardConfig {
  return {
    ...input,
    user: {
      ...input.user,
      gitStrategy: input.user.gitStrategy ?? "worktree",
      defaultStatusMessageFormat: input.user.defaultStatusMessageFormat ?? "medium",
      statusMessageFrequencyMs: parseStatusMessageFrequencyMs(input.user.statusMessageFrequencyMs),
    },
    updates: {
      autoUpgrade: input.updates?.autoUpgrade !== false,
    },
    workspaces: input.workspaces ?? [],
    agents: {
      opencode: {
        enabled: input.agents?.opencode?.enabled ?? true,
        models: input.agents?.opencode?.models ?? [],
      },
      claudecode: {
        enabled: input.agents?.claudecode?.enabled ?? true,
      },
      codex: {
        enabled: input.agents?.codex?.enabled ?? true,
        models: input.agents?.codex?.models ?? [],
      },
      kimi: {
        enabled: input.agents?.kimi?.enabled ?? true,
      },
      kilo: {
        enabled: input.agents?.kilo?.enabled ?? true,
        models: input.agents?.kilo?.models ?? [],
      },
      qwen: {
        enabled: input.agents?.qwen?.enabled ?? true,
      },
      goose: {
        enabled: input.agents?.goose?.enabled ?? true,
      },
      pi: {
        enabled: input.agents?.pi?.enabled ?? true,
        models: input.agents?.pi?.models ?? [],
      },
      openhands: {
        enabled: input.agents?.openhands?.enabled ?? true,
        models: input.agents?.openhands?.models ?? [],
      },
      codebuddy: {
        enabled: input.agents?.codebuddy?.enabled ?? true,
        models: input.agents?.codebuddy?.models ?? [],
      },
      crush: {
        enabled: input.agents?.crush?.enabled ?? true,
        models: input.agents?.crush?.models ?? [],
      },
    },
  };
}

function updateConfig(updater: (config: DashboardConfig) => DashboardConfig): void {
  store.update((state) => ({
    ...state,
    config: updater(state.config),
  }));
}

function updateWorkspace(
  workspaceId: string,
  updater: (workspace: DashboardConfig["workspaces"][number]) => DashboardConfig["workspaces"][number]
): void {
  updateConfig((config) => ({
    ...config,
    workspaces: config.workspaces.map((workspace: DashboardConfig["workspaces"][number]) =>
      workspace.id === workspaceId ? updater(workspace) : workspace
    ),
  }));
}

async function removeWorkspace(workspaceId: string): Promise<void> {
  updateConfig((config) => ({
    ...config,
    workspaces: config.workspaces.filter((workspace: DashboardConfig["workspaces"][number]) => workspace.id !== workspaceId),
  }));
  await saveConfig();
}

async function loadConfig(): Promise<void> {
  const current = get(store);
  if (current.isLoading) return;

  store.update((state) => ({ ...state, isLoading: true, message: "" }));
  try {
    const response = await fetch("/api/config");
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      version?: string;
      dev?: { enabled?: boolean };
      config?: DashboardConfig;
    };
    if (!response.ok || !payload.ok || !payload.config) {
      throw new Error(payload.error || "Failed to load config");
    }
    store.update((state) => ({
      ...state,
      config: normalizeConfig(payload.config as DashboardConfig),
      appVersion: typeof payload.version === "string" ? payload.version : state.appVersion,
      devEnabled: payload.dev?.enabled === true,
      loaded: true,
      isLoading: false,
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      loaded: true,
      isLoading: false,
      message: `Load failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function saveConfig(): Promise<void> {
  const payload = get(store).config;
  const validationError = validateWorkspaceConfig(payload);
  if (validationError) {
    store.update((state) => ({
      ...state,
      message: `Validation failed: ${validationError}`,
    }));
    return;
  }

  store.update((state) => ({ ...state, isSaving: true, message: "" }));
  try {
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      version?: string;
      dev?: { enabled?: boolean };
      config?: DashboardConfig;
    };
    if (!response.ok || !result.ok || !result.config) {
      throw new Error(result.error || "Failed to save config");
    }
    store.update((state) => ({
      ...state,
      config: normalizeConfig(result.config as DashboardConfig),
      appVersion: typeof result.version === "string" ? result.version : state.appVersion,
      devEnabled: result.dev?.enabled === true,
      isSaving: false,
      message: "Saved.",
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      isSaving: false,
      message: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function checkAgents(): Promise<void> {
  const checkingAgents = Object.fromEntries(AGENT_PROVIDERS.map((provider) => [provider, true])) as Record<AgentProviderId, boolean>;
  store.update((state) => ({
    ...state,
    isCheckingCli: true,
    checkingAgents,
    agentMessage: "Checking local agent CLIs...",
  }));

  const checkProvider = async (provider: AgentProviderId): Promise<void> => {
    try {
      const response = await fetch(`/api/agent-check/${provider}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: CliCheckResult;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `Failed to check ${provider}`);
      }
      const result = payload.result;
      store.update((state) => {
        const nextCheckingAgents = { ...state.checkingAgents, [provider]: false };
        return {
          ...state,
          cliCheckResult: {
            ...(state.cliCheckResult ?? {}),
            ...result,
          },
          checkingAgents: nextCheckingAgents,
          isCheckingCli: Object.values(nextCheckingAgents).some(Boolean),
          config: updateConfigWithAgentCheckResult(state.config, result),
          agentMessage: buildIncrementalAgentMessage(provider, result),
        };
      });
    } catch (error) {
      store.update((state) => {
        const nextCheckingAgents = { ...state.checkingAgents, [provider]: false };
        return {
          ...state,
          checkingAgents: nextCheckingAgents,
          isCheckingCli: Object.values(nextCheckingAgents).some(Boolean),
          agentMessage: `Check failed for ${provider}: ${error instanceof Error ? error.message : String(error)}`,
        };
      });
    }
  };

  try {
    await Promise.allSettled(AGENT_PROVIDERS.map((provider) => checkProvider(provider)));
    store.update((state) => ({
      ...state,
      isCheckingCli: false,
      checkingAgents: {},
      agentMessage: "Checked local agent CLIs.",
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      isCheckingCli: false,
      checkingAgents: {},
      agentMessage: `Check failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

function buildIncrementalAgentMessage(provider: AgentProviderId, result: CliCheckResult): string {
  const modelError = getModelErrorFromResult(provider, result);
  if (modelError) return `Checked ${provider}. Model fetch failed: ${modelError}`;
  const modelCount = getModelCountFromResult(provider, result);
  if (modelCount !== null) return `Checked ${provider}. Synced ${modelCount} models.`;
  return `Checked ${provider}.`;
}

function getModelErrorFromResult(provider: AgentProviderId, result: CliCheckResult): string | undefined {
  if (provider === "opencode") return result.opencodeModelError;
  if (provider === "kilo") return result.kiloModelError;
  if (provider === "pi") return result.piModelError;
  if (provider === "openhands") return result.openhandsModelError;
  if (provider === "codebuddy") return result.codebuddyModelError;
  if (provider === "crush") return result.crushModelError;
  return undefined;
}

function getModelCountFromResult(provider: AgentProviderId, result: CliCheckResult): number | null {
  if (provider === "opencode" && Array.isArray(result.opencodeModels)) return result.opencodeModels.length;
  if (provider === "kilo" && Array.isArray(result.kiloModels)) return result.kiloModels.length;
  if (provider === "pi" && Array.isArray(result.piModels)) return result.piModels.length;
  if (provider === "openhands" && Array.isArray(result.openhandsModels)) return result.openhandsModels.length;
  if (provider === "codebuddy" && Array.isArray(result.codebuddyModels)) return result.codebuddyModels.length;
  if (provider === "crush" && Array.isArray(result.crushModels)) return result.crushModels.length;
  return null;
}

function updateConfigWithAgentCheckResult(config: DashboardConfig, result: CliCheckResult): DashboardConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      opencode: {
        ...config.agents.opencode,
        enabled: result.opencode ?? config.agents.opencode.enabled,
        models: Array.isArray(result.opencodeModels) ? result.opencodeModels : config.agents.opencode.models,
      },
      claudecode: {
        ...config.agents.claudecode,
        enabled: result.claudecode ?? result.claude ?? config.agents.claudecode.enabled,
      },
      codex: {
        ...config.agents.codex,
        enabled: result.codex ?? config.agents.codex.enabled,
      },
      kimi: {
        ...config.agents.kimi,
        enabled: result.kimi ?? config.agents.kimi.enabled,
      },
      kilo: {
        ...config.agents.kilo,
        enabled: result.kilo ?? config.agents.kilo.enabled,
        models: Array.isArray(result.kiloModels) ? result.kiloModels : config.agents.kilo.models,
      },
      qwen: {
        ...config.agents.qwen,
        enabled: result.qwen ?? config.agents.qwen.enabled,
      },
      goose: {
        ...config.agents.goose,
        enabled: result.goose ?? config.agents.goose.enabled,
      },
      pi: {
        ...config.agents.pi,
        enabled: result.pi ?? config.agents.pi.enabled,
        models: Array.isArray(result.piModels) ? result.piModels : config.agents.pi.models,
      },
      openhands: {
        ...config.agents.openhands,
        enabled: result.openhands ?? config.agents.openhands.enabled,
        models: Array.isArray(result.openhandsModels) ? result.openhandsModels : config.agents.openhands.models,
      },
      codebuddy: {
        ...config.agents.codebuddy,
        enabled: result.codebuddy ?? config.agents.codebuddy.enabled,
        models: Array.isArray(result.codebuddyModels) ? result.codebuddyModels : config.agents.codebuddy.models,
      },
      crush: {
        ...config.agents.crush,
        enabled: result.crush ?? config.agents.crush.enabled,
        models: Array.isArray(result.crushModels) ? result.crushModels : config.agents.crush.models,
      },
    },
  };
}

async function syncSlackWorkspace(workspaceId: string): Promise<void> {
  store.update((state) => ({ ...state, isSyncingSlack: true, message: "" }));
  try {
    const response = await fetch("/api/slack-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Slack sync failed");
    }
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      config: {
        ...state.config,
        workspaces: state.config.workspaces.map((workspace: DashboardConfig["workspaces"][number]) =>
          workspace.id === payload.workspace!.id ? payload.workspace! : workspace
        ),
      },
      message: "Slack workspace synced.",
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      message: `Slack sync failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function syncDiscordWorkspace(workspaceId: string): Promise<void> {
  store.update((state) => ({ ...state, isSyncingSlack: true, message: "" }));
  try {
    const response = await fetch("/api/discord-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Discord sync failed");
    }
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      config: {
        ...state.config,
        workspaces: state.config.workspaces.map((workspace: DashboardConfig["workspaces"][number]) =>
          workspace.id === payload.workspace!.id ? payload.workspace! : workspace
        ),
      },
      message: "Discord workspace synced.",
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      message: `Discord sync failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function syncLarkWorkspace(workspaceId: string): Promise<void> {
  store.update((state) => ({ ...state, isSyncingSlack: true, message: "" }));
  try {
    const response = await fetch("/api/lark-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Lark sync failed");
    }
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      config: {
        ...state.config,
        workspaces: state.config.workspaces.map((workspace: DashboardConfig["workspaces"][number]) =>
          workspace.id === payload.workspace!.id ? payload.workspace! : workspace
        ),
      },
      message: "Lark workspace synced.",
    }));
  } catch (error) {
    store.update((state) => ({
      ...state,
      isSyncingSlack: false,
      message: `Lark sync failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  }
}

async function discoverSlackWorkspace(
  slackAppToken: string,
  slackBotToken: string
): Promise<DashboardConfig["workspaces"][number] | null> {
  const appToken = slackAppToken.trim();
  const botToken = slackBotToken.trim();
  if (!appToken || !botToken) {
    store.update((state) => ({
      ...state,
      message: "Validation failed: Slack app token and bot token are required.",
    }));
    return null;
  }

  store.update((state) => ({ ...state, isAddingWorkspace: true, message: "" }));
  try {
    const response = await fetch("/api/slack-discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slackAppToken: appToken, slackBotToken: botToken }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Failed to discover Slack workspace");
    }

    let addedWorkspace: DashboardConfig["workspaces"][number] | null = null;
    let duplicateId = "";
    store.update((state) => {
      if (state.config.workspaces.some((workspace: DashboardConfig["workspaces"][number]) => workspace.id === payload.workspace!.id)) {
        duplicateId = payload.workspace!.id;
        return {
          ...state,
          isAddingWorkspace: false,
        };
      }
      addedWorkspace = payload.workspace!;
      return {
        ...state,
        isAddingWorkspace: false,
        config: {
          ...state.config,
          workspaces: [...state.config.workspaces, payload.workspace!],
        },
        message: `Added Slack workspace: ${payload.workspace!.name || payload.workspace!.id}`,
      };
    });

    if (duplicateId) {
      store.update((state) => ({
        ...state,
        message: `Workspace already exists: ${duplicateId}`,
      }));
      return null;
    }

    return addedWorkspace;
  } catch (error) {
    store.update((state) => ({
      ...state,
      isAddingWorkspace: false,
      message: `Add workspace failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return null;
  }
}

async function discoverDiscordWorkspace(
  discordBotToken: string
): Promise<DashboardConfig["workspaces"][number] | null> {
  const botToken = discordBotToken.trim();
  if (!botToken) {
    store.update((state) => ({
      ...state,
      message: "Validation failed: Discord bot token is required.",
    }));
    return null;
  }

  store.update((state) => ({ ...state, isAddingWorkspace: true, message: "" }));
  try {
    const response = await fetch("/api/discord-discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ discordBotToken: botToken }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Failed to discover Discord workspace");
    }

    let addedWorkspace: DashboardConfig["workspaces"][number] | null = null;
    let duplicateId = "";
    store.update((state) => {
      if (state.config.workspaces.some((workspace: DashboardConfig["workspaces"][number]) => workspace.id === payload.workspace!.id)) {
        duplicateId = payload.workspace!.id;
        return {
          ...state,
          isAddingWorkspace: false,
        };
      }
      addedWorkspace = payload.workspace!;
      return {
        ...state,
        isAddingWorkspace: false,
        config: {
          ...state.config,
          workspaces: [...state.config.workspaces, payload.workspace!],
        },
        message: `Added Discord workspace: ${payload.workspace!.name || payload.workspace!.id}`,
      };
    });

    if (duplicateId) {
      store.update((state) => ({
        ...state,
        message: `Workspace already exists: ${duplicateId}`,
      }));
      return null;
    }

    return addedWorkspace;
  } catch (error) {
    store.update((state) => ({
      ...state,
      isAddingWorkspace: false,
      message: `Add workspace failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return null;
  }
}

async function discoverLarkWorkspace(
  larkAppKey: string,
  larkAppSecret: string
): Promise<DashboardConfig["workspaces"][number] | null> {
  const appId = larkAppKey.trim();
  const appSecret = larkAppSecret.trim();
  if (!appId || !appSecret) {
    store.update((state) => ({
      ...state,
      message: "Validation failed: Lark app key and app secret are required.",
    }));
    return null;
  }

  store.update((state) => ({ ...state, isAddingWorkspace: true, message: "" }));
  try {
    const response = await fetch("/api/lark-discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ larkAppKey: appId, larkAppSecret: appSecret }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      workspace?: DashboardConfig["workspaces"][number];
    };
    if (!response.ok || !payload.ok || !payload.workspace) {
      throw new Error(payload.error || "Failed to discover Lark workspace");
    }

    let addedWorkspace: DashboardConfig["workspaces"][number] | null = null;
    let duplicateId = "";
    store.update((state) => {
      if (state.config.workspaces.some((workspace: DashboardConfig["workspaces"][number]) => workspace.id === payload.workspace!.id)) {
        duplicateId = payload.workspace!.id;
        return {
          ...state,
          isAddingWorkspace: false,
        };
      }
      addedWorkspace = payload.workspace!;
      return {
        ...state,
        isAddingWorkspace: false,
        config: {
          ...state.config,
          workspaces: [...state.config.workspaces, payload.workspace!],
        },
        message: `Added Lark workspace: ${payload.workspace!.name || payload.workspace!.id}`,
      };
    });

    if (duplicateId) {
      store.update((state) => ({
        ...state,
        message: `Workspace already exists: ${duplicateId}`,
      }));
      return null;
    }

    return addedWorkspace;
  } catch (error) {
    store.update((state) => ({
      ...state,
      isAddingWorkspace: false,
      message: `Add workspace failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    return null;
  }
}

export const localSettingStore = {
  subscribe: store.subscribe,
  loadConfig,
  saveConfig,
  checkAgents,
  syncSlackWorkspace,
  syncDiscordWorkspace,
  syncLarkWorkspace,
  discoverSlackWorkspace,
  discoverDiscordWorkspace,
  discoverLarkWorkspace,
  updateConfig,
  updateWorkspace,
  removeWorkspace,
};
