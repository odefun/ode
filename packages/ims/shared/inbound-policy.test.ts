import { describe, expect, it } from "bun:test";
import { defaultInboundPolicy } from "./inbound-policy";

describe("defaultInboundPolicy", () => {
  it("drops thread messages that mention another target", () => {
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: true,
      mentionedBot: false,
      activeThread: true,
      ambientMode: false,
      normalizedText: "<@other> handle this",
    });

    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });

  it("keeps active-thread owner follow-ups without mentions", () => {
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: false,
      activeThread: true,
      ambientMode: false,
      normalizedText: "continue",
    });

    expect(decision).toEqual({ kind: "message", text: "continue" });
  });

  it("adopts a synthetic-owner thread on the first human reply even when inactive", () => {
    // cron/task seeds the session with a synthetic `lastActivityBotId`
    // ("cron-job" / "task") which never matches the runtime Slack bot
    // token, so `activeThread` is false for the very first human reply.
    // The thread owner resolver marks synthetic-owned threads as claimable
    // (threadOwnerMessage = true); the policy must let such replies
    // through without requiring an @-mention.
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: false,
      activeThread: false,
      ambientMode: false,
      normalizedText: "thanks, now do X",
    });

    expect(decision).toEqual({ kind: "message", text: "thanks, now do X" });
  });

  it("still ignores stranger replies in inactive threads without a mention", () => {
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: false,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: false,
      activeThread: false,
      ambientMode: false,
      normalizedText: "random chatter",
    });

    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });
});
