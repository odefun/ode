import { basename } from "path";
import { getApp } from "./client";
import { hasSimpleOptions } from "@/core/runtime/helpers";

// ---------------------------------------------------------------------------
// Slack IM helper module.
//
// Two kinds of exports live here:
//
//   1. `postSlackQuestion` — used by the core runtime (inside the daemon)
//      to render SDK-emitted `question` events as Slack button messages. It
//      needs `getApp().client` to share the Bolt-managed WebClient.
//
//   2. `uploadSlackFile` / `getSlackThreadMessages` / `addSlackReaction` —
//      thin wrappers around raw `https://slack.com/api/*` calls used by the
//      `ode send file` / `ode messages get` / `ode reaction add` CLIs. These
//      accept a bot token argument and use plain `fetch`, so they can run
//      from the CLI process without requiring the Bolt App to be initialized.
// ---------------------------------------------------------------------------

function requireString(value: unknown, label: string): string {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  return value;
}

const ALLOWED_REACTIONS = new Set(["thumbsup", "eyes", "ok_hand"]);
const REACTION_ALIASES: Record<string, string> = {
  thumbup: "thumbsup",
  ok: "ok_hand",
};

function normalizeSlackEmojiName(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed) {
    throw new Error("emoji is required");
  }
  const stripped = trimmed.replace(/^:+|:+$/g, "").replace(/:/g, "");
  const normalized = stripped || trimmed;
  const alias = REACTION_ALIASES[normalized] ?? normalized;
  if (!ALLOWED_REACTIONS.has(alias)) {
    throw new Error("emoji must be one of: thumbsup, eyes, ok_hand");
  }
  return alias;
}

function normalizeOptionLabel(option: unknown): string {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    const record = option as Record<string, unknown>;
    if (typeof record.label === "string") return record.label;
    if (typeof record.text === "string") return record.text;
    if (typeof record.value === "string") return record.value;
  }
  return String(option ?? "");
}

/**
 * Post a question to Slack. When the options are "simple" (2-5 short labels
 * with no newlines) we render interactive buttons via an `actions` block so
 * the user can tap a choice. Otherwise — including when there are no options
 * at all — we fall back to a plain text message listing the choices inline.
 *
 * Used by the runtime's `sendQuestion` path (SDK-emitted `question` events).
 */
export async function postSlackQuestion(args: {
  channelId: string;
  threadId: string;
  question: string;
  options?: string[];
  prefix?: string;
  token: string;
}): Promise<string | undefined> {
  const { channelId, threadId, question, prefix, token } = args;
  const client = getApp().client;
  const options = (args.options ?? [])
    .map((opt) => (typeof opt === "string" ? opt : normalizeOptionLabel(opt)))
    .filter((opt) => opt.trim().length > 0);

  const displayPrefix = prefix ?? "";
  const questionText = `${displayPrefix}${question}`;

  if (hasSimpleOptions(options)) {
    const buttons = options.map((opt, i) => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: opt },
      action_id: `user_choice_${i}`,
      value: opt,
    }));

    const result = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: questionText,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: questionText },
        },
        {
          type: "actions",
          block_id: "user_choice",
          elements: buttons,
        },
      ],
      token,
    });
    return result.ts ?? undefined;
  }

  const optionText = options.length > 0 ? `\nOptions: ${options.join(" / ")}` : "";
  const result = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadId,
    text: `${questionText}${optionText}`,
    token,
  });
  return result.ts ?? undefined;
}

async function slackApiCall(method: string, body: Record<string, unknown>, token: string): Promise<unknown> {
  const formBody = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      formBody.append(key, strValue);
    }
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  const data = (await response.json()) as { ok: boolean; error?: string; needed?: string };
  if (!data.ok) {
    const detail = data.needed ? ` (needed: ${data.needed})` : "";
    throw new Error(`Slack API error: ${data.error}${detail}`);
  }

  return data;
}

async function slackFileUpload(
  args: {
    channelId: string;
    threadId?: string;
    filename: string;
    title?: string;
    initialComment?: string;
    token: string;
  },
  filePath: string
): Promise<unknown> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileSize = typeof file.size === "number" && file.size > 0
    ? file.size
    : (await file.arrayBuffer()).byteLength;

  const uploadInfo = await slackApiCall("files.getUploadURLExternal", {
    filename: args.filename,
    length: fileSize,
  }, args.token) as { upload_url?: string; file_id?: string };

  if (!uploadInfo.upload_url || !uploadInfo.file_id) {
    throw new Error("Slack API error: missing upload URL response");
  }

  const formData = new FormData();
  formData.append("filename", file, args.filename);

  const response = await fetch(uploadInfo.upload_url, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Slack upload failed: ${response.status} ${response.statusText}`);
  }

  return slackApiCall("files.completeUploadExternal", {
    files: [{ id: uploadInfo.file_id, title: args.title || args.filename }],
    channel_id: args.channelId,
    thread_ts: args.threadId,
    initial_comment: args.initialComment,
  }, args.token);
}

/**
 * Upload a file to a Slack channel / thread using Slack's
 * `files.getUploadURLExternal` + `files.completeUploadExternal` flow.
 * Powers the `ode send file` CLI.
 */
export async function uploadSlackFile(args: {
  botToken: string;
  channelId: string;
  threadId?: string;
  filePath: string;
  filename?: string;
  title?: string;
  initialComment?: string;
}): Promise<{ status: "file_uploaded"; channelId: string; filename: string }> {
  const token = requireString(args.botToken, "botToken");
  const channelId = requireString(args.channelId, "channelId");
  const filePath = requireString(args.filePath, "filePath");
  const filename = args.filename || basename(filePath);
  await slackFileUpload({
    channelId,
    threadId: args.threadId,
    filename,
    title: args.title,
    initialComment: args.initialComment,
    token,
  }, filePath);
  return { status: "file_uploaded", channelId, filename };
}

/**
 * Fetch the replies of a Slack thread via `conversations.replies`. Powers
 * `ode messages get`. Uses raw `fetch` so the CLI doesn't need a Bolt App.
 */
export async function getSlackThreadMessages(args: {
  botToken: string;
  channelId: string;
  threadId: string;
  limit?: number;
}): Promise<{ messages: unknown[] }> {
  const token = requireString(args.botToken, "botToken");
  const channelId = requireString(args.channelId, "channelId");
  const threadId = requireString(args.threadId, "threadId");
  const data = await slackApiCall("conversations.replies", {
    channel: channelId,
    ts: threadId,
    limit: args.limit ?? 20,
  }, token) as { messages?: unknown[] };
  return { messages: data.messages ?? [] };
}

/**
 * Add a reaction to a Slack message. Powers `ode reaction add`.
 */
export async function addSlackReaction(args: {
  botToken: string;
  channelId: string;
  messageId: string;
  emoji: string;
}): Promise<{ status: "reaction_added" }> {
  const token = requireString(args.botToken, "botToken");
  const channelId = requireString(args.channelId, "channelId");
  const messageId = requireString(args.messageId, "messageId");
  const emoji = requireString(args.emoji, "emoji");
  const name = normalizeSlackEmojiName(emoji);
  await slackApiCall("reactions.add", {
    channel: channelId,
    timestamp: messageId,
    name,
  }, token);
  return { status: "reaction_added" };
}
