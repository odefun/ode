import { describe, expect, it } from "bun:test";
import { truncateEventPayload } from "@/utils/event-truncation";
import { renderStatusesFromRun } from "../renderer";
import type { HarnessCapturedEvent, HarnessRunMeta } from "../types";

type FixtureShape = {
  meta: HarnessRunMeta;
  events: HarnessCapturedEvent[];
};

/**
 * Ensures the memory-saving truncation applied in `request-run.ts` before events
 * are buffered doesn't change the rendered live-status output. The live-status
 * renderer (`packages/utils/status.ts::buildLiveStatusMessage`) only reads short
 * previews of tool.input and thinking text, never full tool output or assistant
 * body — so capping strings inside event.data at ~4 KB must be lossless for UI.
 */
async function loadFixture(path: string): Promise<FixtureShape> {
  const file = Bun.file(`${import.meta.dir}/fixtures/${path}`);
  return JSON.parse(await file.text()) as FixtureShape;
}

function truncateFixtureEvents(fixture: FixtureShape): FixtureShape {
  return {
    meta: fixture.meta,
    events: fixture.events.map((e) => ({
      ...e,
      event: truncateEventPayload(e.event as Record<string, unknown>, {
        maxStringBytes: 256, // aggressive: catches even small payloads
      }),
    })),
  };
}

describe("live status renderer is stable under event truncation", () => {
  const fixtures = [
    "claude-basic-run.json",
    "codex-basic-run.json",
    "kiro-basic-run.json",
    "kilo-basic-run.json",
    "qwen-basic-run.json",
    "goose-basic-run.json",
  ];

  for (const name of fixtures) {
    it(`${name}: statuses match before vs after truncation`, async () => {
      const original = await loadFixture(name);
      const truncated = truncateFixtureEvents(original);

      const statusesOriginal = renderStatusesFromRun(original.meta, original.events);
      const statusesTruncated = renderStatusesFromRun(truncated.meta, truncated.events);

      // Same number of distinct status snapshots
      expect(statusesTruncated.length).toBe(statusesOriginal.length);

      // Each snapshot's rendered text is identical. The renderer only uses
      // short-preview fields (tool name, path, command first N chars, thinking
      // 90-char slice), which sit well below the truncation cap.
      for (let i = 0; i < statusesOriginal.length; i++) {
        expect(statusesTruncated[i]?.text).toBe(statusesOriginal[i]!.text);
      }
    });
  }
});
