import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addLarkReaction, getLarkThreadMessages, uploadLarkFile } from "./api";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restore();
});

describe("lark api helpers", () => {
  it("uploads a file via uploadLarkFile helper", async () => {
    const tempFilePath = join(tmpdir(), `ode-lark-upload-${Date.now()}.txt`);
    await Bun.write(tempFilePath, "hello lark file");

    try {
      const fetchMock = mock(async (url: string) => {
        if (url.includes("tenant_access_token")) {
          return new Response(
            JSON.stringify({ code: 0, tenant_access_token: "tenant_token" }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (url.includes("/im/v1/files")) {
          return new Response(
            JSON.stringify({ code: 0, data: { file_key: "file_xxx" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        if (url.includes("/im/v1/messages")) {
          return new Response(
            JSON.stringify({ code: 0, data: { message_id: "om_file" } }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }

        return new Response(JSON.stringify({ code: 0, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await uploadLarkFile({
        appId: "cli_app",
        appSecret: "secret",
        channelId: "oc_123",
        threadId: "om_root",
        filePath: tempFilePath,
        filename: "sample.txt",
        initialComment: "uploading file",
      });

      expect(result).toEqual({
        status: "file_uploaded",
        messageId: "om_file",
        channelId: "oc_123",
        fileKey: "file_xxx",
      });
    } finally {
      rmSync(tempFilePath, { force: true });
    }
  });

  it("fetches the thread root plus newest replies", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.includes("tenant_access_token")) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant_token" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/im/v1/messages/") && !url.includes("/reactions")) {
        // root message lookup — provide a thread_id so the filter branches to
        // "match by thread_id".
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [{ message_id: "om_root", thread_id: "thr_1" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("container_id_type=thread")) {
        expect(url).toContain("sort_type=ByCreateTimeDesc");
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { message_id: "om_new", thread_id: "thr_1", create_time: "3" },
                { message_id: "om_old", thread_id: "thr_1", create_time: "2" },
                { message_id: "om_root", thread_id: "thr_1", create_time: "1" },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await getLarkThreadMessages({
      appId: "cli_app",
      appSecret: "secret",
      channelId: "oc_123",
      threadId: "om_root",
      limit: 2,
    });

    expect(result.messages.map((m) => m.id)).toEqual(["om_root", "om_new"]);
  });

  it("adds a reaction via addLarkReaction", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.includes("tenant_access_token")) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: "tenant_token" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/reactions")) {
        expect(init?.method).toBe("POST");
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as { reaction_type?: { emoji_type?: string } }
          : {};
        expect(body.reaction_type?.emoji_type).toBe("THUMBSUP");
        return new Response(
          JSON.stringify({ code: 0, data: {} }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await addLarkReaction({
      appId: "cli_app",
      appSecret: "secret",
      messageId: "om_root",
      emoji: "thumbsup",
    });

    expect(result).toEqual({ status: "reaction_added", messageId: "om_root" });
  });
});
