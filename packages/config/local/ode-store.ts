import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_STATUS_MESSAGE_FREQUENCY_MS } from "../status-message-frequency";
import { normalizeGitStrategy, normalizeStatusMessageFormat } from "../baseConfig";
import {
  odeConfigSchema,
  type OdeConfig,
} from "./ode-schema";
import {
  AGENT_PROVIDERS,
  providerSupportsModelSelection,
} from "@/shared/agent-provider";

const existsSync = fs.existsSync;
const mkdirSync = fs.mkdirSync;
const readFileSync = fs.readFileSync;
const writeFileSync = fs.writeFileSync;
const join = typeof path.join === "function" ? path.join : (...parts: string[]) => parts.join("/");
const homedir = typeof os.homedir === "function" ? os.homedir : () => "";

const XDG_CONFIG_HOME = join(homedir(), ".config");
const ODE_CONFIG_DIR = join(XDG_CONFIG_HOME, "ode");
export const ODE_CONFIG_FILE = join(ODE_CONFIG_DIR, "ode.json");

const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const MIN_UPDATE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MESSAGE_UPDATE_INTERVAL_MS = DEFAULT_STATUS_MESSAGE_FREQUENCY_MS;
const MIN_MESSAGE_UPDATE_INTERVAL_MS = 250;

let cachedConfig: OdeConfig | null = null;

function createDefaultAgentsConfig(): OdeConfig["agents"] {
  return Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => [
      provider,
      providerSupportsModelSelection(provider)
        ? { enabled: true, models: [] }
        : { enabled: true },
    ])
  ) as unknown as OdeConfig["agents"];
}

const EMPTY_TEMPLATE: OdeConfig = {
  user: {
    name: "",
    email: "",
    initials: "",
    avatar: "",
    gitStrategy: "worktree",
    defaultStatusMessageFormat: "medium",
    IM_MESSAGE_UPDATE_INTERVAL_MS: DEFAULT_STATUS_MESSAGE_FREQUENCY_MS,
  },
  githubInfos: {},
  agents: createDefaultAgentsConfig(),
  completeOnboarding: false,
  workspaces: [],
  updates: {
    autoUpgrade: true,
    checkIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
  },
};

function normalizeModelList(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models
    .filter((model): model is string => typeof model === "string")
    .map((model) => model.trim())
    .filter(Boolean)));
}

function normalizeAgentsConfig(config: OdeConfig): OdeConfig["agents"] {
  const agents = config.agents as Record<string, unknown>;
  return Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => {
      const providerConfig = (agents[provider] ?? {}) as Record<string, unknown>;
      const enabled = providerConfig.enabled !== false;
      if (!providerSupportsModelSelection(provider)) {
        return [provider, { enabled }] as const;
      }
      return [
        provider,
        {
          enabled,
          models: normalizeModelList(providerConfig.models),
        },
      ] as const;
    })
  ) as unknown as OdeConfig["agents"];
}

function ensureConfigDir(): void {
  if (!existsSync(ODE_CONFIG_DIR)) {
    mkdirSync(ODE_CONFIG_DIR, { recursive: true });
  }
}

function ensureConfigFile(): void {
  if (existsSync(ODE_CONFIG_FILE)) return;
  ensureConfigDir();
  writeFileSync(ODE_CONFIG_FILE, JSON.stringify(EMPTY_TEMPLATE, null, 2));
}

export function normalizeBaseBranch(baseBranch: string | null | undefined): string {
  const normalized = baseBranch?.trim();
  return normalized && normalized.length > 0 ? normalized : "main";
}

function normalizeConfig(config: OdeConfig): OdeConfig {
  const normalizedStatusMessageFormat = normalizeStatusMessageFormat(config.user.defaultStatusMessageFormat);
  const normalizedGitStrategy = normalizeGitStrategy(config.user.gitStrategy);
  const messageUpdateIntervalCandidate =
    config.user.IM_MESSAGE_UPDATE_INTERVAL_MS ?? DEFAULT_MESSAGE_UPDATE_INTERVAL_MS;
  const normalizedMessageUpdateInterval =
    Number.isFinite(messageUpdateIntervalCandidate) && messageUpdateIntervalCandidate > 0
      ? Math.max(messageUpdateIntervalCandidate, MIN_MESSAGE_UPDATE_INTERVAL_MS)
      : DEFAULT_MESSAGE_UPDATE_INTERVAL_MS;
  const intervalCandidate = config.updates?.checkIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  const normalizedInterval =
    Number.isFinite(intervalCandidate) && intervalCandidate > 0
      ? Math.max(intervalCandidate, MIN_UPDATE_INTERVAL_MS)
      : DEFAULT_UPDATE_INTERVAL_MS;
  const autoUpgrade = config.updates?.autoUpgrade ?? true;
  const completeOnboarding = config.completeOnboarding === true;
  const workspaces = config.workspaces.map((workspace) => ({
    ...workspace,
    type:
      workspace.type === "discord"
        ? "discord" as const
        : workspace.type === "lark"
          ? "lark" as const
          : "slack" as const,
    channelDetails: workspace.channelDetails.map((channel) => ({
      ...channel,
      baseBranch: normalizeBaseBranch(channel.baseBranch),
    })),
  }));
  return {
    ...config,
    user: {
      ...config.user,
      gitStrategy: normalizedGitStrategy,
      defaultStatusMessageFormat: normalizedStatusMessageFormat,
      IM_MESSAGE_UPDATE_INTERVAL_MS: normalizedMessageUpdateInterval,
    },
    updates: {
      autoUpgrade,
      checkIntervalMs: normalizedInterval,
    },
    agents: normalizeAgentsConfig(config),
    completeOnboarding,
    workspaces,
  };
}

export function loadOdeConfig(): OdeConfig {
  if (cachedConfig) return cachedConfig;

  ensureConfigFile();

  if (!existsSync(ODE_CONFIG_FILE)) {
    cachedConfig = normalizeConfig(EMPTY_TEMPLATE);
    return cachedConfig;
  }

  try {
    const raw = readFileSync(ODE_CONFIG_FILE, "utf-8");
    const parsedJson = JSON.parse(raw) as Record<string, unknown>;
    const parsed = odeConfigSchema.safeParse(parsedJson);
    const base = parsed.success ? parsed.data : EMPTY_TEMPLATE;
    cachedConfig = normalizeConfig(base);
    return cachedConfig;
  } catch {
    cachedConfig = normalizeConfig(EMPTY_TEMPLATE);
    return cachedConfig;
  }
}

export function invalidateOdeConfigCache(): void {
  cachedConfig = null;
}

export function saveOdeConfig(config: OdeConfig): void {
  ensureConfigDir();
  cachedConfig = normalizeConfig(config);
  writeFileSync(ODE_CONFIG_FILE, JSON.stringify(cachedConfig, null, 2));
}

export function updateOdeConfig(updater: (config: OdeConfig) => OdeConfig): OdeConfig {
  const next = updater(structuredClone(loadOdeConfig()));
  saveOdeConfig(next);
  return loadOdeConfig();
}
