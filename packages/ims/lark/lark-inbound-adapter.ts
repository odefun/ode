import { defaultInboundPolicy } from "@/ims/shared/inbound-policy";
import { parseIncomingCommand } from "@/ims/shared/incoming-message-processor";
import type { InboundAdapter } from "@/ims/shared/inbound-adapter";
import type { InboundDecision } from "@/core/model/inbound-decision";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

export class LarkInboundAdapter implements InboundAdapter {
  evaluate(event: RawInboundEvent): InboundDecision {
    const decision = defaultInboundPolicy({
      isTopLevel: event.isTopLevel,
      mentionedBot: event.mentionedBot,
      activeThread: event.activeThread,
      normalizedText: event.normalizedText,
    });

    if (decision.kind !== "message") return decision;

    const command = parseIncomingCommand(decision.text);
    if (command === "setting") {
      return { kind: "command", name: command, args: [] };
    }

    return decision;
  }
}
