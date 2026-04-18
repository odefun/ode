import { getWorkspaces } from "@/config";

// ---------------------------------------------------------------------------
// Shared CLI-side channel resolver.
//
// Translates a user-supplied channel locator (`<channelId>` or
// `<workspaceId>::<channelId>`) into `(platform, workspaceId, channelId)` plus
// the matching credential (Slack bot token / Discord bot token / Lark app
// credentials) that the `ode send` / `ode messages` / `ode reaction` CLIs
// need to call Slack/Discord/Lark directly.
//
// The resolver reads the on-disk Ode config (`~/.config/ode/ode.json`) via
// `getWorkspaces()`, so it works from the CLI process without a running
// daemon.
// ---------------------------------------------------------------------------

export type Platform = "slack" | "discord" | "lark";

export type ResolvedSlackChannel = {
  platform: "slack";
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  botToken: string;
};

export type ResolvedDiscordChannel = {
  platform: "discord";
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  botToken: string;
};

export type ResolvedLarkChannel = {
  platform: "lark";
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  appId: string;
  appSecret: string;
};

export type ResolvedChannel = ResolvedSlackChannel | ResolvedDiscordChannel | ResolvedLarkChannel;

type ChannelLocator = {
  workspaceHint: string;
  channelId: string;
};

function parseChannelLocator(input: string): ChannelLocator {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("--channel is required");
  }
  const delimiterIndex = trimmed.lastIndexOf("::");
  const workspaceHint = delimiterIndex >= 0 ? trimmed.slice(0, delimiterIndex).trim() : "";
  const channelId = delimiterIndex >= 0 ? trimmed.slice(delimiterIndex + 2).trim() : trimmed;
  if (!channelId) {
    throw new Error("--channel is required");
  }
  return { workspaceHint, channelId };
}

/**
 * Resolve a channel locator to a concrete workspace + channel + platform
 * credential. Throws if no matching workspace has this channel configured or
 * if the workspace is missing its credentials.
 */
export function resolveChannel(input: string): ResolvedChannel {
  const { workspaceHint, channelId } = parseChannelLocator(input);
  const workspaces = getWorkspaces();

  for (const workspace of workspaces) {
    if (workspaceHint && workspace.id !== workspaceHint) continue;
    if (!workspace.channelDetails.some((entry) => entry.id === channelId)) continue;

    if (workspace.type === "slack") {
      const botToken = workspace.slackBotToken?.trim();
      if (!botToken) {
        throw new Error(`Slack bot token missing for workspace ${workspace.id}`);
      }
      return {
        platform: "slack",
        workspaceId: workspace.id,
        workspaceName: workspace.name || workspace.id,
        channelId,
        botToken,
      };
    }
    if (workspace.type === "discord") {
      const botToken = workspace.discordBotToken?.trim();
      if (!botToken) {
        throw new Error(`Discord bot token missing for workspace ${workspace.id}`);
      }
      return {
        platform: "discord",
        workspaceId: workspace.id,
        workspaceName: workspace.name || workspace.id,
        channelId,
        botToken,
      };
    }
    if (workspace.type === "lark") {
      const appId = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      const appSecret = workspace.larkAppSecret?.trim() ?? "";
      if (!appId || !appSecret) {
        throw new Error(`Lark app credentials missing for workspace ${workspace.id}`);
      }
      return {
        platform: "lark",
        workspaceId: workspace.id,
        workspaceName: workspace.name || workspace.id,
        channelId,
        appId,
        appSecret,
      };
    }
  }

  throw new Error("Channel not found in configured workspaces");
}
