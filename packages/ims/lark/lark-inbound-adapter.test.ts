import { describe, expect, it } from "bun:test";
import { LarkInboundAdapter } from "@/ims/lark/lark-inbound-adapter";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

const adapter = new LarkInboundAdapter();

function createEvent(overrides: Partial<RawInboundEvent>): RawInboundEvent {
  return {
    platform: "lark",
    botId: "lark-bot",
    channelId: "oc_123",
    rawChannelId: "oc_123",
    threadId: "om_1",
    replyThreadId: "om_1",
    messageId: "om_2",
    userId: "ou_123",
    isTopLevel: false,
    mentionedBot: true,
    activeThread: true,
    rawText: "hello",
    normalizedText: "hello",
    receivedAtMs: 1,
    ...overrides,
  };
}

describe("LarkInboundAdapter", () => {
  it("ignores unmentioned top-level messages", () => {
    const decision = adapter.evaluate(createEvent({ isTopLevel: true, mentionedBot: false, activeThread: false }));
    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });

  it("detects stop command", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "stop" }));
    expect(decision).toEqual({ kind: "stop" });
  });

  it("forwards regular messages", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "please review" }));
    expect(decision).toEqual({ kind: "message", text: "please review" });
  });
});
