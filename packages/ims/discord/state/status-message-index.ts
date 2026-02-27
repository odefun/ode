import { RuntimeCache } from "@/shared/cache/runtime-cache";

export class DiscordStatusMessageIndex {
  private readonly statusMessageThreadMap = new RuntimeCache<string, string>({
    max: 20000,
    ttlMs: 24 * 60 * 60 * 1000,
  });
  private readonly statusMessageProcessorMap = new RuntimeCache<string, string>({
    max: 20000,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  setThreadId(messageId: string, threadId: string): void {
    this.statusMessageThreadMap.set(messageId, threadId);
  }

  getThreadId(messageId: string): string | undefined {
    return this.statusMessageThreadMap.get(messageId);
  }

  setProcessorId(messageId: string, processorId: string): void {
    this.statusMessageProcessorMap.set(messageId, processorId);
  }

  getProcessorId(messageId: string): string | undefined {
    return this.statusMessageProcessorMap.get(messageId);
  }

  clear(): void {
    this.statusMessageThreadMap.clear();
    this.statusMessageProcessorMap.clear();
  }
}
