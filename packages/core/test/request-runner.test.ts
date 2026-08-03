import { describe, expect, it } from "bun:test";
import { runTrackedRequest } from "../kernel/request-run";
import type { ActiveRequest } from "@/config/local/sessions";

function buildRequest(): ActiveRequest {
  const now = Date.now();
  return {
    sessionId: "s1",
    replyThreadId: "T1",
    channelId: "C1",
    threadId: "T1",
    statusMessageTs: "100.2",
    prompt: "hello",
    startedAt: now,
    lastUpdatedAt: now,
    currentText: "",
    tools: [],
    todos: [],
    state: "processing",
  };
}

function buildRunParams() {
  return {
    agentResultDetailId: null,
    threadKey: "C1:T1",
    sessionId: "s1",
    providerId: "opencode",
    model: null,
  };
}

describe("runTrackedRequest", () => {
  it("publishes final text on success", async () => {
    const published: string[] = [];
    const completed: string[] = [];

    const result = await runTrackedRequest({
      deps: {
        agent: {
          supportsEventStream: false,
        } as any,
        im: {
          updateMessage: async () => {},
        } as any,
      },
      request: buildRequest(),
      workingPath: "/tmp/project",
      liveEventHistory: new Map(),
      liveParsedState: new Map(),
      sendPrompt: async () => [{ text: "done", messageType: "assistant" }],
      onProgressTick: async () => {},
      onComplete: () => completed.push("ok"),
      onFail: () => {},
      publishFinalText: async (text) => {
        published.push(text);
      },
      failureLogLabel: "runner failed",
      ...buildRunParams(),
    });

    expect(result.responses?.length).toBe(1);
    expect(completed.length).toBe(1);
    expect(published).toEqual(["done"]);
  });

  it("reports failure and updates status", async () => {
    const failures: string[] = [];
    const statusUpdates: string[] = [];

    const result = await runTrackedRequest({
      deps: {
        agent: {
          supportsEventStream: false,
        } as any,
        im: {
          updateMessage: async (_channelId: string, _ts: string, text: string) => {
            statusUpdates.push(text);
          },
        } as any,
      },
      request: buildRequest(),
      workingPath: "/tmp/project",
      liveEventHistory: new Map(),
      liveParsedState: new Map(),
      sendPrompt: async () => {
        throw new Error("boom");
      },
      onProgressTick: async () => {},
      onComplete: () => {},
      onFail: (message) => failures.push(message),
      publishFinalText: async () => {},
      failureLogLabel: "runner failed",
      ...buildRunParams(),
    });

    expect(result.responses).toBeNull();
    expect(failures.length).toBe(1);
    expect(statusUpdates.length).toBe(1);
    expect(statusUpdates[0]).toContain("Error:");
  });

  it("publishes fallback text when stop event wins race", async () => {
    const request = buildRequest();
    request.currentText = "partial output";
    const published: string[] = [];

    const result = await runTrackedRequest({
      deps: {
        agent: {
          supportsEventStream: true,
          ensureSession: async () => {},
          getProviderForSession: () => "opencode",
          subscribeToSession: (_sessionId: string, handler: (event: any) => void) => {
            setTimeout(() => {
              handler({
                type: "message.part.updated",
                properties: { part: { type: "step-finish", reason: "stop" } },
              });
            }, 0);
            return () => {};
          },
        } as any,
        im: {
          updateMessage: async () => {},
        } as any,
      },
      request,
      workingPath: "/tmp/project",
      liveEventHistory: new Map(),
      liveParsedState: new Map(),
      sendPrompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [{ text: "late", messageType: "assistant" }];
      },
      onProgressTick: async () => {},
      onComplete: () => {},
      onFail: () => {},
      publishFinalText: async (text) => {
        published.push(text);
      },
      failureLogLabel: "runner failed",
      ...buildRunParams(),
    });

    expect(result.responses).toEqual([]);
    expect(published).toEqual(["_Done_"]);
  });

  it("does not finish the root request when a child session stops", async () => {
    const published: string[] = [];
    const childContext = {
      rootSessionID: "s1",
      sourceSessionID: "child-1",
      childSession: true,
      transportType: "sync",
    };

    const result = await runTrackedRequest({
      deps: {
        agent: {
          supportsEventStream: true,
          ensureSession: async () => {},
          getProviderForSession: () => "opencode",
          subscribeToSession: (_sessionId: string, handler: (event: any) => void) => {
            setTimeout(() => {
              handler({
                type: "message.part.updated",
                odeContext: childContext,
                properties: {
                  part: {
                    type: "step-finish",
                    reason: "stop",
                    sessionID: "child-1",
                  },
                  odeContext: childContext,
                },
              });
            }, 0);
            return () => {};
          },
        } as any,
        im: {
          updateMessage: async () => {},
        } as any,
      },
      request: buildRequest(),
      workingPath: "/tmp/project",
      liveEventHistory: new Map(),
      liveParsedState: new Map(),
      sendPrompt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [{ text: "root finished", messageType: "assistant" }];
      },
      onProgressTick: async () => {},
      onComplete: () => {},
      onFail: () => {},
      publishFinalText: async (text) => {
        published.push(text);
      },
      failureLogLabel: "runner failed",
      ...buildRunParams(),
    });

    expect(result.responses).toEqual([{ text: "root finished", messageType: "assistant" }]);
    expect(published).toEqual(["root finished"]);
  });

  it("does not echo the user prompt when currentText is the prompt itself", async () => {
    const request = buildRequest();
    request.prompt = "You can use accounts in infra/readme, can connect to staging db";
    // Simulate the bug where OpenCode's user TextPart leaked into
    // currentText. Without the fix this value would be published back.
    request.currentText = request.prompt;
    const published: string[] = [];

    const result = await runTrackedRequest({
      deps: {
        agent: {
          supportsEventStream: false,
        } as any,
        im: {
          updateMessage: async () => {},
        } as any,
      },
      request,
      workingPath: "/tmp/project",
      liveEventHistory: new Map(),
      liveParsedState: new Map(),
      // Tool-only turn: no assistant text responses.
      sendPrompt: async () => [],
      onProgressTick: async () => {},
      onComplete: () => {},
      onFail: () => {},
      publishFinalText: async (text) => {
        published.push(text);
      },
      failureLogLabel: "runner failed",
      ...buildRunParams(),
    });

    expect(result.responses).toEqual([]);
    expect(published).toEqual(["_Done_"]);
    expect(published[0]).not.toBe(request.prompt);
  });
});
