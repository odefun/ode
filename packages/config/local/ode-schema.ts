import { z } from "zod";
import { AGENT_PROVIDERS } from "@/shared/agent-provider";
import { DEFAULT_STATUS_MESSAGE_FREQUENCY_MS } from "../status-message-frequency";
import { GIT_STRATEGY_VALUES, STATUS_MESSAGE_FORMAT_VALUES } from "../baseConfig";

const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

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

const enabledAgentSchema = z.object({
  enabled: z.boolean().optional().default(true),
});

const modelEnabledAgentSchema = enabledAgentSchema.extend({
  models: z.array(z.string()).optional().default([]),
});

const createEnabledAgentDefault = () => ({ enabled: true });
const createModelEnabledAgentDefault = () => ({ enabled: true, models: [] as string[] });

const createDefaultAgentsConfig = () => ({
  opencode: createModelEnabledAgentDefault(),
  claudecode: createEnabledAgentDefault(),
  codex: createModelEnabledAgentDefault(),
  kimi: createEnabledAgentDefault(),
  kiro: createEnabledAgentDefault(),
  kilo: createModelEnabledAgentDefault(),
  qwen: createEnabledAgentDefault(),
  goose: createEnabledAgentDefault(),
  gemini: createEnabledAgentDefault(),
});

const agentsSchema = z.object({
  opencode: modelEnabledAgentSchema.optional().default(createModelEnabledAgentDefault()),
  claudecode: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
  codex: modelEnabledAgentSchema.optional().default(createModelEnabledAgentDefault()),
  kimi: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
  kiro: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
  kilo: modelEnabledAgentSchema.optional().default(createModelEnabledAgentDefault()),
  qwen: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
  goose: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
  gemini: enabledAgentSchema.optional().default(createEnabledAgentDefault()),
}).optional().default(createDefaultAgentsConfig());

const channelDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentProvider: z.preprocess(
    (value) => (value === "claude" ? "claudecode" : value),
    agentProviderSchema.optional().default("opencode")
  ),
  model: z.string().optional().default(""),
  workingDirectory: z.string().optional().default(""),
  baseBranch: z.string().optional().default("main"),
  channelSystemMessage: z.string().optional().default(""),
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
export type OdeConfig = z.infer<typeof odeConfigSchema>;
export type UserConfig = z.infer<typeof userSchema>;
