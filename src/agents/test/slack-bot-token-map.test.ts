import { describe, it } from "bun:test";
import { WebClient } from "@slack/web-api";
import { loadEnv } from "../../config";
import { getAllBotTokens } from "../../db";
import { log } from "../../logger";

function truncateToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

describe("slack bot token map", () => {
  it("logs team and enterprise ids for db bot tokens", async () => {
    const env = loadEnv();
    const tokens = await getAllBotTokens();

    if (tokens.length === 0) {
      log.warn("No bot tokens found in database for slack test");
      return;
    }

    const results: Array<Record<string, string | null>> = [];

    for (const token of tokens) {
      if (!token.botToken) continue;

      const client = new WebClient(token.botToken);
      try {
        const auth = await client.auth.test();
        results.push({
          workspaceName: token.workspaceName ?? null,
          botToken: truncateToken(token.botToken),
          teamId: (auth as any).team_id ?? null,
          enterpriseId: (auth as any).enterprise_id ?? null,
          botId: (auth as any).bot_id ?? null,
          userId: (auth as any).user_id ?? null,
          appId: (auth as any).app_id ?? null,
        });
      } catch (err) {
        results.push({
          workspaceName: token.workspaceName ?? null,
          botToken: truncateToken(token.botToken),
          teamId: null,
          enterpriseId: null,
          botId: null,
          userId: null,
          appId: null,
        });
        log.error("auth.test failed for bot token", {
          botToken: truncateToken(token.botToken),
          workspaceName: token.workspaceName ?? null,
          error: String(err),
        });
      }
    }

    console.log(results)
    log.info("Slack bot token mapping", {
      appToken: truncateToken(env.SLACK_APP_TOKEN),
      count: results.length,
      results,
    });
  });
});
