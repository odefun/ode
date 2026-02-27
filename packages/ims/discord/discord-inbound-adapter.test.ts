import { describe, expect, it } from "bun:test";
import { DiscordInboundAdapter } from "@/ims/discord/discord-inbound-adapter";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

const adapter = new DiscordInboundAdapter();

function createEvent(overrides: Partial<RawInboundEvent>): RawInboundEvent {
  return {
    platform: "discord",
    botId: "discord-bot",
    channelId: "parent-channel",
    rawChannelId: "parent-channel",
    threadId: "thread-id",
    replyThreadId: "thread-id",
    messageId: "message-id",
    userId: "user-id",
    isTopLevel: false,
    mentionedBot: true,
    activeThread: true,
    rawText: "hello",
    normalizedText: "hello",
    receivedAtMs: 1,
    ...overrides,
  };
}

describe("DiscordInboundAdapter", () => {
  it("ignores unmentioned top-level messages", () => {
    const decision = adapter.evaluate(createEvent({ isTopLevel: true, mentionedBot: false, activeThread: false }));
    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });

  it("detects stop command", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "stop" }));
    expect(decision).toEqual({ kind: "stop" });
  });

  it("forwards regular messages", () => {
    const decision = adapter.evaluate(createEvent({ normalizedText: "please continue" }));
    expect(decision).toEqual({ kind: "message", text: "please continue" });
  });
});
