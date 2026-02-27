import { describe, expect, it } from "bun:test";
import { createMessageProcessor } from "@/agents/message-processor";
import type { CoreMessageContext } from "@/core/types";

function makeContext(channelId: string, threadId: string): CoreMessageContext {
  return {
    channelId,
    threadId,
    replyThreadId: threadId,
    userId: "U1",
    messageId: `${channelId}-${threadId}-${Date.now()}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AgentAdapter queue", () => {
  it("batches multiple messages from the same thread", async () => {
    const calls: string[] = [];
    const adapter = createMessageProcessor();

    adapter.enqueueMessage(makeContext("C1", "T1"), "one", async (_ctx, text) => {
      calls.push(text);
    });
    adapter.enqueueMessage(makeContext("C1", "T1"), "two", async (_ctx, text) => {
      calls.push(text);
    });
    adapter.enqueueMessage(makeContext("C1", "T1"), "three", async (_ctx, text) => {
      calls.push(text);
    });

    await sleep(20);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.join("\n")).toBe("one\ntwo\nthree");
  });

  it("processes different thread keys independently", async () => {
    const calls: string[] = [];
    const adapter = createMessageProcessor();

    adapter.enqueueMessage(makeContext("C1", "T1"), "a", async (ctx, text) => {
      calls.push(`${ctx.threadId}:${text}`);
    });
    adapter.enqueueMessage(makeContext("C1", "T2"), "b", async (ctx, text) => {
      calls.push(`${ctx.threadId}:${text}`);
    });

    await sleep(20);

    expect(new Set(calls)).toEqual(new Set(["T1:a", "T2:b"]));
  });

  it("runs a second pass when new items arrive while processing", async () => {
    const calls: string[] = [];
    const adapter = createMessageProcessor();

    const ctx = makeContext("C1", "T1");
    adapter.enqueueMessage(ctx, "first", async (nextCtx, text) => {
      calls.push(text);
      if (text === "first") {
        adapter.enqueueMessage(nextCtx, "second", async (_ctx, nextText) => {
          calls.push(nextText);
        });
      }
    });
    await sleep(20);

    expect(calls).toEqual(["first", "second"]);
  });
});
