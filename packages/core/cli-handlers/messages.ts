import { getDiscordThreadMessages, getLarkThreadMessages, getSlackThreadMessages } from "@/ims";
import { resolveChannel } from "./channel-resolver";
import { parseFlags } from "./flags";

type CliArgs = string[];

function printMessagesHelp(): void {
  console.log(
    [
      "ode messages - fetch messages from a chat thread/channel",
      "",
      "Usage:",
      "  ode messages get <threadId> --channel <channelId> [--limit N] [--json]",
      "",
      "Notes:",
      "  <threadId> is the thread root id (Slack `thread_ts`, Lark message id, Discord channel/thread id).",
      "  --limit caps how many replies to return (default 20).",
      "  --channel accepts either a raw channel id or a \"workspaceId::channelId\" value.",
      "  Ode auto-detects the platform (Slack / Discord / Lark) from the channel.",
    ].join("\n"),
  );
}

async function handleMessagesGet(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { channel: true, limit: true, json: false });
  const threadId = positional[0];
  if (!threadId) throw new Error("Thread id is required: ode messages get <threadId> --channel <channelId>");
  const channel = flags.channel as string | undefined;
  if (!channel) throw new Error("--channel is required");
  const limitRaw = flags.limit as string | undefined;
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  const resolved = resolveChannel(channel);

  let payload: { platform: string; messages: unknown[] };
  if (resolved.platform === "slack") {
    const result = await getSlackThreadMessages({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      threadId,
      limit,
    });
    payload = { platform: resolved.platform, messages: result.messages };
  } else if (resolved.platform === "discord") {
    const result = await getDiscordThreadMessages({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      threadId,
      limit,
    });
    payload = { platform: resolved.platform, messages: result.messages };
  } else {
    const result = await getLarkThreadMessages({
      appId: resolved.appId,
      appSecret: resolved.appSecret,
      channelId: resolved.channelId,
      threadId,
      limit,
    });
    payload = { platform: resolved.platform, messages: result.messages };
  }

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`platform: ${payload.platform}  count: ${payload.messages.length}`);
  console.log("--- messages ---");
  console.log(JSON.stringify(payload.messages, null, 2));
}

export async function handleMessagesCommand(args: CliArgs): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printMessagesHelp();
    return 0;
  }
  try {
    const rest = args.slice(1);
    if (sub === "get") {
      await handleMessagesGet(rest);
      return 0;
    }
    console.error(`Unknown messages subcommand: ${sub}`);
    printMessagesHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
