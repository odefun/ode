import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import { log } from "@/utils";

export type KernelCommandHandler = (params: {
  event: RawInboundEvent;
  commandName: string;
  args: string[];
}) => Promise<boolean | void>;

type KernelCommandServiceDeps = {
  handleCommand?: KernelCommandHandler;
};

export class KernelCommandService {
  constructor(private readonly deps: KernelCommandServiceDeps) {}

  async handle(event: RawInboundEvent, commandName: string, args: string[]): Promise<void> {
    const handled = await this.deps.handleCommand?.({
      event,
      commandName,
      args,
    });
    if (handled) return;

    if (commandName === "setting") {
      log.debug("Inbound settings command ignored by kernel command service", {
        platform: event.platform,
        channelId: event.channelId,
        threadId: event.threadId,
        messageId: event.messageId,
      });
      return;
    }

    log.debug("Inbound command ignored by kernel command service", {
      commandName,
      platform: event.platform,
      channelId: event.channelId,
      threadId: event.threadId,
      messageId: event.messageId,
    });
  }
}
