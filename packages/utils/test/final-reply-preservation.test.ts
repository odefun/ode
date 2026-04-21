import { describe, expect, it } from "bun:test";
import { truncateEventPayload } from "../event-truncation";
import { buildSessionMessageState, type SessionEvent } from "../session-inspector";

/**
 * Regression: the final Slack reply must NEVER be replaced with a truncation
 * marker.
 *
 * `request-run.ts` rebuilds `request.currentText` from `eventHistory` via
 * `buildSessionMessageState(...).currentText`, and publishes it to Slack as
 * the final reply on `stop` and tool-only turns. If `truncateEventPayload`
 * rewrites the assistant text part, the user sees
 * `...[truncated N bytes]` instead of the actual response.
 *
 * These tests simulate the exact ingestion path: raw event → truncate →
 * push → fold → read `currentText`.
 */

function ingestLikeRequestRun(event: Record<string, unknown>): SessionEvent {
  // Must match the logic in `packages/core/kernel/request-run.ts` around the
  // `truncateEventPayload` call site.
  const type = (event as any)?.type;
  const partType = (event as any)?.properties?.part?.type;
  const preserveAssistantText =
    type === "message.part.updated" &&
    (partType === "text" || partType === "reasoning" || partType === "thinking");
  const preserveStringAtPath = preserveAssistantText
    ? (path: string) => path === "properties.part.text"
    : undefined;
  return {
    timestamp: Date.now(),
    type: type ?? "unknown",
    data: truncateEventPayload(event, { preserveStringAtPath }),
  };
}

describe("request-run truncation keeps final assistant reply verbatim", () => {
  it("preserves a long assistant text part across the truncate → fold pipeline", () => {
    const finalReply =
      "Here is the full answer.\n\n" +
      "x".repeat(50_000) +
      "\n\nEnd of answer.";
    const history: SessionEvent[] = [
      ingestLikeRequestRun({
        type: "message.part.updated",
        properties: {
          part: {
            id: "assistant-final",
            type: "text",
            text: finalReply,
            messageID: "msg-1",
          },
        },
      }),
    ];

    const state = buildSessionMessageState(history);
    expect(state.currentText).toBe(finalReply);
    expect(state.currentText).not.toContain("[truncated");
  });

  it("preserves streamed assistant text across many updates with the same part id", () => {
    // Simulate streaming: many intermediate snapshots culminating in the
    // full response.
    const final = "Here is a very long streamed reply.\n" + "y".repeat(30_000);
    const history: SessionEvent[] = [];
    for (let i = 1; i <= 10; i++) {
      const slice = final.slice(0, Math.floor((final.length * i) / 10));
      history.push(
        ingestLikeRequestRun({
          type: "message.part.updated",
          properties: {
            part: {
              id: "assistant-final",
              type: "text",
              text: slice,
              messageID: "msg-1",
            },
          },
        }),
      );
    }

    const state = buildSessionMessageState(history);
    expect(state.currentText).toBe(final);
    expect(state.currentText).not.toContain("[truncated");
  });

  it("still truncates tool output (not part of the final reply)", () => {
    const bigOutput = "z".repeat(20_000);
    const ingested = ingestLikeRequestRun({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tool-1",
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            output: bigOutput,
          },
        },
      },
    });
    const data = ingested.data as any;
    expect(data.properties.part.state.output.length).toBeLessThan(bigOutput.length);
    expect(data.properties.part.state.output).toContain("[truncated");
  });

  it("preserves reasoning / thinking text used for live status phase updates", () => {
    const reasoning = "r".repeat(12_000);
    const thinking = "t".repeat(12_000);
    const reasoningEvent = ingestLikeRequestRun({
      type: "message.part.updated",
      properties: {
        part: { id: "r1", type: "reasoning", text: reasoning },
      },
    });
    const thinkingEvent = ingestLikeRequestRun({
      type: "message.part.updated",
      properties: {
        part: { id: "t1", type: "thinking", text: thinking },
      },
    });
    expect((reasoningEvent.data as any).properties.part.text).toBe(reasoning);
    expect((thinkingEvent.data as any).properties.part.text).toBe(thinking);
  });
});
