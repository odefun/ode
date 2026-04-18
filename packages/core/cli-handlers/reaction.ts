import { addDiscordReaction, addLarkReaction, addSlackReaction } from "@/ims";
import { resolveChannel } from "./channel-resolver";
import { parseFlags } from "./flags";

type CliArgs = string[];

function printReactionHelp(): void {
  console.log(
    [
      "ode reaction - add reactions to chat messages",
      "",
      "Usage:",
      "  ode reaction add <messageId> --channel <channelId> --emoji <name> [--thread <threadId>]",
      "",
      "Notes:",
      "  Supported --emoji values: thumbsup, eyes, ok_hand (aliases: thumbup, ok).",
      "  --channel accepts either a raw channel id or a \"workspaceId::channelId\" value.",
      "  --thread is currently informational; reactions resolve to the message id directly.",
    ].join("\n"),
  );
}

async function handleReactionAdd(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { channel: true, emoji: true, thread: true });
  const messageId = positional[0];
  if (!messageId) throw new Error("Message id is required: ode reaction add <messageId> --channel ... --emoji ...");
  const channel = flags.channel as string | undefined;
  if (!channel) throw new Error("--channel is required");
  const emoji = flags.emoji as string | undefined;
  if (!emoji) throw new Error("--emoji is required");

  const resolved = resolveChannel(channel);

  let payload: { platform: string } & Record<string, unknown>;
  if (resolved.platform === "slack") {
    const result = await addSlackReaction({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      messageId,
      emoji,
    });
    payload = { platform: resolved.platform, ...result };
  } else if (resolved.platform === "discord") {
    const result = await addDiscordReaction({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      messageId,
      emoji,
    });
    payload = { platform: resolved.platform, ...result };
  } else {
    const result = await addLarkReaction({
      appId: resolved.appId,
      appSecret: resolved.appSecret,
      messageId,
      emoji,
    });
    payload = { platform: resolved.platform, ...result };
  }

  console.log(JSON.stringify(payload, null, 2));
}

export async function handleReactionCommand(args: CliArgs): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printReactionHelp();
    return 0;
  }
  try {
    const rest = args.slice(1);
    if (sub === "add") {
      await handleReactionAdd(rest);
      return 0;
    }
    console.error(`Unknown reaction subcommand: ${sub}`);
    printReactionHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
