import { describe, expect, it } from "bun:test";
import {
  appendCoalescedSessionEvent,
  getRawProviderEventSamplingKey,
  orderSessionEventsChronologically,
  SampledRawEventBuffer,
} from "@/core/runtime/session-event-buffer";
import type { SessionEvent } from "@/utils/session-inspector";

function textEvent(text: string, timestamp: number): SessionEvent {
  return {
    timestamp,
    type: "message.part.updated",
    data: {
      type: "message.part.updated",
      properties: {
        sessionID: "child-1",
        part: { id: "part-1", sessionID: "child-1", type: "text", text },
      },
    },
  };
}

describe("session event buffering", () => {
  it("replaces repeated snapshots for the same part", () => {
    const history: SessionEvent[] = [];
    const indexes = new Map<string, number>();
    appendCoalescedSessionEvent(history, indexes, textEvent("a", 1));
    appendCoalescedSessionEvent(history, indexes, textEvent("ab", 2));
    expect(history).toHaveLength(1);
    expect((history[0]?.data.properties as any).part.text).toBe("ab");
  });

  it("samples noisy and snapshot raw events by stable keys", () => {
    expect(getRawProviderEventSamplingKey(textEvent("a", 1))).toContain("part-1");
    expect(getRawProviderEventSamplingKey({
      timestamp: 1,
      type: "server.heartbeat",
      data: {},
    })).toBe("noise:server.heartbeat");
  });

  it("replays replaced snapshots according to their latest timestamp", () => {
    const history: SessionEvent[] = [];
    const indexes = new Map<string, number>();
    appendCoalescedSessionEvent(history, indexes, textEvent("first", 1));
    appendCoalescedSessionEvent(history, indexes, {
      timestamp: 2,
      type: "question.asked",
      data: { id: "question-1" },
    });
    appendCoalescedSessionEvent(history, indexes, textEvent("latest", 3));

    expect(orderSessionEventsChronologically(history).map((event) => event.timestamp)).toEqual([2, 3]);
  });

  it("caps retained raw events and reports dropped events once", () => {
    const buffer = new SampledRawEventBuffer(2);
    buffer.enqueue({ timestamp: 1, type: "question.asked", data: { id: "1" } });
    buffer.enqueue({ timestamp: 2, type: "question.replied", data: { id: "2" } });
    buffer.enqueue({ timestamp: 3, type: "run.extra", data: { id: "3" } });
    expect(buffer.drain(true)).toEqual({
      events: [
        { timestamp: 1, type: "question.asked", data: { id: "1" } },
        { timestamp: 2, type: "question.replied", data: { id: "2" } },
      ],
      summary: { dropped: 1, retained: 2 },
    });
    expect(buffer.drain(true)).toEqual({ events: [], summary: undefined });
  });
});
