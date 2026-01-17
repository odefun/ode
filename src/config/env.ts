import { z } from "zod";

const envSchema = z.object({
  // Slack configuration
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_TARGET_CHANNELS: z.string().optional(), // comma-separated channel IDs

  // Agent selection
  CODING_AGENT: z.enum(["opencode", "claude"]).default("opencode"),

  // Working directory
  DEFAULT_CWD: z.string().default(process.cwd()),

  // Coding agent selection
  CODING_AGENT: z.enum(["opencode", "claude"]).default("opencode"),

  // OAuth callback handling
  OAUTH_CALLBACK_PORT: z.coerce.number().default(3000),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Environment validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

export function getTargetChannels(): string[] | null {
  const env = loadEnv();
  if (!env.SLACK_TARGET_CHANNELS) return null;
  return env.SLACK_TARGET_CHANNELS.split(",").map((c) => c.trim());
}
