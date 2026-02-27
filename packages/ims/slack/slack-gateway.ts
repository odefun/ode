import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import type { PlatformGateway } from "@/ims/shared/platform-gateway";

type SlackGatewayDeps = {
  registerInboundHandler: (onEvent: (event: RawInboundEvent) => Promise<void>) => void;
  stopInternal?: () => Promise<void>;
};

export class SlackGateway implements PlatformGateway {
  constructor(private readonly deps: SlackGatewayDeps) {}

  async start(onEvent: (event: RawInboundEvent) => Promise<void>): Promise<void> {
    this.deps.registerInboundHandler(onEvent);
  }

  async stop(): Promise<void> {
    await this.deps.stopInternal?.();
  }
}
