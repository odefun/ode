import type { BotPlatform } from "@/core/model/bot-key";

export type RawInboundEvent = Readonly<{
  platform: BotPlatform;
  botId: string;
  channelId: string;
  rawChannelId?: string;
  threadId: string;
  replyThreadId: string;
  messageId: string;
  userId: string;
  selfMessage: boolean;
  threadOwnerMessage: boolean;
  isTopLevel: boolean;
  hasAnyMention?: boolean;
  mentionedBot: boolean;
  activeThread: boolean;
  rawText: string;
  normalizedText: string;
  ambientMode: boolean;
  receivedAtMs: number;
}>;
