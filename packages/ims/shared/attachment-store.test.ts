import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupExpiredAttachments,
  downloadAttachments,
  storeAttachmentBytes,
} from "./attachment-store";

describe("attachment store", () => {
  let root = "";

  afterEach(async () => {
    delete process.env.ODE_ATTACHMENT_DIR;
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("stores sanitized private files and hashes their bytes", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ode-attachments-"));
    process.env.ODE_ATTACHMENT_DIR = root;
    const attachment = await storeAttachmentBytes({
      platform: "discord",
      messageId: "message/1",
      sourceId: "file/1",
      filename: "../../notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    });

    expect(attachment.filename).toBe("notes.txt");
    expect(attachment.kind).toBe("text");
    expect(attachment.sha256).toHaveLength(64);
    expect(await readFile(attachment.localPath, "utf8")).toBe("hello");
    expect((await stat(attachment.localPath)).mode & 0o777).toBe(0o600);
    expect(attachment.localPath.startsWith(root)).toBe(true);
  });

  it("rejects a file above the configured limit", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ode-attachments-"));
    process.env.ODE_ATTACHMENT_DIR = root;
    await expect(storeAttachmentBytes({
      platform: "slack",
      messageId: "m1",
      bytes: new Uint8Array(4),
      limits: { maxFileBytes: 3, maxMessageBytes: 10, maxFiles: 1 },
    })).rejects.toThrow("per-file limit");
  });

  it("enforces streamed response limits even without a content-length header", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ode-attachments-"));
    process.env.ODE_ATTACHMENT_DIR = root;
    await expect(downloadAttachments({
      platform: "lark",
      messageId: "m2",
      sources: [{ url: "data:application/octet-stream;base64,AQIDBA==" }],
      limits: { maxFileBytes: 3, maxMessageBytes: 10, maxFiles: 1 },
    })).rejects.toThrow("per-file limit");
  });

  it("cleans message directories older than retention", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ode-attachments-"));
    process.env.ODE_ATTACHMENT_DIR = root;
    const attachment = await storeAttachmentBytes({
      platform: "discord",
      messageId: "old-message",
      filename: "old.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("old"),
    });
    const messageDirectory = path.dirname(attachment.localPath);
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(messageDirectory, oldTime, oldTime);

    expect(await cleanupExpiredAttachments({ retentionMs: 1_000 })).toBe(1);
    await expect(stat(messageDirectory)).rejects.toThrow();
  });
});
