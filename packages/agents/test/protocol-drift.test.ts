import { describe, expect, it } from "bun:test";
import { inspectCliProtocol } from "../runtime/protocol-drift";

describe("CLI protocol drift detection", () => {
  it("accepts known nested stream events and flags new ones", () => {
    expect(inspectCliProtocol({
      providerName: "Qwen",
      recordType: "stream_event",
      streamEventType: "content_block_delta",
      knownRecordTypes: ["stream_event"],
      anthropicStyleStream: true,
    }).protocolKnown).toBe(true);

    expect(inspectCliProtocol({
      providerName: "Qwen",
      recordType: "stream_event",
      streamEventType: "new_protocol_event",
      knownRecordTypes: ["stream_event"],
      anthropicStyleStream: true,
    })).toEqual({
      protocolKnown: false,
      protocolLabel: "Qwen stream new_protocol_event",
    });
  });
});
