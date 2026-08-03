import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addDiscordReaction, getDiscordThreadMessages, uploadDiscordFile } from "./api";

const ORIGINAL_FETCH = globalThis.fetch;
let attachmentDir = "";

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.ODE_ATTACHMENT_DIR;
  if (attachmentDir) {
    rmSync(attachmentDir, { recursive: true, force: true });
    attachmentDir = "";
  }
  mock.restore();
});

describe("discord api helpers", () => {
  it("uploads a file via uploadDiscordFile helper", async () => {
    const tempFilePath = join(tmpdir(), `ode-discord-upload-${Date.now()}.txt`);
    await Bun.write(tempFilePath, "hello file");

    try {
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            id: "m-upload",
            channel_id: "c1",
            attachments: [{ id: "a1", filename: "sample.txt", url: "https://cdn.example/file.txt" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as unknown as typeof fetch;

      const result = await uploadDiscordFile({
        botToken: "token",
        channelId: "c1",
        filePath: tempFilePath,
        filename: "sample.txt",
        initialComment: "file uploaded",
      });

      expect(result).toEqual({
        status: "file_uploaded",
        messageId: "m-upload",
        channelId: "c1",
        attachments: [{ id: "a1", filename: "sample.txt", url: "https://cdn.example/file.txt" }],
      });
    } finally {
      rmSync(tempFilePath, { force: true });
    }
  });

  it("fetches thread messages via getDiscordThreadMessages", async () => {
    const fetchMock = mock(async (url: string) => {
      expect(url).toContain("/channels/t1/messages?limit=5");
      return new Response(
        JSON.stringify([
          { id: "m2", timestamp: "2026-01-02T00:00:00Z", content: "there", author: { username: "bob" } },
          { id: "m1", timestamp: "2026-01-01T00:00:00Z", content: "hi", author: { username: "alice" } },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getDiscordThreadMessages({
      botToken: "token",
      channelId: "c1",
      threadId: "t1",
      limit: 5,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.id).toBe("m1");
  });

  it("downloads requested attachments into Ode's private store", async () => {
    attachmentDir = mkdtempSync(join(tmpdir(), "ode-discord-message-attachments-"));
    process.env.ODE_ATTACHMENT_DIR = attachmentDir;
    const fetchMock = mock(async (url: string) => {
      if (url.startsWith("data:")) return ORIGINAL_FETCH(url);
      return new Response(
        JSON.stringify([{
          id: "m1",
          content: "see file",
          attachments: [{
            id: "a1",
            filename: "notes.txt",
            content_type: "text/plain",
            size: 5,
            url: "data:text/plain,hello",
          }],
        }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getDiscordThreadMessages({
      botToken: "token",
      channelId: "c1",
      downloadAttachments: true,
    });

    const attachment = result.messages[0]!.attachments[0]!;
    expect(attachment.localPath?.startsWith(attachmentDir)).toBe(true);
    expect(readFileSync(attachment.localPath!, "utf8")).toBe("hello");
    expect(JSON.stringify(result)).not.toContain("data:text/plain");
  });

  it("adds a reaction via addDiscordReaction", async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      return new Response(null, { status: 204 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await addDiscordReaction({
      botToken: "token",
      channelId: "c1",
      messageId: "m1",
      emoji: "thumbsup",
    });

    expect(result).toEqual({ status: "reaction_added" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported emoji names", async () => {
    await expect(
      addDiscordReaction({
        botToken: "token",
        channelId: "c1",
        messageId: "m1",
        emoji: "fire",
      })
    ).rejects.toThrow("emoji must be one of");
  });
});
