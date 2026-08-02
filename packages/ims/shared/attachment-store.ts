import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import type {
  InboundAttachment,
  InboundAttachmentKind,
} from "@/shared/agent-protocol";

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastCleanupStartedAt = 0;

export type AttachmentLimits = Readonly<{
  maxFileBytes: number;
  maxMessageBytes: number;
  maxFiles: number;
}>;

export type AttachmentSource = Readonly<{
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  url: string;
  headers?: Readonly<Record<string, string>>;
}>;

export function getAttachmentLimits(): AttachmentLimits {
  return {
    maxFileBytes: positiveInteger(process.env.ODE_ATTACHMENT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxMessageBytes: positiveInteger(process.env.ODE_ATTACHMENT_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES),
    maxFiles: positiveInteger(process.env.ODE_ATTACHMENT_MAX_FILES, DEFAULT_MAX_FILES),
  };
}

export function getAttachmentStoreRoot(): string {
  return process.env.ODE_ATTACHMENT_DIR?.trim()
    || path.join(homedir(), ".config", "ode", "attachments");
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/[\u0001-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return normalized || fallback;
}

function classifyAttachment(mimeType: string, filename: string): InboundAttachmentKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || /\.(md|txt|json|jsonl|csv|tsv|ya?ml|xml|html?|css|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|sh)$/i.test(filename)) {
    return "text";
  }
  if (/^(application\/(pdf|json|xml|rtf|msword|vnd\.)|text\/)/.test(mime)) return "document";
  return "binary";
}

async function detectMime(buffer: Uint8Array, declared: string | undefined): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected?.mime) return detected.mime;
  const clean = declared?.split(";", 1)[0]?.trim().toLowerCase();
  return clean || "application/octet-stream";
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("attachment size limit exceeded").catch(() => {});
        throw new Error(`Attachment exceeds ${maxBytes} byte per-file limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function scheduleAttachmentCleanup(): void {
  const now = Date.now();
  if (now - lastCleanupStartedAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupStartedAt = now;
  void cleanupExpiredAttachments().catch(() => {});
}

export async function storeAttachmentBytes(params: {
  platform: InboundAttachment["sourcePlatform"];
  messageId: string;
  sourceId?: string;
  filename?: string;
  mimeType?: string;
  bytes: Uint8Array;
  limits?: AttachmentLimits;
}): Promise<InboundAttachment> {
  const limits = params.limits ?? getAttachmentLimits();
  if (params.bytes.byteLength > limits.maxFileBytes) {
    throw new Error(`Attachment exceeds ${limits.maxFileBytes} byte per-file limit`);
  }

  const messageId = sanitizeSegment(params.messageId, "message");
  const directory = path.join(getAttachmentStoreRoot(), params.platform, messageId);
  await ensurePrivateDirectory(directory);

  const originalName = sanitizeSegment(
    path.basename((params.filename ?? "attachment").replace(/\\/g, "/")),
    "attachment"
  );
  const id = sanitizeSegment(params.sourceId ?? randomUUID(), randomUUID());
  const filename = `${id}-${originalName}`;
  const localPath = path.join(directory, filename);
  await Bun.write(localPath, params.bytes, { mode: 0o600 });
  await chmod(localPath, 0o600);

  const mimeType = await detectMime(params.bytes, params.mimeType);
  return {
    id,
    sourcePlatform: params.platform,
    sourceMessageId: params.messageId,
    filename: originalName,
    mimeType,
    size: params.bytes.byteLength,
    localPath,
    sha256: createHash("sha256").update(params.bytes).digest("hex"),
    kind: classifyAttachment(mimeType, originalName),
  };
}

export async function downloadAttachments(params: {
  platform: InboundAttachment["sourcePlatform"];
  messageId: string;
  sources: readonly AttachmentSource[];
  limits?: AttachmentLimits;
}): Promise<InboundAttachment[]> {
  const limits = params.limits ?? getAttachmentLimits();
  if (params.sources.length > limits.maxFiles) {
    throw new Error(`Message has ${params.sources.length} attachments; limit is ${limits.maxFiles}`);
  }

  const declaredTotal = params.sources.reduce(
    (total, source) => total + (typeof source.size === "number" ? source.size : 0),
    0
  );
  if (declaredTotal > limits.maxMessageBytes) {
    throw new Error(`Attachments exceed ${limits.maxMessageBytes} byte per-message limit`);
  }

  let totalBytes = 0;
  const stored: InboundAttachment[] = [];
  try {
    for (const source of params.sources) {
      if (typeof source.size === "number" && source.size > limits.maxFileBytes) {
        throw new Error(`${source.filename ?? "Attachment"} exceeds the per-file limit`);
      }
      const response = await fetch(source.url, { headers: source.headers });
      if (!response.ok) {
        throw new Error(`Attachment download failed: ${response.status} ${response.statusText}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxFileBytes) {
        throw new Error(`${source.filename ?? "Attachment"} exceeds the per-file limit`);
      }
      const bytes = await readResponseBytes(response, limits.maxFileBytes);
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxMessageBytes) {
        throw new Error(`Attachments exceed ${limits.maxMessageBytes} byte per-message limit`);
      }
      stored.push(await storeAttachmentBytes({
        platform: params.platform,
        messageId: params.messageId,
        sourceId: source.id,
        filename: source.filename,
        mimeType: source.mimeType ?? response.headers.get("content-type") ?? undefined,
        bytes,
        limits,
      }));
    }
  } catch (error) {
    const messageDirectory = path.join(
      getAttachmentStoreRoot(),
      params.platform,
      sanitizeSegment(params.messageId, "message")
    );
    await rm(messageDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  scheduleAttachmentCleanup();
  return stored;
}

export async function cleanupExpiredAttachments(params: {
  now?: number;
  retentionMs?: number;
} = {}): Promise<number> {
  const root = getAttachmentStoreRoot();
  const cutoff = (params.now ?? Date.now())
    - (params.retentionMs ?? positiveInteger(process.env.ODE_ATTACHMENT_RETENTION_MS, DEFAULT_RETENTION_MS));
  let removed = 0;
  let platforms: string[];
  try {
    platforms = await readdir(root);
  } catch {
    return 0;
  }
  for (const platform of platforms) {
    const platformDir = path.join(root, platform);
    for (const messageId of await readdir(platformDir).catch(() => [])) {
      const messageDir = path.join(platformDir, messageId);
      const info = await stat(messageDir).catch(() => null);
      if (info?.isDirectory() && info.mtimeMs < cutoff) {
        await rm(messageDir, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
