import { z } from "zod";
import { AGENT_PROVIDERS, normalizeAgentProviderId } from "@/shared/agent-provider";
import { DEFAULT_STATUS_MESSAGE_FREQUENCY_MS } from "../status-message-frequency";
import { GIT_STRATEGY_VALUES, STATUS_MESSAGE_FORMAT_VALUES } from "../baseConfig";

const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_COMPUTER_GATEWAY = {
  enabled: false,
  browserDriver: "agent-browser" as const,
  desktopDriver: "ode" as const,
  browserExecutable: "agent-browser",
  desktopExecutable: "ode",
  browserHeaded: false,
  commandTimeoutMs: 30_000,
  approvalTimeoutMs: 10 * 60_000,
};

export const computerGatewaySchema = z.object({
  enabled: z.boolean().optional().default(false),
  browserDriver: z.literal("agent-browser").optional().default("agent-browser"),
  desktopDriver: z.preprocess((value) => value === "peekaboo" ? "ode" : value, z.literal("ode").optional().default("ode")),
  browserExecutable: z.string().optional().default("agent-browser"),
  desktopExecutable: z.preprocess((value) => value === "peekaboo" ? "ode" : value, z.string().optional().default("ode")),
  browserHeaded: z.boolean().optional().default(false),
  commandTimeoutMs: z.number().int().min(1_000).max(10 * 60_000).optional().default(30_000),
  approvalTimeoutMs: z.number().int().min(10_000).max(60 * 60_000).optional().default(10 * 60_000),
});

const DEFAULT_CHANNEL_COMPUTER_USE = {
  browser: "off" as const,
  desktop: "off" as const,
  browserProfile: "",
  allowedOrigins: ["http://localhost:*", "http://127.0.0.1:*"],
  allowedApps: [] as string[],
  approvalPolicy: "consequential" as const,
};

export const channelComputerUseSchema = z.object({
  browser: z.enum(["off", "observe", "interact"]).optional().default("off"),
  desktop: z.enum(["off", "observe", "control"]).optional().default("off"),
  browserProfile: z.string().optional().default(""),
  allowedOrigins: z.array(z.string()).optional().default([
    "http://localhost:*",
    "http://127.0.0.1:*",
  ]),
  allowedApps: z.array(z.string()).optional().default([]),
  approvalPolicy: z.enum(["consequential", "always", "never"]).optional().default("consequential"),
});

const userSchema = z.object({
  name: z.string().optional().default(""),
  email: z.string().optional().default(""),
  initials: z.string().optional().default(""),
  avatar: z.string().optional().default(""),
  gitStrategy: z.enum(GIT_STRATEGY_VALUES).optional().default("worktree"),
  defaultStatusMessageFormat: z.enum(STATUS_MESSAGE_FORMAT_VALUES).optional().default("medium"),
  IM_MESSAGE_UPDATE_INTERVAL_MS: z.number().optional().default(DEFAULT_STATUS_MESSAGE_FREQUENCY_MS),
});

export const agentProviderSchema = z.enum(AGENT_PROVIDERS);

const agentsSchema = z.object({
  opencode: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  claudecode: z.object({
    enabled: z.boolean().optional().default(true),
  }).optional().default({ enabled: true }),
  codex: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  kimi: z.object({
    enabled: z.boolean().optional().default(true),
  }).optional().default({ enabled: true }),
  kilo: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  qwen: z.object({
    enabled: z.boolean().optional().default(true),
  }).optional().default({ enabled: true }),
  goose: z.object({
    enabled: z.boolean().optional().default(true),
  }).optional().default({ enabled: true }),
  pi: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  openhands: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  codebuddy: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
  crush: z.object({
    enabled: z.boolean().optional().default(true),
    models: z.array(z.string()).optional().default([]),
  }).optional().default({ enabled: true, models: [] }),
}).optional().default({
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
});

const channelDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentProvider: z.preprocess(
    (value) => normalizeAgentProviderId(value),
    agentProviderSchema.optional().default("opencode")
  ),
  model: z.string().optional().default(""),
  workingDirectory: z.string().optional().default(""),
  baseBranch: z.string().optional().default("main"),
  channelSystemMessage: z.string().optional().default(""),
  computerUse: channelComputerUseSchema.optional().default(DEFAULT_CHANNEL_COMPUTER_USE),
});

const updateSchema = z.object({
  autoUpgrade: z.boolean().optional().default(true),
  checkIntervalMs: z.number().optional().default(DEFAULT_UPDATE_INTERVAL_MS),
});

const workspaceSchema = z.object({
  id: z.string(),
  type: z.enum(["slack", "discord", "lark"]).optional().default("slack"),
  name: z.string().optional().default(""),
  domain: z.string().optional().default(""),
  status: z.enum(["active", "paused"]).optional().default("active"),
  channels: z.number().optional().default(0),
  members: z.number().optional().default(0),
  lastSync: z.string().optional().default(""),
  slackAppToken: z.string().optional().default(""),
  slackBotToken: z.string().optional().default(""),
  discordBotToken: z.string().optional().default(""),
  larkAppKey: z.string().optional().default(""),
  larkAppId: z.string().optional().default(""),
  larkAppSecret: z.string().optional().default(""),
  channelDetails: z.array(channelDetailSchema).optional().default([]),
});

export const odeConfigSchema = z.object({
  user: userSchema,
  githubInfos: z
    .record(
      z.string(),
      z.object({
        token: z.string().optional().default(""),
        gitName: z.string().optional().default(""),
        gitEmail: z.string().optional().default(""),
      })
    )
    .optional()
    .default({}),
  agents: agentsSchema,
  computerGateway: computerGatewaySchema.optional().default(DEFAULT_COMPUTER_GATEWAY),
  completeOnboarding: z.boolean().optional().default(false),
  workspaces: z.array(workspaceSchema),
  updates: updateSchema.optional().default({
    autoUpgrade: true,
    checkIntervalMs: DEFAULT_UPDATE_INTERVAL_MS,
  }),
});

export type ChannelDetail = z.infer<typeof channelDetailSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type AgentsConfig = z.infer<typeof agentsSchema>;
export type UpdateConfig = z.infer<typeof updateSchema>;
export type ComputerGatewayConfig = z.infer<typeof computerGatewaySchema>;
export type ChannelComputerUseConfig = z.infer<typeof channelComputerUseSchema>;
export type OdeConfig = z.infer<typeof odeConfigSchema>;
export type UserConfig = z.infer<typeof userSchema>;
