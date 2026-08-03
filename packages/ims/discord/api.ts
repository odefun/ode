import { basename } from "path";
import type { AttachmentSource } from "@/ims/shared/attachment-store";
import {
  materializeThreadMessageAttachments,
  normalizeThreadMessageLimit,
  type ThreadMessage,
} from "@/ims/shared/thread-messages";

// ---------------------------------------------------------------------------
// Discord IM helper module.
//
// The legacy `/api/action` dispatcher (`handleDiscordActionPayload`) has been
// retired. This module now only exposes the helpers that back the dedicated
// `ode send file` / `ode messages get` / `ode reaction add` CLIs.
// ---------------------------------------------------------------------------

function requireString(value: unknown, label: string): string {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  return value;
}

const REACTION_ALIASES: Record<string, string> = {
  thumbup: "thumbsup",
  ok: "ok_hand",
};

const DISCORD_REACTIONS: Record<string, string> = {
  thumbsup: "👍",
  eyes: "👀",
  ok_hand: "👌",
};

function normalizeDiscordEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed) {
    throw new Error("emoji is required");
  }
  const stripped = trimmed.replace(/^:+|:+$/g, "").replace(/:/g, "");
  const normalized = REACTION_ALIASES[stripped] ?? stripped;
  const resolved = DISCORD_REACTIONS[normalized] ?? normalized;
  if (!["👍", "👀", "👌"].includes(resolved)) {
    throw new Error("emoji must be one of: thumbsup, eyes, ok_hand");
  }
  return resolved;
}

async function discordApiCall<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = await response.json() as { message?: string; code?: number };
      detail = errorBody.message ? `: ${errorBody.message}` : "";
    } catch {
      // noop
    }
    throw new Error(`Discord API ${response.status} ${response.statusText}${detail}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function discordMultipartCall<T>(
  token: string,
  method: "POST",
  path: string,
  formData: FormData
): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorBody = await response.json() as { message?: string; code?: number };
      detail = errorBody.message ? `: ${errorBody.message}` : "";
    } catch {
      // noop
    }
    throw new Error(`Discord API ${response.status} ${response.statusText}${detail}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

/**
 * Upload a file to a Discord channel via the standard multipart message
 * endpoint. Powers the `ode send file` CLI on Discord-configured channels.
 */
export async function uploadDiscordFile(args: {
  botToken: string;
  channelId: string;
  filePath: string;
  filename?: string;
  initialComment?: string;
}): Promise<{
  status: "file_uploaded";
  messageId: string;
  channelId: string;
  attachments: Array<{ id: string; filename: string; url: string }>;
}> {
  const token = args.botToken.trim();
  if (!token) {
    throw new Error("Discord bot token missing");
  }
  const channelId = requireString(args.channelId, "channelId");
  const filePath = requireString(args.filePath, "filePath");
  const filename = args.filename?.trim() || basename(filePath);
  const initialComment = args.initialComment?.trim();

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const formData = new FormData();
  formData.append("files[0]", file, filename);
  formData.append("payload_json", JSON.stringify({
    content: initialComment && initialComment.length > 0 ? initialComment : undefined,
  }));

  const message = await discordMultipartCall<{
    id: string;
    channel_id: string;
    attachments?: Array<{ id: string; filename: string; url: string }>;
  }>(
    token,
    "POST",
    `/channels/${channelId}/messages`,
    formData
  );

  return {
    status: "file_uploaded",
    messageId: message.id,
    channelId: message.channel_id,
    attachments: message.attachments ?? [],
  };
}

/**
 * Fetch recent messages from a Discord channel / thread. Powers
 * `ode messages get` on Discord-configured channels. Discord does not have
 * a native Slack-style "thread"; we resolve `threadId` as a channel id (which
 * also matches Discord's thread channels) and fall back to the provided
 * `channelId` when `threadId` is absent.
 */
export async function getDiscordThreadMessages(args: {
  botToken: string;
  channelId: string;
  threadId?: string;
  limit?: number;
  downloadAttachments?: boolean;
}): Promise<{ messages: ThreadMessage[] }> {
  const token = args.botToken.trim();
  if (!token) {
    throw new Error("Discord bot token missing");
  }
  const channelOrThread = args.threadId?.trim() || args.channelId.trim();
  if (!channelOrThread) {
    throw new Error("channelId or threadId is required");
  }
  const limit = normalizeThreadMessageLimit(args.limit);
  const rawMessages = await discordApiCall<Array<Record<string, unknown>>>(
    token,
    "GET",
    `/channels/${channelOrThread}/messages?limit=${limit}`
  );
  const messages = await Promise.all([...rawMessages].reverse().map(async (message, index): Promise<ThreadMessage> => {
    const id = typeof message.id === "string" ? message.id : `message-${index + 1}`;
    const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
    const sources = rawAttachments.flatMap((attachment): AttachmentSource[] => {
      if (!attachment || typeof attachment !== "object") return [];
      const record = attachment as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      if (!url) return [];
      return [{
        id: typeof record.id === "string" ? record.id : undefined,
        filename: typeof record.filename === "string" ? record.filename : undefined,
        mimeType: typeof record.content_type === "string" ? record.content_type : undefined,
        size: typeof record.size === "number" ? record.size : undefined,
        url,
      }];
    });
    const author = message.author && typeof message.author === "object"
      ? message.author as Record<string, unknown>
      : undefined;
    return {
      id,
      timestamp: typeof message.timestamp === "string" ? message.timestamp : undefined,
      author: author
        ? {
            id: typeof author.id === "string" ? author.id : undefined,
            name: typeof author.global_name === "string"
              ? author.global_name
              : typeof author.username === "string"
                ? author.username
                : undefined,
            isBot: author.bot === true,
          }
        : undefined,
      text: typeof message.content === "string" ? message.content : "",
      attachments: await materializeThreadMessageAttachments({
        platform: "discord",
        messageId: id,
        sources,
        download: args.downloadAttachments === true,
      }),
    };
  }));
  return { messages };
}

/**
 * Add a reaction to a Discord message. Powers `ode reaction add` on Discord.
 */
export async function addDiscordReaction(args: {
  botToken: string;
  channelId: string;
  messageId: string;
  emoji: string;
}): Promise<{ status: "reaction_added" }> {
  const token = args.botToken.trim();
  if (!token) {
    throw new Error("Discord bot token missing");
  }
  const channelId = requireString(args.channelId, "channelId");
  const messageId = requireString(args.messageId, "messageId");
  const emoji = normalizeDiscordEmoji(requireString(args.emoji, "emoji"));

  await discordApiCall<void>(
    token,
    "PUT",
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
  );

  return { status: "reaction_added" };
}
