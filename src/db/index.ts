import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../config";
import { log } from "../logger";

type ProfileRecord = {
  id: string;
  opencode_server_url: string | null;
  slack_user_id: string | null;
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
