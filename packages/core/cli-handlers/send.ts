import { uploadDiscordFile, uploadLarkFile, uploadSlackFile } from "@/ims";
import { resolveChannel } from "./channel-resolver";
import { parseFlags } from "./flags";

type CliArgs = string[];

function printSendHelp(): void {
  console.log(
    [
      "ode send - upload files/images to a chat channel",
      "",
      "Usage:",
      "  ode send file <path> --channel <channelId> [--thread <threadId>] [--filename <name>] [--title <title>] [--comment <text>]",
      "",
      "Notes:",
      "  Ode auto-detects the platform (Slack / Discord / Lark) from the channel.",
      "  --channel accepts either a raw channel id or a \"workspaceId::channelId\" value.",
      "  --thread is optional; when set, the upload lands in that thread.",
      "  --comment adds an initial message alongside the file.",
      "  Use this command to post screenshots, rendered designs, or any binary asset.",
      "  For visual checks (layout diffs, screenshots of running UI), prefer uploading the",
      "  artifact directly into the current thread so reviewers can see it inline.",
    ].join("\n"),
  );
}

async function handleSendFile(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, {
    channel: true,
    thread: true,
    filename: true,
    title: true,
    comment: true,
  });

  const filePath = positional[0];
  if (!filePath) throw new Error("File path is required: ode send file <path> --channel <channelId>");
  const channel = flags.channel as string | undefined;
  if (!channel) throw new Error("--channel is required");

  // Resolve to absolute path so the SDK helpers find the file regardless of
  // where the CLI was invoked from.
  const { resolve: resolvePath } = await import("path");
  const absolutePath = resolvePath(process.cwd(), filePath);
  const file = Bun.file(absolutePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const threadId = typeof flags.thread === "string" ? flags.thread : undefined;
  const filename = typeof flags.filename === "string" ? flags.filename : undefined;
  const title = typeof flags.title === "string" ? flags.title : undefined;
  const initialComment = typeof flags.comment === "string" ? flags.comment : undefined;

  const resolved = resolveChannel(channel);

  if (resolved.platform === "slack") {
    const result = await uploadSlackFile({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      threadId,
      filePath: absolutePath,
      filename,
      title,
      initialComment,
    });
    console.log(JSON.stringify({ platform: resolved.platform, ...result }, null, 2));
    return;
  }

  if (resolved.platform === "discord") {
    const result = await uploadDiscordFile({
      botToken: resolved.botToken,
      channelId: resolved.channelId,
      filePath: absolutePath,
      filename,
      initialComment,
    });
    console.log(JSON.stringify({ platform: resolved.platform, ...result }, null, 2));
    return;
  }

  // Lark
  const result = await uploadLarkFile({
    appId: resolved.appId,
    appSecret: resolved.appSecret,
    channelId: resolved.channelId,
    threadId,
    filePath: absolutePath,
    filename,
    title,
    initialComment,
  });
  console.log(JSON.stringify({ platform: resolved.platform, ...result }, null, 2));
}

export async function handleSendCommand(args: CliArgs): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSendHelp();
    return 0;
  }
  try {
    const rest = args.slice(1);
    if (sub === "file") {
      await handleSendFile(rest);
      return 0;
    }
    console.error(`Unknown send subcommand: ${sub}`);
    printSendHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
