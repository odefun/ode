import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import type { PlatformGateway } from "@/ims/shared/platform-gateway";

type DiscordGatewayDeps = {
  startInternal: (onEvent: (event: RawInboundEvent) => Promise<void>) => Promise<void>;
  stopInternal: () => Promise<void>;
};

export class DiscordGateway implements PlatformGateway {
  constructor(private readonly deps: DiscordGatewayDeps) {}

  async start(onEvent: (event: RawInboundEvent) => Promise<void>): Promise<void> {
    await this.deps.startInternal(onEvent);
  }

  async stop(): Promise<void> {
    await this.deps.stopInternal();
  }
}
