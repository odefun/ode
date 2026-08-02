import { describe, expect, it } from "bun:test";
import {
  isOpenCodePromptIdleTimedOut,
  monitorOpenCodePrompt,
  OpenCodeIdlePromptError,
} from "../opencode/prompt-monitor";

describe("OpenCode prompt idle recovery", () => {
  it("does not time out while a related child session is busy", () => {
    expect(isOpenCodePromptIdleTimedOut({
      now: 10_000,
      timeoutMs: 1_000,
      health: {
        relatedSessionIds: ["root", "child"],
        lastMeaningfulEventAt: 0,
        awaitingInteraction: false,
        statuses: { child: { type: "busy" } },
      },
    })).toBe(false);
  });

  it("does not time out while waiting for a user answer", () => {
    expect(isOpenCodePromptIdleTimedOut({
      now: 10_000,
      timeoutMs: 1_000,
      health: {
        relatedSessionIds: ["root"],
        lastMeaningfulEventAt: 0,
        awaitingInteraction: true,
        statuses: {},
      },
    })).toBe(false);
  });

  it("aborts an idle prompt that never resolves", async () => {
    let aborted = false;
    const never = new Promise<string>(() => {});
    await expect(monitorOpenCodePrompt({
      prompt: never,
      timeoutMs: 1,
      pollIntervalMs: 1,
      readHealth: async () => ({
        relatedSessionIds: ["root"],
        lastMeaningfulEventAt: 0,
        awaitingInteraction: false,
        statuses: {},
      }),
      abort: async () => {
        aborted = true;
      },
    })).rejects.toBeInstanceOf(OpenCodeIdlePromptError);
    expect(aborted).toBe(true);
  });
});
