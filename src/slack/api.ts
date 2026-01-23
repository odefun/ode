import { basename } from "path";
import { loadEnv } from "../config";
import { log } from "../logger";
import { getApp, getChannelBotToken } from "./client";

type SlackActionName =
  | "get_thread_messages"
  | "ask_user"
  | "add_reaction"
  | "get_user_info"
  | "post_message"
  | "upload_file";

type SlackActionRequest = {
  action: SlackActionName;
  channelId: string;
  threadId?: string;
  messageId?: string;
  text?: string;
  emoji?: string;
  question?: string;
  options?: string[];
  limit?: number;
  filePath?: string;
  filename?: string;
  title?: string;
  initialComment?: string;
  userId?: string;
};

type SlackApiResponse = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

let slackApiServer: ReturnType<typeof Bun.serve> | undefined;

function jsonResponse(status: number, payload: SlackApiResponse): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAuthorized(request: Request): boolean {
  const env = loadEnv();
  const token = env.ODE_ACTION_API_TOKEN;
  if (!token) return true;
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${token}`;
}

function requireString(value: unknown, label: string): string {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireChannelToken(channelId: string): string {
  const token = getChannelBotToken(channelId);
  if (!token) {
    throw new Error("No Slack bot token available for channel");
  }
  return token;
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

async function handleSlackAction(payload: SlackActionRequest): Promise<unknown> {
  const channelId = requireString(payload.channelId, "channelId");
  const token = requireChannelToken(channelId);
  const client = getApp().client;

  switch (payload.action) {
    case "get_thread_messages": {
      const threadId = requireString(payload.threadId, "threadId");
      const data = await client.conversations.replies({
        channel: channelId,
        ts: threadId,
        limit: payload.limit ?? 20,
        token,
      });
      return { messages: (data as any).messages ?? [] };
    }

    case "ask_user": {
      const threadId = requireString(payload.threadId, "threadId");
      const question = requireString(payload.question, "question");
      const options = payload.options;
      if (!Array.isArray(options) || options.length < 2 || options.length > 5) {
        throw new Error("options must have 2-5 items");
      }

      const buttons = options.map((opt, i) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: opt },
        action_id: `user_choice_${i}`,
        value: opt,
      }));

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadId,
        text: question,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: question },
          },
          {
            type: "actions",
            block_id: "user_choice",
            elements: buttons,
          },
        ],
        token,
      });

      return { status: "question_posted" };
    }

    case "add_reaction": {
      const messageId = requireString(payload.messageId, "messageId");
      const emoji = requireString(payload.emoji, "emoji");
      await client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: emoji.replace(/:/g, ""),
        token,
      });
      return { status: "reaction_added" };
    }

    case "get_user_info": {
      const userId = requireString(payload.userId, "userId");
      const data = await client.users.info({ user: userId, token });
      return data;
    }

    case "post_message": {
      const text = requireString(payload.text, "text");
      const result = await client.chat.postMessage({
        channel: channelId,
        thread_ts: payload.threadId,
        text,
        token,
      });
      return { ts: result.ts, text };
    }

    case "upload_file": {
      const filePath = requireString(payload.filePath, "filePath");
      const filename = payload.filename || basename(filePath);
      await slackFileUpload({
        channelId,
        threadId: payload.threadId,
        filename,
        title: payload.title,
        initialComment: payload.initialComment,
        token,
      }, filePath);
      return { status: "file_uploaded" };
    }

    default:
      throw new Error(`Unknown action: ${payload.action}`);
  }
}

export function startSlackApiServer(): void {
  if (slackApiServer) return;
  const env = loadEnv();
  const url = new URL(env.ODE_ACTION_API_URL);
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;

  slackApiServer = Bun.serve({
    port,
    hostname: url.hostname,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!isAuthorized(request)) {
        return jsonResponse(401, { ok: false, error: "Unauthorized" });
      }

      const allowedPaths = new Set(["/action", "/slack/action"]);
      if (request.method !== "POST" || !allowedPaths.has(url.pathname)) {
        return jsonResponse(404, { ok: false, error: "Not Found" });
      }

      let payload: SlackActionRequest;
      try {
        payload = await request.json() as SlackActionRequest;
      } catch (err) {
        return jsonResponse(400, { ok: false, error: "Invalid JSON payload" });
      }

      if (!payload || typeof payload !== "object") {
        return jsonResponse(400, { ok: false, error: "Invalid payload" });
      }

      try {
        const result = await handleSlackAction(payload);
        return jsonResponse(200, { ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResponse(400, { ok: false, error: message });
      }
    },
  });

  log.info("Slack API server started", {
    host: url.hostname,
    port,
  });
}

export function stopSlackApiServer(): void {
  if (!slackApiServer) return;
  slackApiServer.stop();
  slackApiServer = undefined;
  log.info("Slack API server stopped");
}
