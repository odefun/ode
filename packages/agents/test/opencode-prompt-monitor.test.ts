import { describe, expect, it } from "bun:test";
import {
  isOpenCodePromptIdleTimedOut,
  getTimedOutOpenCodeInteraction,
  monitorOpenCodePrompt,
  OpenCodeIdlePromptError,
  OpenCodeInteractionTimeoutError,
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

  it("applies a separate upper bound while waiting for interaction", () => {
    const interaction = {
      requestId: "permission-1",
      sessionId: "root",
      kind: "permission" as const,
      askedAt: 1_000,
      permission: "bash",
      patterns: ["git push"],
    };
    expect(getTimedOutOpenCodeInteraction({
      now: 10_000,
      timeoutMs: 5_000,
      health: {
        relatedSessionIds: ["root"],
        lastMeaningfulEventAt: 1_000,
        awaitingInteraction: true,
        pendingInteractions: [interaction],
        statuses: { root: { type: "busy" } },
      },
    })).toEqual(interaction);
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

  it("aborts a prompt whose interaction wait exceeds its own limit", async () => {
    let aborted = false;
    const never = new Promise<string>(() => {});
    await expect(monitorOpenCodePrompt({
      prompt: never,
      timeoutMs: null,
      interactionTimeoutMs: 1,
      pollIntervalMs: 1,
      readHealth: async () => ({
        relatedSessionIds: ["root"],
        lastMeaningfulEventAt: Date.now(),
        awaitingInteraction: true,
        pendingInteractions: [{
          requestId: "question-1",
          sessionId: "root",
          kind: "question",
          askedAt: 0,
        }],
        statuses: { root: { type: "busy" } },
      }),
      abort: async () => {
        aborted = true;
      },
    })).rejects.toBeInstanceOf(OpenCodeInteractionTimeoutError);
    expect(aborted).toBe(true);
  });
});
