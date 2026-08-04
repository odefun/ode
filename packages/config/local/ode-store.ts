import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_STATUS_MESSAGE_FREQUENCY_MS } from "../status-message-frequency";
import { normalizeGitStrategy, normalizeStatusMessageFormat } from "../baseConfig";
import {
  odeConfigSchema,
  type OdeConfig,
} from "./ode-schema";

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
  agents: {
    opencode: { enabled: true, models: [] },
    claudecode: { enabled: true },
    codex: { enabled: true, models: [] },
    kimi: { enabled: true },
    kilo: { enabled: true, models: [] },
    qwen: { enabled: true },
    goose: { enabled: true },
    pi: { enabled: true, models: [] },
    openhands: { enabled: true, models: [] },
    codebuddy: { enabled: true, models: [] },
    crush: { enabled: true, models: [] },
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
  completeOnboarding: false,
  workspaces: [],
  updates: {
    autoUpgrade: true,
    checkIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
  },
};

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
  const opencodeModels = Array.from(new Set((config.agents?.opencode?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const codexModels = Array.from(new Set((config.agents?.codex?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const kiloModels = Array.from(new Set((config.agents?.kilo?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const piModels = Array.from(new Set((config.agents?.pi?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const openhandsModels = Array.from(new Set((config.agents?.openhands?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const codebuddyModels = Array.from(new Set((config.agents?.codebuddy?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
  const crushModels = Array.from(new Set((config.agents?.crush?.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)));
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
    agents: {
      opencode: {
        enabled: config.agents?.opencode?.enabled ?? true,
        models: opencodeModels,
      },
      claudecode: {
        enabled: config.agents?.claudecode?.enabled ?? true,
      },
      codex: {
        enabled: config.agents?.codex?.enabled ?? true,
        models: codexModels,
      },
      kimi: {
        enabled: config.agents?.kimi?.enabled ?? true,
      },
      kilo: {
        enabled: config.agents?.kilo?.enabled ?? true,
        models: kiloModels,
      },
      qwen: {
        enabled: config.agents?.qwen?.enabled ?? true,
      },
      goose: {
        enabled: config.agents?.goose?.enabled ?? true,
      },
      pi: {
        enabled: config.agents?.pi?.enabled ?? true,
        models: piModels,
      },
      openhands: {
        enabled: config.agents?.openhands?.enabled ?? true,
        models: openhandsModels,
      },
      codebuddy: {
        enabled: config.agents?.codebuddy?.enabled ?? true,
        models: codebuddyModels,
      },
      crush: {
        enabled: config.agents?.crush?.enabled ?? true,
        models: crushModels,
      },
    },
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
