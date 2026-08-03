import {
  materializeThreadMessageAttachments,
  normalizeThreadMessageLimit,
  type ThreadMessage,
} from "@/ims/shared/thread-messages";
import { parseLarkAttachmentSources, parseLarkText } from "./message-content";

// ---------------------------------------------------------------------------
// Lark IM helper module.
//
// The legacy `/api/action` dispatcher (`handleLarkActionPayload`) has been
// retired. This module now only exposes the helpers that back the dedicated
// `ode send file` / `ode messages get` / `ode reaction add` CLIs.
//
// Internal helpers (`larkRequest`, `getTenantAccessToken`, `postTextMessage`,
// `threadMessageCache`) stay as implementation details.
// ---------------------------------------------------------------------------

type LarkResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

const threadMessageCache = new Map<string, string[]>();

function rememberThreadMessage(threadId: string, messageId: string): void {
  if (!threadId || !messageId) return;
  const existing = threadMessageCache.get(threadId) ?? [];
  if (!existing.includes(messageId)) {
    existing.push(messageId);
    threadMessageCache.set(threadId, existing.slice(-50));
  }
}

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

const LARK_REACTIONS: Record<string, string> = {
  thumbsup: "THUMBSUP",
  eyes: "EYES",
  ok_hand: "OK_HAND",
};

function normalizeLarkReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (!trimmed) throw new Error("emoji is required");
  const stripped = trimmed.replace(/^:+|:+$/g, "").replace(/:/g, "");
  const normalized = REACTION_ALIASES[stripped] ?? stripped;
  const resolved = LARK_REACTIONS[normalized] ?? normalized;
  if (!["THUMBSUP", "EYES", "OK_HAND"].includes(resolved)) {
    throw new Error("emoji must be one of: thumbsup, eyes, ok_hand");
  }
  return resolved;
}

async function larkRequest<T>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  token: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://open.feishu.cn${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorPayload = await response.json() as { code?: number; msg?: string };
      if (typeof errorPayload.msg === "string" && errorPayload.msg.trim().length > 0) {
        detail = `: ${errorPayload.msg}`;
      } else if (typeof errorPayload.code === "number") {
        detail = `: code ${errorPayload.code}`;
      }
    } catch {
      // ignore malformed error body
    }
    throw new Error(`Lark API ${response.status} ${response.statusText}${detail}`);
  }

  const payload = await response.json() as LarkResponse<T>;
  if ((payload.code ?? -1) !== 0) {
    throw new Error(payload.msg || "Lark API error");
  }
  return (payload.data ?? ({} as T)) as T;
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!response.ok) {
    throw new Error(`Lark token API ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if ((payload.code ?? -1) !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Failed to get Lark tenant access token");
  }
  return payload.tenant_access_token;
}

function buildLarkPostContent(text: string): Record<string, unknown> {
  const block = [{ tag: "md", text }];
  return {
    zh_cn: {
      title: "",
      content: [block],
    },
    en_us: {
      title: "",
      content: [block],
    },
  };
}

async function postTextMessage(params: {
  token: string;
  channelId: string;
  text: string;
  threadId?: string;
}): Promise<{ messageId: string; channelId: string }> {
  const content = buildLarkPostContent(params.text);
  const data = params.threadId
    ? await larkRequest<{ message_id?: string }>(
      "POST",
      `/open-apis/im/v1/messages/${encodeURIComponent(params.threadId)}/reply`,
      params.token,
      {
        msg_type: "post",
        content: JSON.stringify(content),
        reply_in_thread: true,
      }
    )
    : await larkRequest<{ message_id?: string }>(
      "POST",
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      params.token,
      {
        receive_id: params.channelId,
        msg_type: "post",
        content: JSON.stringify(content),
      }
    );
  return {
    messageId: data.message_id ?? "",
    channelId: params.channelId,
  };
}

async function getMessageById(token: string, messageId: string): Promise<Record<string, unknown> | null> {
  const data = await larkRequest<{ items?: Array<Record<string, unknown>> }>(
    "GET",
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    token
  );
  const item = Array.isArray(data.items) ? data.items[0] : null;
  return item ?? null;
}

/**
 * Upload a file to a Lark chat. Internally fetches a tenant access token from
 * the provided app credentials, pushes the bytes through `/open-apis/im/v1/files`,
 * and then posts a `file` message into the channel (or thread reply). Powers
 * the `ode send file` CLI on Lark-configured channels.
 */
export async function uploadLarkFile(args: {
  appId: string;
  appSecret: string;
  channelId: string;
  threadId?: string;
  filePath: string;
  filename?: string;
  initialComment?: string;
}): Promise<{
  status: "file_uploaded";
  messageId: string;
  channelId: string;
  fileKey: string;
}> {
  const appId = args.appId.trim();
  const appSecret = args.appSecret.trim();
  if (!appId || !appSecret) {
    throw new Error("Lark app credentials missing");
  }
  const channelId = requireString(args.channelId, "channelId");
  const filePath = requireString(args.filePath, "filePath");

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const filename = args.filename?.trim() || file.name || "upload.bin";
  const formData = new FormData();
  formData.append("file_name", filename);
  formData.append("file_type", "stream");
  formData.append("file", file, filename);

  const uploadResponse = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Lark file upload API ${uploadResponse.status} ${uploadResponse.statusText}`);
  }
  const uploadPayload = await uploadResponse.json() as {
    code?: number;
    msg?: string;
    data?: { file_key?: string };
  };
  if ((uploadPayload.code ?? -1) !== 0 || !uploadPayload.data?.file_key) {
    throw new Error(uploadPayload.msg || "Failed to upload file to Lark");
  }

  const threadId = args.threadId?.trim();
  if (args.initialComment?.trim()) {
    const comment = await postTextMessage({
      token,
      channelId,
      text: args.initialComment.trim(),
      threadId,
    });
    if (threadId && comment.messageId) {
      rememberThreadMessage(threadId, comment.messageId);
    }
  }

  const message = await larkRequest<{ message_id?: string }>(
    "POST",
    threadId
      ? `/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`
      : "/open-apis/im/v1/messages?receive_id_type=chat_id",
    token,
    threadId
      ? {
        msg_type: "file",
        content: JSON.stringify({ file_key: uploadPayload.data.file_key }),
        reply_in_thread: true,
      }
      : {
        receive_id: channelId,
        msg_type: "file",
        content: JSON.stringify({ file_key: uploadPayload.data.file_key }),
      }
  );

  if (threadId && message.message_id) {
    rememberThreadMessage(threadId, message.message_id);
  }

  return {
    status: "file_uploaded",
    messageId: message.message_id ?? "",
    channelId,
    fileKey: uploadPayload.data.file_key,
  };
}

/**
 * Fetch the messages of a Lark thread. Powers `ode messages get`.
 *
 * Lark doesn't expose a direct "thread replies" API like Slack; this helper
 * reproduces the same filtering strategy used by the retired `handleLarkAction`
 * — list recent channel messages and keep the ones whose `thread_id` /
 * `root_id` / `parent_id` matches the requested thread, falling back to a
 * per-message lookup using the local `threadMessageCache` hint.
 */
export async function getLarkThreadMessages(args: {
  appId: string;
  appSecret: string;
  channelId?: string;
  threadId: string;
  limit?: number;
  downloadAttachments?: boolean;
}): Promise<{ messages: ThreadMessage[] }> {
  const appId = args.appId.trim();
  const appSecret = args.appSecret.trim();
  if (!appId || !appSecret) {
    throw new Error("Lark app credentials missing");
  }
  const threadId = requireString(args.threadId, "threadId");
  const channelId = args.channelId?.trim();
  const limit = normalizeThreadMessageLimit(args.limit);
  const token = await getTenantAccessToken(appId, appSecret);

  const normalizeMessages = async (items: Array<Record<string, unknown>>): Promise<ThreadMessage[]> => {
    const ordered = [...items].sort((left, right) => {
      const leftTime = Number(left.create_time ?? 0);
      const rightTime = Number(right.create_time ?? 0);
      return leftTime - rightTime;
    });
    return Promise.all(ordered.map(async (item, index): Promise<ThreadMessage> => {
      const id = typeof item.message_id === "string" ? item.message_id : `message-${index + 1}`;
      const body = item.body && typeof item.body === "object"
        ? item.body as Record<string, unknown>
        : undefined;
      const content = typeof body?.content === "string"
        ? body.content
        : typeof item.content === "string"
          ? item.content
          : undefined;
      const messageType = typeof item.msg_type === "string"
        ? item.msg_type
        : typeof item.message_type === "string"
          ? item.message_type
          : "";
      const sender = item.sender && typeof item.sender === "object"
        ? item.sender as Record<string, unknown>
        : undefined;
      const sources = parseLarkAttachmentSources({
        messageType,
        content,
        messageId: id,
        token,
      });
      return {
        id,
        timestamp: typeof item.create_time === "string" ? item.create_time : undefined,
        author: sender
          ? {
              id: typeof sender.id === "string" ? sender.id : undefined,
              name: typeof sender.name === "string" ? sender.name : undefined,
              isBot: sender.sender_type === "app",
            }
          : undefined,
        text: parseLarkText(content),
        attachments: await materializeThreadMessageAttachments({
          platform: "lark",
          messageId: id,
          sources,
          download: args.downloadAttachments === true,
        }),
      };
    }));
  };

  let threadConversationId = "";
  let rootMessage: Record<string, unknown> | null = null;
  try {
    rootMessage = await getMessageById(token, threadId);
    threadConversationId = typeof rootMessage?.thread_id === "string" ? rootMessage.thread_id : "";
  } catch {
    threadConversationId = "";
  }

  const withRootAndLatest = (items: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const unique = items.filter((item, index, all) => {
      const id = typeof item.message_id === "string" ? item.message_id : "";
      return id && all.findIndex((candidate) => candidate.message_id === id) === index;
    });
    const latestReplies = unique
      .filter((item) => item.message_id !== threadId)
      .sort((left, right) => Number(right.create_time ?? 0) - Number(left.create_time ?? 0))
      .slice(0, Math.max(0, limit - 1));
    return rootMessage ? [rootMessage, ...latestReplies] : latestReplies.slice(0, limit);
  };

  if (threadConversationId) {
    const data = await larkRequest<{
      items?: Array<Record<string, unknown>>;
    }>(
      "GET",
      `/open-apis/im/v1/messages?container_id_type=thread&container_id=${encodeURIComponent(threadConversationId)}&sort_type=ByCreateTimeDesc&page_size=${limit}`,
      token,
    );
    const messages = withRootAndLatest(data.items ?? []);
    if (messages.length > 0) {
      return { messages: await normalizeMessages(messages) };
    }
  }

  if (channelId) {
    const data = await larkRequest<{
      items?: Array<Record<string, unknown>>;
    }>(
      "GET",
      `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(channelId)}&sort_type=ByCreateTimeDesc&page_size=50`,
      token
    );
    const matchingMessages = (data.items ?? [])
      .filter((item) => {
        const messageId = typeof item.message_id === "string" ? item.message_id : "";
        const rootId = typeof item.root_id === "string" ? item.root_id : "";
        const parentId = typeof item.parent_id === "string" ? item.parent_id : "";
        const itemThreadId = typeof item.thread_id === "string" ? item.thread_id : "";
        if (threadConversationId) {
          return itemThreadId === threadConversationId;
        }
        return messageId === threadId || rootId === threadId || parentId === threadId;
      });
    const messages = withRootAndLatest(matchingMessages);
    if (messages.length > 0) {
      return { messages: await normalizeMessages(messages) };
    }
  }

  const cachedIds = threadMessageCache.get(threadId) ?? [];
  const uniqueIds = [threadId, ...cachedIds].filter((id, index, arr) => arr.indexOf(id) === index);
  const messages: Array<Record<string, unknown>> = [];
  for (const id of uniqueIds.slice(-limit)) {
    try {
      const item = await getMessageById(token, id);
      if (item) messages.push(item);
    } catch {
      // ignore single message lookup failures
    }
  }
  return { messages: await normalizeMessages(messages) };
}

/**
 * Add a reaction to a Lark message. Powers `ode reaction add`.
 */
export async function addLarkReaction(args: {
  appId: string;
  appSecret: string;
  messageId: string;
  emoji: string;
}): Promise<{ status: "reaction_added"; messageId: string }> {
  const appId = args.appId.trim();
  const appSecret = args.appSecret.trim();
  if (!appId || !appSecret) {
    throw new Error("Lark app credentials missing");
  }
  const messageId = requireString(args.messageId, "messageId");
  const emoji = normalizeLarkReactionEmoji(requireString(args.emoji, "emoji"));
  const token = await getTenantAccessToken(appId, appSecret);
  await larkRequest<Record<string, unknown>>(
    "POST",
    `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
    token,
    {
      reaction_type: {
        emoji_type: emoji,
      },
    }
  );
  return {
    status: "reaction_added",
    messageId,
  };
}
