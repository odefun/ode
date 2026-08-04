import { basename } from "path";
import {
  materializeThreadMessageAttachments,
  normalizeThreadMessageLimit,
  type ThreadMessage,
} from "@/ims/shared/thread-messages";
import type { AttachmentSource } from "@/ims/shared/attachment-store";
import { threadTsField } from "@/ims/shared/synthetic-owner";
import { getApp, getSlackBotToken } from "./client";

// ---------------------------------------------------------------------------
// Slack IM helper module.
//
// Historically this file hosted a generic `/api/action` dispatcher
// (`handleSlackActionPayload`) that agents called via bash+curl. That
// mechanism has been retired in favour of dedicated `ode <verb>` CLIs
// (`ode send file`, `ode messages get`, `ode reaction add`, etc.), so this
// module now only exposes:
//
//   - `uploadSlackFile`     – powering `ode send file` on Slack channels.
//   - `getSlackThreadMessages` – powering `ode messages get`.
//   - `addSlackReaction`    – powering `ode reaction add`.
//
// The private helpers (`slackApiCall`, `slackFileUpload`, …) stay as
// implementation details for those exports.
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
    // Synthetic placeholder thread ids (`task:` / `cron-job:` / `cron:`) are
    // not valid Slack timestamps. `ode send file` invoked from a scheduled
    // task/cron run before a real thread exists would otherwise fail with
    // `invalid_thread_ts`; upload to the channel top level instead.
    ...(threadTsField(args.threadId)),
    initial_comment: args.initialComment,
  }, args.token);
}

/**
 * Upload a file to a Slack channel / thread using Slack's
 * `files.getUploadURLExternal` + `files.completeUploadExternal` flow.
 * Powers the `ode send file` CLI.
 */
export async function uploadSlackFile(args: {
  channelId: string;
  threadId?: string;
  filePath: string;
  filename?: string;
  title?: string;
  initialComment?: string;
}): Promise<{ status: "file_uploaded"; channelId: string; filename: string }> {
  const channelId = requireString(args.channelId, "channelId");
  const filePath = requireString(args.filePath, "filePath");
  const token = getSlackBotToken(channelId, typeof args.threadId === "string" ? args.threadId : undefined);
  if (!token) {
    throw new Error("No Slack bot token available for channel");
  }
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
 * Fetch the messages of a Slack thread. Powers `ode messages get`.
 */
export async function collectSlackRootAndLatestMessages(params: {
  threadId: string;
  limit: number;
  fetchPage: (cursor: string | undefined, pageLimit: number) => Promise<{
    messages?: Array<Record<string, unknown>>;
    response_metadata?: { next_cursor?: string };
  }>;
}): Promise<Array<Record<string, unknown>>> {
  const latestReplies: Array<Record<string, unknown>> = [];
  let rootMessage: Record<string, unknown> | undefined;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  do {
    const data = await params.fetchPage(cursor, params.limit === 1 ? 1 : 200);
    for (const message of data.messages ?? []) {
      if (message.ts === params.threadId) {
        rootMessage = message;
        continue;
      }
      latestReplies.push(message);
      if (latestReplies.length > Math.max(0, params.limit - 1)) {
        latestReplies.shift();
      }
    }
    if (params.limit === 1) break;
    const nextCursor = data.response_metadata?.next_cursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return rootMessage ? [rootMessage, ...latestReplies] : latestReplies;
}

export async function getSlackThreadMessages(args: {
  channelId: string;
  threadId: string;
  limit?: number;
  downloadAttachments?: boolean;
}): Promise<{ messages: ThreadMessage[] }> {
  const channelId = requireString(args.channelId, "channelId");
  const threadId = requireString(args.threadId, "threadId");
  const token = getSlackBotToken(channelId, threadId);
  if (!token) {
    throw new Error("No Slack bot token available for channel");
  }
  const client = getApp().client;
  const limit = normalizeThreadMessageLimit(args.limit);
  // Slack returns the earliest items first. Walk cursor pages and retain only
  // a small ring buffer so long threads still yield their latest replies.
  const rawMessages = await collectSlackRootAndLatestMessages({
    threadId,
    limit,
    fetchPage: async (cursor, pageLimit) => {
      const data = await client.conversations.replies({
        channel: channelId,
        ts: threadId,
        limit: pageLimit,
        cursor,
        token,
      });
      return data as {
        messages?: Array<Record<string, unknown>>;
        response_metadata?: { next_cursor?: string };
      };
    },
  });
  const messages = await Promise.all(rawMessages.map(async (message, index): Promise<ThreadMessage> => {
    const id = typeof message.ts === "string" ? message.ts : `message-${index + 1}`;
    const files = Array.isArray(message.files) ? message.files : [];
    const sources = files.flatMap((file): AttachmentSource[] => {
      if (!file || typeof file !== "object") return [];
      const record = file as Record<string, unknown>;
      const url = typeof record.url_private_download === "string"
        ? record.url_private_download
        : typeof record.url_private === "string"
          ? record.url_private
          : "";
      if (!url) return [];
      return [{
        id: typeof record.id === "string" ? record.id : undefined,
        filename: typeof record.name === "string" ? record.name : undefined,
        mimeType: typeof record.mimetype === "string" ? record.mimetype : undefined,
        size: typeof record.size === "number" ? record.size : undefined,
        url,
        headers: { Authorization: `Bearer ${token}` },
      }];
    });
    const botProfile = message.bot_profile && typeof message.bot_profile === "object"
      ? message.bot_profile as Record<string, unknown>
      : undefined;
    return {
      id,
      timestamp: typeof message.ts === "string" ? message.ts : undefined,
      author: {
        id: typeof message.user === "string"
          ? message.user
          : typeof message.bot_id === "string"
            ? message.bot_id
            : undefined,
        name: typeof message.username === "string"
          ? message.username
          : typeof botProfile?.name === "string"
            ? botProfile.name
            : undefined,
        isBot: typeof message.bot_id === "string" || message.subtype === "bot_message",
      },
      text: typeof message.text === "string" ? message.text : "",
      attachments: await materializeThreadMessageAttachments({
        platform: "slack",
        messageId: id,
        sources,
        download: args.downloadAttachments === true,
      }),
    };
  }));
  return { messages };
}

/**
 * Add a reaction to a Slack message. Powers `ode reaction add`.
 */
export async function addSlackReaction(args: {
  channelId: string;
  messageId: string;
  emoji: string;
  threadId?: string;
}): Promise<{ status: "reaction_added" }> {
  const channelId = requireString(args.channelId, "channelId");
  const messageId = requireString(args.messageId, "messageId");
  const emoji = requireString(args.emoji, "emoji");
  const name = normalizeSlackEmojiName(emoji);
  const token = getSlackBotToken(channelId, args.threadId);
  if (!token) {
    throw new Error("No Slack bot token available for channel");
  }
  await slackApiCall("reactions.add", {
    channel: channelId,
    timestamp: messageId,
    name,
  }, token);
  return { status: "reaction_added" };
}
