import type { InboundDecision } from "@/core/model/inbound-decision";

export function defaultInboundPolicy(params: {
  selfMessage: boolean;
  threadOwnerMessage: boolean;
  isTopLevel: boolean;
  hasAnyMention: boolean;
  mentionedBot: boolean;
  activeThread: boolean;
  ambientMode: boolean;
  normalizedText: string;
  detectStop?: boolean;
}): InboundDecision {
  if (params.selfMessage) {
    return { kind: "ignore", reason: "self_message" };
  }

  if (!params.isTopLevel && params.hasAnyMention && !params.mentionedBot) {
    return { kind: "ignore", reason: "not_mentioned_and_inactive" };
  }

  if (!params.isTopLevel && !params.mentionedBot) {
    // `threadOwnerMessage` is true either when the sender is the claimed
    // owner of the thread, or when the thread is still owned by a synthetic
    // placeholder (task:/cron:/cron-job:) waiting for the first human
    // replier to adopt it. In both cases the bot should engage without
    // requiring an @-mention, even if the activity window has lapsed or
    // the last-activity bot id doesn't match (e.g. cron seeds the session
    // with a synthetic `lastActivityBotId`).
    if (!params.threadOwnerMessage && !params.activeThread) {
      return { kind: "ignore", reason: "not_mentioned_and_inactive" };
    }
    if (!params.threadOwnerMessage) {
      return { kind: "ignore", reason: "not_thread_owner" };
    }
  }

  const shouldProcess = params.isTopLevel
    ? (params.ambientMode || params.mentionedBot)
    : (params.ambientMode || params.mentionedBot || params.activeThread || params.threadOwnerMessage);

  if (!shouldProcess) {
    return { kind: "ignore", reason: "not_mentioned_and_inactive" };
  }

  const text = params.normalizedText.trim();
  if (!text) {
    return { kind: "ignore", reason: "empty_text" };
  }

  if (params.detectStop !== false && text.toLowerCase() === "stop") {
    return { kind: "stop" };
  }

  return { kind: "message", text };
}
