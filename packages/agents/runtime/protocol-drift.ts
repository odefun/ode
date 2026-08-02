import { BoundedSet, log } from "@/utils";

const KNOWN_ANTHROPIC_STREAM_EVENTS = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

const unknownProtocolLabels = new BoundedSet<string>(500);

export function inspectCliProtocol(params: {
  providerName: string;
  recordType: string;
  streamEventType?: string;
  knownRecordTypes: readonly string[];
  anthropicStyleStream?: boolean;
}): { protocolKnown: boolean; protocolLabel: string } {
  const knownRecord = params.knownRecordTypes.includes(params.recordType);
  const unknownNestedStream = params.anthropicStyleStream === true
    && params.recordType === "stream_event"
    && (!params.streamEventType || !KNOWN_ANTHROPIC_STREAM_EVENTS.has(params.streamEventType));
  const protocolKnown = knownRecord && !unknownNestedStream;
  const protocolLabel = unknownNestedStream
    ? `${params.providerName} stream ${params.streamEventType ?? "unknown"}`
    : `${params.providerName} record ${params.recordType}`;
  if (!protocolKnown && !unknownProtocolLabels.has(protocolLabel)) {
    unknownProtocolLabels.add(protocolLabel);
    log.warn("Unknown coding CLI protocol event", { protocolLabel });
  }
  return { protocolKnown, protocolLabel };
}
