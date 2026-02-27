import { RuntimeCache } from "@/shared/cache/runtime-cache";

type TenantToken = { token: string; expiresAt: number };
type MessageThread = { channelId: string; threadId: string };

export class LarkRuntimeState {
  private readonly tenantTokenCache = new RuntimeCache<string, TenantToken>({
    max: 500,
    ttlMs: 3 * 60 * 60 * 1000,
  });
  private readonly botOpenIdCache = new RuntimeCache<string, string>({
    max: 500,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  private readonly sentMessageThreadMap = new RuntimeCache<string, MessageThread>({
    max: 20000,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  private readonly larkMessageEditCounts = new RuntimeCache<string, number>({
    max: 20000,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  private readonly messageProcessorMap = new RuntimeCache<string, string>({
    max: 20000,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  getTenantToken(workspaceId: string): TenantToken | undefined {
    return this.tenantTokenCache.get(workspaceId);
  }

  setTenantToken(workspaceId: string, token: TenantToken): void {
    this.tenantTokenCache.set(workspaceId, token);
  }

  getBotOpenId(workspaceId: string): string | undefined {
    return this.botOpenIdCache.get(workspaceId);
  }

  setBotOpenId(workspaceId: string, openId: string): void {
    this.botOpenIdCache.set(workspaceId, openId);
  }

  setMessageThread(messageId: string, value: MessageThread): void {
    this.sentMessageThreadMap.set(messageId, value);
  }

  getMessageThread(messageId: string): MessageThread | undefined {
    return this.sentMessageThreadMap.get(messageId);
  }

  deleteMessageThread(messageId: string): void {
    this.sentMessageThreadMap.delete(messageId);
  }

  setMessageProcessor(messageId: string, processorId: string): void {
    this.messageProcessorMap.set(messageId, processorId);
  }

  getMessageProcessor(messageId: string): string | undefined {
    return this.messageProcessorMap.get(messageId);
  }

  deleteMessageProcessor(messageId: string): void {
    this.messageProcessorMap.delete(messageId);
  }

  getMessageEditCount(messageId: string): number {
    return this.larkMessageEditCounts.get(messageId) ?? 0;
  }

  setMessageEditCount(messageId: string, count: number): void {
    this.larkMessageEditCounts.set(messageId, count);
  }

  moveMessageEditCount(fromMessageId: string, toMessageId: string): void {
    this.larkMessageEditCounts.delete(fromMessageId);
    this.larkMessageEditCounts.set(toMessageId, 0);
  }

  deleteMessageEditCount(messageId: string): void {
    this.larkMessageEditCounts.delete(messageId);
  }

  clear(): void {
    this.tenantTokenCache.clear();
    this.botOpenIdCache.clear();
    this.sentMessageThreadMap.clear();
    this.larkMessageEditCounts.clear();
    this.messageProcessorMap.clear();
  }
}
