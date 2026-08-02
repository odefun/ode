import { describe, expect, it } from "bun:test";
import { defaultInboundPolicy } from "./inbound-policy";
import type { InboundAttachment } from "@/shared/agent-protocol";

describe("defaultInboundPolicy", () => {
  it("drops thread messages that mention another target", () => {
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: true,
      mentionedBot: false,
      activeThread: true,
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
      normalizedText: "continue",
    });

    expect(decision).toEqual({
      kind: "message",
      text: "continue",
      input: { parts: [{ type: "text", text: "continue" }] },
    });
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
      normalizedText: "thanks, now do X",
    });

    expect(decision).toEqual({
      kind: "message",
      text: "thanks, now do X",
      input: { parts: [{ type: "text", text: "thanks, now do X" }] },
    });
  });

  it("still ignores stranger replies in inactive threads without a mention", () => {
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: false,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: false,
      activeThread: false,
      normalizedText: "random chatter",
    });

    expect(decision).toEqual({ kind: "ignore", reason: "not_mentioned_and_inactive" });
  });

  it("accepts an attachment-only message in an active thread", () => {
    const attachment: InboundAttachment = {
      id: "image-1",
      sourcePlatform: "slack",
      sourceMessageId: "message-1",
      filename: "screen.png",
      mimeType: "image/png",
      size: 42,
      localPath: "/tmp/screen.png",
      sha256: "a".repeat(64),
      kind: "image",
    };
    const decision = defaultInboundPolicy({
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      hasAnyMention: false,
      mentionedBot: false,
      activeThread: true,
      normalizedText: "",
      attachments: [attachment],
    });

    expect(decision).toEqual({
      kind: "message",
      text: "",
      input: {
        parts: [{
          type: "image",
          path: "/tmp/screen.png",
          filename: "screen.png",
          mimeType: "image/png",
          size: 42,
        }],
      },
    });
  });
});
