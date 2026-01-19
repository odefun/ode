import { homedir } from "os";
import { resolve, join } from "path";
import { z } from "zod";

export function normalizeCwd(input: string): string {
  if (!input) return process.cwd();
  if (input === "~") return homedir();
  if (input.startsWith("~/")) {
    return resolve(join(homedir(), input.slice(2)));
  }
  return resolve(input);
}

const envSchema = z.object({
  // Slack configuration
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-"),
  SLACK_APP_TOKEN: z.string().startsWith("xapp-"),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_TARGET_CHANNELS: z.string().optional(), // comma-separated channel IDs

  // Agent selection
  CODING_AGENT: z.enum(["opencode", "claude"]).default("opencode"),

  // Working directory
  DEFAULT_CWD: z.string().default(process.cwd()).transform(normalizeCwd),

  // OAuth callback handling
  OAUTH_CALLBACK_PORT: z.coerce.number().default(3000),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // OpenCode server
  OPENCODE_SERVER_URL: z.string().default("http://127.0.0.1:4096"),

  // OpenCode diagnostics
  OPENCODE_EVENT_DUMP: z.coerce.boolean().default(false),

  SUPABASE_URL: z.string().default(''),
  SUPABASE_SECRET_KEY: z.string().default(''),
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
