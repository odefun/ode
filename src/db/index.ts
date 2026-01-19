import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../config";
import { log } from "../logger";

type ProfileRecord = {
  id: string;
  opencode_server_url: string | null;
  slack_user_id: string | null;
};

type SlackBotTokenRecord = {
  bot_token: string | null;
  workspace_name: string | null;
};

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const env = loadEnv();
  client = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY
  );
  return client;
}

export type WorkspaceToken = {
  botToken: string;
  workspaceName: string | null;
};

/**
 * Get all unique bot tokens from the database for multi-workspace support
 */
export async function getAllBotTokens(): Promise<WorkspaceToken[]> {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("user_slack_info")
      .select("bot_token, workspace_name");

    if (error) {
      log.warn("Failed to fetch bot tokens from database", { error: error.message });
      return [];
    }

    if (!data || data.length === 0) {
      log.debug("No bot tokens found in database");
      return [];
    }

    // Get unique bot tokens with their workspace names
    const tokenMap = new Map<string, string | null>();
    for (const record of data as SlackBotTokenRecord[]) {
      if (record.bot_token && !tokenMap.has(record.bot_token)) {
        tokenMap.set(record.bot_token, record.workspace_name);
      }
    }

    const tokens: WorkspaceToken[] = Array.from(tokenMap.entries()).map(
      ([botToken, workspaceName]) => ({ botToken, workspaceName })
    );

    log.info("Fetched bot tokens from database", { count: tokens.length });
    return tokens;
  } catch (err) {
    log.warn("Error fetching bot tokens", { error: String(err) });
    return [];
  }
}

export async function getProfileBySlackUserId(slackUserId: string): Promise<ProfileRecord | null> {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("user_slack_info")
      .select("id, opencode_server_url, slack_user_id")
      .eq("slack_user_id", slackUserId)
      .maybeSingle();

    if (error) {
      log.warn("Supabase profile lookup failed", { error: error.message, slackUserId });
      return null;
    }

    return data ?? null;
  } catch (err) {
    log.warn("Supabase profile lookup error", { error: String(err), slackUserId });
    return null;
  }
}
