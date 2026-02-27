import { describe, expect, it } from "bun:test";
import { createCoreRuntime } from "@/core/runtime";
import { loadOdeConfig, updateOdeConfig } from "@/config";
import {
  createActiveRequest,
  deleteSession,
  loadSession,
  saveSession,
} from "@/config/local/sessions";
import type { AgentAdapter, IMAdapter } from "@/core/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await sleep(10);
  }
}

async function withFastMessageUpdates<T>(run: () => Promise<T>): Promise<T> {
  const current = loadOdeConfig();
  const previousValue = current.user.IM_MESSAGE_UPDATE_INTERVAL_MS;
  updateOdeConfig((config) => ({
    ...config,
    user: {
      ...config.user,
      IM_MESSAGE_UPDATE_INTERVAL_MS: 250,
    },
  }));

  try {
    return await run();
  } finally {
    updateOdeConfig((config) => ({
      ...config,
      user: {
        ...config.user,
        IM_MESSAGE_UPDATE_INTERVAL_MS: previousValue,
      },
    }));
  }
}

function createFakeIm(logs: {
  sends: Array<{ channelId: string; threadId: string; text: string }>;
  updates: Array<{ channelId: string; messageTs: string; text: string }>;
}, options?: {
  failUpdateWith429?: boolean;
}): IMAdapter {
  let nextTs = 0;
  return {
    sendMessage: async (channelId, threadId, text) => {
      logs.sends.push({ channelId, threadId, text });
      nextTs += 1;
      return `ts-${nextTs}`;
    },
    updateMessage: async (channelId, messageTs, text) => {
      logs.updates.push({ channelId, messageTs, text });
      if (options?.failUpdateWith429) {
        throw new Error("429 rate limited");
      }
    },
    deleteMessage: async () => {},
    fetchThreadHistory: async () => null,
    buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
  };
}

function createFakeAgent(params?: {
  supportsEventStream?: boolean;
  streamStopAfterMs?: number;
  delayMs?: number;
  responseText?: string;
}) {
  const sentPrompts: string[] = [];
  const supportsEventStream = Boolean(params?.supportsEventStream);

  const agent: AgentAdapter = {
    supportsEventStream,
    enqueueMessage: (context, text, process) => {
      void process(context, text);
    },
    getProviderForSession: () => "opencode",
    getDisplayNameForSession: () => "FakeAgent",
    getOrCreateSession: async () => ({ sessionId: "session-resilience", created: true }),
    sendMessage: async (_channelId, _sessionId, message) => {
      sentPrompts.push(message);
      if (params?.delayMs) {
        await sleep(params.delayMs);
      }
      return [{ text: params?.responseText ?? "resilience response", messageType: "assistant" }];
    },
    abortSession: async () => {},
    ensureSession: async () => {},
    subscribeToSession: (_sessionId, handler) => {
      if (supportsEventStream) {
        const delay = params?.streamStopAfterMs ?? 10;
        const timer = setTimeout(() => {
          handler({
            type: "message.part.updated",
            properties: {
              part: {
                type: "step-finish",
                reason: "stop",
              },
            },
          });
        }, delay);
        return () => clearTimeout(timer);
      }
      return () => {};
    },
    replyToQuestion: async () => {},
    normalizeQuestions: () => [],
  };

  return { agent, sentPrompts };
}

describe("core runtime resilience e2e", () => {
  it("falls back to sending final message when status updates are rate-limited", async () => {
    await withFastMessageUpdates(async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs, { failUpdateWith429: true });
    const { agent } = createFakeAgent({
      delayMs: 5200,
      responseText: "final from agent",
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const context = {
      channelId: "CE2E-RES-429",
      replyThreadId: "TE2E-RES-429",
      threadId: "TE2E-RES-429",
      userId: "UE2E-429",
      messageId: "ME2E-429",
    };

      await runtime.handleIncomingMessage(context, "trigger rate limit flow");
      await waitFor(() => logs.sends.some((entry) => entry.text === "final from agent"), 8000);

      expect(logs.updates.length).toBeGreaterThan(0);
      expect(logs.sends.some((entry) => entry.text === "final from agent")).toBe(true);

      deleteSession(context.channelId, context.threadId);
    });
  }, 15000);

  it("handles stop race in event-stream mode and still completes gracefully", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent } = createFakeAgent({
      supportsEventStream: true,
      streamStopAfterMs: 20,
      delayMs: 120,
      responseText: "late response",
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const context = {
      channelId: "CE2E-STOP-1",
      replyThreadId: "TE2E-STOP-1",
      threadId: "TE2E-STOP-1",
      userId: "UE2E-stop",
      messageId: "ME2E-stop",
    };

    await runtime.handleIncomingMessage(context, "please stop soon");
    await waitFor(() => logs.updates.some((entry) => entry.text === "_Done_"));

    expect(logs.updates.some((entry) => entry.text === "_Done_")).toBe(true);

    deleteSession(context.channelId, context.threadId);
  });

  it("recovers pending in-flight requests after restart", async () => {
    await withFastMessageUpdates(async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent } = createFakeAgent();
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const channelId = "CE2E-REC-1";
    const threadId = "TE2E-REC-1";
    const statusTs = "12345.67";
    const active = createActiveRequest("session-rec-1", channelId, threadId, threadId, statusTs, "hello");
    active.startedAt = Date.now() - 60_000;

    saveSession({
      sessionId: "session-rec-1",
      providerId: "opencode",
      platform: "slack",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: "UE2E-rec",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeRequest: active,
    });

      await runtime.recoverPendingRequests();

      expect(logs.updates.some((entry) => entry.text.includes("Bot restarted"))).toBe(true);
      expect(loadSession(channelId, threadId)?.activeRequest).toBeUndefined();

      deleteSession(channelId, threadId);
    });
  }, 15000);
});
