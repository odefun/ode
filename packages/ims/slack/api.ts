import { basename } from "path";
import { getApp, getSlackBotToken } from "./client";
import { hasSimpleOptions } from "@/core/runtime/helpers";
import type { StatusStreamChunk } from "@/core/types";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";

// ---------------------------------------------------------------------------
// Slack IM helper module.
//
// Historically this file hosted a generic `/api/action` dispatcher
// (`handleSlackActionPayload`) that agents called via bash+curl. That
// mechanism has been retired in favour of dedicated `ode <verb>` CLIs
// (`ode send file`, `ode messages get`, `ode reaction add`, etc.), so this
// module now only exposes:
//
//   - `postSlackQuestion`   – used by the core runtime to render SDK-emitted
//                             question events in Slack.
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
 * If Slack rejects the Block Kit payload (e.g. `invalid_blocks` because a
 * button label still exceeds Slack's 75-char hard limit, or some other
 * schema error), we catch the error, log it, and fall back to the same
 * plain-text format so the user still sees the question.
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

  // Synthetic placeholder thread ids (`task:` / `cron-job:` / `cron:`) are
  // not valid Slack `thread_ts` values; if the runtime hands us one during
  // a task/cron run, fall back to posting at the top of the channel rather
  // than letting Slack reject the call with `invalid_thread_ts`.
  const threadIsSynthetic = isSyntheticOwner(threadId);
  const threadField = threadIsSynthetic ? {} : { thread_ts: threadId };

  const postPlainText = async (): Promise<string | undefined> => {
    const optionText = options.length > 0 ? `\nOptions: ${options.join(" / ")}` : "";
    const result = await client.chat.postMessage({
      channel: channelId,
      ...threadField,
      text: `${questionText}${optionText}`,
      token,
    });
    return result.ts ?? undefined;
  };

  if (hasSimpleOptions(options)) {
    const buttons = options.map((opt, i) => ({
      type: "button" as const,
      text: { type: "plain_text" as const, text: opt },
      action_id: `user_choice_${i}`,
      value: opt,
    }));

    try {
      const result = await client.chat.postMessage({
        channel: channelId,
        ...threadField,
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
    } catch (err) {
      // Slack rejected the Block Kit payload (invalid_blocks, etc.). Log the
      // underlying reason and fall back to the plain-text format so the user
      // still sees the question rather than silently losing it.
      const data = (err as { data?: { error?: string; errors?: string[] } } | undefined)?.data;
      const slackError = data?.error ?? (err as Error | undefined)?.message ?? "unknown";
      const details = Array.isArray(data?.errors) ? ` (${data?.errors?.join("; ")})` : "";
      console.warn(`[slack] postSlackQuestion buttons rejected (${slackError})${details}; falling back to plain text`);
      return postPlainText();
    }
  }

  return postPlainText();
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
export async function getSlackThreadMessages(args: {
  channelId: string;
  threadId: string;
  limit?: number;
}): Promise<{ messages: unknown[] }> {
  const channelId = requireString(args.channelId, "channelId");
  const threadId = requireString(args.threadId, "threadId");
  const token = getSlackBotToken(channelId, threadId);
  if (!token) {
    throw new Error("No Slack bot token available for channel");
  }
  const client = getApp().client;
  const data = await client.conversations.replies({
    channel: channelId,
    ts: threadId,
    limit: args.limit ?? 20,
    token,
  });
  return { messages: (data as { messages?: unknown[] }).messages ?? [] };
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

// ---------------------------------------------------------------------------
// Streaming status (chat.startStream / chat.appendStream / chat.stopStream)
//
// Slack's text-streaming API (Feb 2026, expanded Apr 2026) is purpose-built
// for AI agents rendering live progress as `task_card` / `plan` blocks.
// We expose three thin helpers used by the Slack IMAdapter when the
// Slack workspace status mode is configured for AI cards.
//
// Empirical quirks (the docs lie a bit):
//   - Channel (non-DM) streams REQUIRE `recipient_user_id` +
//     `recipient_team_id`. Omitting them yields `missing_recipient_team_id`.
//   - A stream is locked to either "text" mode or "chunks" mode at
//     `startStream` time. After that, you cannot mix `markdown_text` and
//     `chunks` on `appendStream` (returns
//     `cannot_provide_both_markdown_text_and_chunks`) nor switch modes
//     (returns `streaming_mode_mismatch`). We always use chunks mode.
//   - To start in chunks mode you MUST pass `chunks` on `startStream` (a
//     `plan_update` is a natural opener); a bare/empty `markdown_text` locks
//     you into text mode forever.
//   - Per-chunk title/details/output cap = 256 chars (Slack-side).
//   - `task_display_mode: "plan"` groups task_updates inside a single plan
//     block; `"individual"` (default) renders each as a standalone card.
// ---------------------------------------------------------------------------

const STREAM_CHUNK_MAX_CHARS = 256;

function truncateStreamField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= STREAM_CHUNK_MAX_CHARS) return value;
  return value.slice(0, STREAM_CHUNK_MAX_CHARS - 1) + "…";
}

function serializeStreamChunk(chunk: StatusStreamChunk): Record<string, unknown> {
  if (chunk.type === "task_update") {
    return {
      type: "task_update",
      id: chunk.id,
      title: truncateStreamField(chunk.title) ?? "",
      status: chunk.status,
      ...(chunk.details ? { details: truncateStreamField(chunk.details) } : {}),
      ...(chunk.output ? { output: truncateStreamField(chunk.output) } : {}),
      ...(chunk.sources && chunk.sources.length > 0 ? { sources: chunk.sources } : {}),
    };
  }
  if (chunk.type === "plan_update") {
    return { type: "plan_update", title: truncateStreamField(chunk.title) ?? "" };
  }
  // markdown_text — only valid in text-mode streams; the kernel currently
  // never emits these, but we serialize defensively.
  return { type: "markdown_text", text: chunk.text };
}

/**
 * Start a Slack streaming status message in chunks mode.
 *
 * Channel (non-DM) streams require recipient identification; we resolve the
 * team id via `auth.test` on the bot token and accept the requesting user id
 * from the caller. `task_display_mode: "plan"` is what gives us the unified
 * "thinking steps" card with a checklist of task_card rows.
 *
 * Seeds the stream with a single `plan_update` chunk (using `seedPlanTitle`)
 * so subsequent `appendSlackStream` calls don't trip `streaming_mode_mismatch`.
 *
 * `token` is required: the adapter resolves the right bot token (processor-
 * scoped or channel-scoped) at the call site so append/stop can use the
 * same identity by passing it explicitly. Mixing tokens within a single
 * stream lifecycle causes Slack to reject later calls.
 */
export async function startSlackStream(args: {
  channelId: string;
  threadId: string;
  recipientUserId: string;
  recipientTeamId: string;
  seedPlanTitle?: string;
  token: string;
}): Promise<string | undefined> {
  const channelId = requireString(args.channelId, "channelId");
  const threadId = requireString(args.threadId, "threadId");
  const recipientUserId = requireString(args.recipientUserId, "recipientUserId");
  const recipientTeamId = requireString(args.recipientTeamId, "recipientTeamId");
  const token = requireString(args.token, "token");
  const client = getApp().client;
  const result = await client.apiCall("chat.startStream", {
    channel: channelId,
    thread_ts: threadId,
    task_display_mode: "plan",
    recipient_user_id: recipientUserId,
    recipient_team_id: recipientTeamId,
    chunks: [{ type: "plan_update", title: truncateStreamField(args.seedPlanTitle ?? "Working") }],
    token,
  }) as { ts?: string };
  return result.ts ?? undefined;
}

/**
 * Append chunks to a running chunks-mode Slack stream message. Does NOT
 * accept a markdown_text body — the API rejects messages that mix the two
 * with `cannot_provide_both_markdown_text_and_chunks`.
 *
 * `token` must be the same bot token that started the stream — using a
 * different workspace's token (e.g. when multiple Slack workspaces are
 * installed) causes Slack to silently reject the append.
 */
export async function appendSlackStream(args: {
  channelId: string;
  messageTs: string;
  chunks: StatusStreamChunk[];
  token: string;
}): Promise<void> {
  const channelId = requireString(args.channelId, "channelId");
  const messageTs = requireString(args.messageTs, "messageTs");
  const token = requireString(args.token, "token");
  if (!Array.isArray(args.chunks) || args.chunks.length === 0) return;
  const client = getApp().client;
  await client.apiCall("chat.appendStream", {
    channel: channelId,
    ts: messageTs,
    chunks: args.chunks.map(serializeStreamChunk),
    token,
  });
}

/**
 * Stop a chunks-mode stream. Cannot pass markdown_text here either — the
 * stream is mode-locked. If you need a final summary line, append a final
 * `plan_update` chunk before calling stop. `token` must match the start
 * call's token (see `appendSlackStream`).
 */
export async function stopSlackStream(args: {
  channelId: string;
  messageTs: string;
  token: string;
}): Promise<void> {
  const channelId = requireString(args.channelId, "channelId");
  const messageTs = requireString(args.messageTs, "messageTs");
  const token = requireString(args.token, "token");
  const client = getApp().client;
  await client.apiCall("chat.stopStream", {
    channel: channelId,
    ts: messageTs,
    token,
  });
}
