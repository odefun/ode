import { describe, expect, it } from "bun:test";
import {
  buildThreadMessagesResult,
  MAX_THREAD_MESSAGES_BYTES,
  normalizeThreadMessageLimit,
  type ThreadMessage,
} from "./thread-messages";

function message(id: string, text: string): ThreadMessage {
  return { id, text, attachments: [] };
}

describe("thread message limits", () => {
  it("uses a shared default and hard message-count cap", () => {
    expect(normalizeThreadMessageLimit(undefined)).toBe(20);
    expect(normalizeThreadMessageLimit(7)).toBe(7);
    expect(normalizeThreadMessageLimit(500)).toBe(50);
  });

  it("keeps the root and newest replies when the count is exceeded", () => {
    const result = buildThreadMessagesResult({
      platform: "slack",
      messages: Array.from({ length: 8 }, (_, index) => message(`m${index}`, `text ${index}`)),
      requestedLimit: 3,
      downloadAttachments: false,
    });

    expect(result.messages.map((item) => item.id)).toEqual(["m0", "m6", "m7"]);
    expect(result.meta.omittedMessages).toBe(5);
    expect(result.meta.truncated).toBe(true);
  });

  it("returns valid JSON within the byte budget", () => {
    const result = buildThreadMessagesResult({
      platform: "discord",
      messages: Array.from({ length: 50 }, (_, index) => message(`m${index}`, "界".repeat(10_000))),
      requestedLimit: 50,
      downloadAttachments: false,
    });
    const json = JSON.stringify(result, null, 2);

    expect(new TextEncoder().encode(`${json}\n`).byteLength).toBeLessThanOrEqual(MAX_THREAD_MESSAGES_BYTES);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.truncatedTextMessages).toBeGreaterThan(0);
    expect(result.meta.omittedMessages).toBeGreaterThan(0);
  });
});
