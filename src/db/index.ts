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

export type WorkspaceToken = {
  botToken: string;
  workspaceName: string | null;
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

export async function getAllBotTokens(): Promise<WorkspaceToken[]> {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("user_slack_info")
      .select("bot_token, workspace_name")
      .not("bot_token", "is", null);

    if (error) {
      log.warn("Supabase bot token lookup failed", { error: error.message });
      return [];
    }

    if (!data || data.length === 0) {
      log.debug("No bot tokens found in database");
      return [];
    }

    const tokenMap = new Map<string, string | null>();
    for (const record of data as SlackBotTokenRecord[]) {
      if (record.bot_token && !tokenMap.has(record.bot_token)) {
        tokenMap.set(record.bot_token, record.workspace_name);
      }
    }

    return Array.from(tokenMap.entries()).map(([botToken, workspaceName]) => ({
      botToken,
      workspaceName,
    }));
  } catch (err) {
    log.warn("Supabase bot token lookup error", { error: String(err) });
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
