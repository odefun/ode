import { describe, expect, it } from "bun:test";
import { SlackInboundAdapter } from "@/ims/slack/slack-inbound-adapter";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

const adapter = new SlackInboundAdapter();

function createEvent(overrides: Partial<RawInboundEvent>): RawInboundEvent {
  return {
    platform: "slack",
    botId: "slack-bot",
    channelId: "C123",
    rawChannelId: "C123",
    threadId: "1700000000.0001",
    replyThreadId: "1700000000.0001",
    messageId: "1700000000.0002",
    userId: "U123",
    isTopLevel: false,
    mentionedBot: true,
    activeThread: true,
    rawText: "hello",
    normalizedText: "hello",
    receivedAtMs: 1,
    ...overrides,
  };
}

describe("SlackInboundAdapter", () => {
  it("ignores unmentioned top-level messages", () => {
    const decision = adapter.evaluate(createEvent({ isTopLevel: true, mentionedBot: false, activeThread: false }));
    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });

  it("detects stop command", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "stop" }));
    expect(decision).toEqual({ kind: "stop" });
  });

  it("forwards regular messages", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "please summarize this" }));
    expect(decision).toEqual({ kind: "message", text: "please summarize this" });
  });
});
