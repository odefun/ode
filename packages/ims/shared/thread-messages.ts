import type { InboundAttachment, InboundAttachmentKind } from "@/shared/agent-protocol";
import {
  downloadAttachments as downloadToAttachmentStore,
  type AttachmentSource,
} from "./attachment-store";

export const DEFAULT_THREAD_MESSAGE_LIMIT = 20;
export const MAX_THREAD_MESSAGE_LIMIT = 50;
export const MAX_THREAD_MESSAGES_BYTES = 64 * 1024;
export const MAX_THREAD_MESSAGE_TEXT_BYTES = 8 * 1024;

export type ThreadMessagePlatform = InboundAttachment["sourcePlatform"];

export type ThreadMessageAttachment = Readonly<{
  id?: string;
  filename: string;
  mimeType?: string;
  size?: number;
  kind: InboundAttachmentKind;
  localPath?: string;
  sha256?: string;
}>;

export type ThreadMessage = Readonly<{
  id: string;
  timestamp?: string;
  author?: Readonly<{
    id?: string;
    name?: string;
    isBot?: boolean;
  }>;
  text: string;
  attachments: readonly ThreadMessageAttachment[];
  textTruncated?: true;
}>;

export type ThreadMessagesResult = Readonly<{
  platform: ThreadMessagePlatform;
  messages: readonly ThreadMessage[];
  meta: Readonly<{
    requestedLimit: number;
    appliedLimit: number;
    maxMessages: number;
    maxBytes: number;
    returnedMessages: number;
    omittedMessages: number;
    truncatedTextMessages: number;
    downloadedAttachments: number;
    downloadAttachments: boolean;
    truncated: boolean;
  }>;
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };

  const suffix = "\n… [truncated]";
  const suffixBytes = byteLength(suffix);
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    value: decoder.decode(bytes.subarray(0, end)) + suffix,
    truncated: true,
  };
}

function boundedString(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return truncateUtf8(value, maxBytes).value;
}

function classifyAttachment(mimeType: string | undefined, filename: string): InboundAttachmentKind {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || /\.(md|txt|json|jsonl|csv|tsv|ya?ml|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|sh)$/i.test(filename)) {
    return "text";
  }
  if (/^(application\/(pdf|json|xml|rtf|msword|vnd\.)|text\/)/.test(mime)) return "document";
  return "binary";
}

function storedAttachmentDescriptor(attachment: InboundAttachment): ThreadMessageAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    localPath: attachment.localPath,
    sha256: attachment.sha256,
  };
}

/** Resolve attachment metadata without leaking remote URLs or auth headers. */
export async function materializeThreadMessageAttachments(params: {
  platform: ThreadMessagePlatform;
  messageId: string;
  sources: readonly AttachmentSource[];
  download: boolean;
}): Promise<ThreadMessageAttachment[]> {
  if (params.sources.length === 0) return [];
  if (params.download) {
    const attachments = await downloadToAttachmentStore({
      platform: params.platform,
      messageId: params.messageId,
      sources: params.sources,
    });
    return attachments.map(storedAttachmentDescriptor);
  }

  return params.sources.map((source, index) => {
    const filename = boundedString(source.filename, 512) ?? `attachment-${index + 1}`;
    const mimeType = boundedString(source.mimeType, 128);
    return {
      id: boundedString(source.id, 256),
      filename,
      mimeType,
      size: typeof source.size === "number" && Number.isFinite(source.size)
        ? source.size
        : undefined,
      kind: classifyAttachment(mimeType, filename),
    };
  });
}

export function normalizeThreadMessageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_THREAD_MESSAGE_LIMIT;
  return Math.min(Math.floor(limit!), MAX_THREAD_MESSAGE_LIMIT);
}

function normalizeMessage(message: ThreadMessage): ThreadMessage {
  const text = truncateUtf8(message.text, MAX_THREAD_MESSAGE_TEXT_BYTES);
  return {
    id: boundedString(message.id, 256) ?? "message",
    timestamp: boundedString(message.timestamp, 128),
    author: message.author
      ? {
          id: boundedString(message.author.id, 256),
          name: boundedString(message.author.name, 512),
          isBot: message.author.isBot,
        }
      : undefined,
    text: text.value,
    attachments: message.attachments.map((attachment, index) => ({
      id: boundedString(attachment.id, 256),
      filename: boundedString(attachment.filename, 512) ?? `attachment-${index + 1}`,
      mimeType: boundedString(attachment.mimeType, 128),
      size: attachment.size,
      kind: attachment.kind,
      localPath: attachment.localPath,
      sha256: attachment.sha256,
    })),
    textTruncated: text.truncated ? true : undefined,
  };
}

function selectWithinCount(messages: readonly ThreadMessage[], limit: number): ThreadMessage[] {
  if (messages.length <= limit) return [...messages];
  if (limit === 1) return [messages[0]!];
  return [messages[0]!, ...messages.slice(-(limit - 1))];
}

/**
 * Applies the public `ode messages get` count and serialized-byte budgets.
 * The first message (normally the root) and the newest replies are retained.
 */
export function buildThreadMessagesResult(params: {
  platform: ThreadMessagePlatform;
  messages: readonly ThreadMessage[];
  requestedLimit?: number;
  downloadAttachments: boolean;
}): ThreadMessagesResult {
  const requestedLimit = Number.isFinite(params.requestedLimit) && (params.requestedLimit ?? 0) > 0
    ? Math.floor(params.requestedLimit!)
    : DEFAULT_THREAD_MESSAGE_LIMIT;
  const appliedLimit = normalizeThreadMessageLimit(params.requestedLimit);
  const selected = selectWithinCount(params.messages, appliedLimit).map(normalizeMessage);
  const omittedByCount = params.messages.length - selected.length;
  const createResult = (messages: readonly ThreadMessage[]): ThreadMessagesResult => {
    const truncatedTextMessages = messages.filter((message) => message.textTruncated).length;
    return {
      platform: params.platform,
      messages,
      meta: {
        requestedLimit,
        appliedLimit,
        maxMessages: MAX_THREAD_MESSAGE_LIMIT,
        maxBytes: MAX_THREAD_MESSAGES_BYTES,
        returnedMessages: messages.length,
        omittedMessages: omittedByCount + selected.length - messages.length,
        truncatedTextMessages,
        downloadedAttachments: messages.reduce(
          (count, message) => count + message.attachments.filter((attachment) => attachment.localPath).length,
          0,
        ),
        downloadAttachments: params.downloadAttachments,
        truncated:
          requestedLimit > appliedLimit
          || omittedByCount + selected.length - messages.length > 0
          || truncatedTextMessages > 0,
      },
    };
  };

  const bounded = [...selected];
  let result = createResult(bounded);
  while (byteLength(JSON.stringify(result, null, 2)) + 1 > MAX_THREAD_MESSAGES_BYTES && bounded.length > 1) {
    // Preserve the root at index 0 and discard the oldest remaining reply.
    bounded.splice(1, 1);
    result = createResult(bounded);
  }
  return result;
}
