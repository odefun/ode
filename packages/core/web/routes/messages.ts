import type { Elysia } from "elysia";
import { getDiscordThreadMessages, getLarkThreadMessages, getSlackThreadMessages } from "@/ims";
import { buildThreadMessagesResult } from "@/ims/shared/thread-messages";
import { attachDiscordBotToken, attachLarkCredentials } from "../config-validation";
import { jsonResponse, readJsonBody, runRoute } from "../http";
import { resolveChannelLocator } from "./channel-resolver";

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function getOptionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getOptionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getBoolean(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}

export function registerMessagesRoutes(app: Elysia): void {
  /**
   * Fetch messages from a thread / channel. Powers `ode messages get`. The
   * server resolves which messaging platform owns the channel and calls the
   * dedicated per-platform helper — callers don't need to know whether the
   * channel is Slack / Discord / Lark.
   */
  app.post("/api/messages/thread", async ({ request }: { request: Request }) => {
    return runRoute(
      async () => {
        const body = await readJsonBody(request);
        const channelIdRaw = getString(body, "channelId");
        if (!channelIdRaw) {
          throw new Error("channelId is required");
        }
        const threadId = getOptionalString(body, "threadId");
        const limit = getOptionalNumber(body, "limit");
        const downloadAttachments = getBoolean(body, "downloadAttachments");

        const resolved = resolveChannelLocator(channelIdRaw);

        if (resolved.platform === "slack") {
          if (!threadId) {
            throw new Error("threadId is required");
          }
          const result = await getSlackThreadMessages({
            channelId: resolved.channelId,
            threadId,
            limit,
            downloadAttachments,
          });
          return buildThreadMessagesResult({
            platform: resolved.platform,
            messages: result.messages,
            requestedLimit: limit,
            downloadAttachments,
          });
        }

        if (resolved.platform === "discord") {
          const discordPayload: Record<string, unknown> = { channelId: resolved.channelId };
          attachDiscordBotToken(discordPayload);
          const botToken = typeof discordPayload.botToken === "string" ? discordPayload.botToken : "";
          if (!botToken) {
            throw new Error("Discord bot token not configured");
          }
          const result = await getDiscordThreadMessages({
            botToken,
            channelId: resolved.channelId,
            threadId,
            limit,
            downloadAttachments,
          });
          return buildThreadMessagesResult({
            platform: resolved.platform,
            messages: result.messages,
            requestedLimit: limit,
            downloadAttachments,
          });
        }

        if (resolved.platform === "lark") {
          if (!threadId) {
            throw new Error("threadId is required");
          }
          const larkPayload: Record<string, unknown> = {
            channelId: resolved.channelId,
            workspaceId: resolved.workspaceId,
          };
          attachLarkCredentials(larkPayload);
          const appId = typeof larkPayload.appId === "string" ? larkPayload.appId : "";
          const appSecret = typeof larkPayload.appSecret === "string" ? larkPayload.appSecret : "";
          if (!appId || !appSecret) {
            throw new Error("Lark app credentials not configured");
          }
          const result = await getLarkThreadMessages({
            appId,
            appSecret,
            channelId: resolved.channelId,
            threadId,
            limit,
            downloadAttachments,
          });
          return buildThreadMessagesResult({
            platform: resolved.platform,
            messages: result.messages,
            requestedLimit: limit,
            downloadAttachments,
          });
        }

        throw new Error(`Unsupported platform: ${resolved.platform}`);
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to fetch messages",
        resolveStatus: (message) => {
          if (message === "channelId is required") return 400;
          if (message === "threadId is required") return 400;
          if (message === "Channel not found in configured workspaces") return 404;
          if (message.includes("not configured")) return 400;
          return 500;
        },
      },
    );
  });
}
