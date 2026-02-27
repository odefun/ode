import { describe, expect, it } from "bun:test";
import { createCoreRuntime } from "@/core/runtime";
import {
  deleteSession,
  saveSession,
  setPendingQuestion,
  type PendingQuestion,
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

function createFakeIm(logs: {
  sends: Array<{ channelId: string; threadId: string; text: string }>;
  updates: Array<{ channelId: string; messageTs: string; text: string }>;
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
    },
    deleteMessage: async () => {},
    fetchThreadHistory: async () => null,
    buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
  };
}

function createFakeAgent(params?: {
  onSend?: (message: string) => Promise<void> | void;
  responses?: Array<{ text: string; messageType: "assistant" }>;
}) {
  const sentPrompts: string[] = [];
  const replyCalls: Array<Array<Array<string>>> = [];

  const agent: AgentAdapter = {
    supportsEventStream: false,
    enqueueMessage: (context, text, process) => {
      void process(context, text);
    },
    getProviderForSession: () => "opencode",
    getDisplayNameForSession: () => "FakeAgent",
    getOrCreateSession: async () => ({ sessionId: "session-e2e", created: true }),
    sendMessage: async (_channelId, _sessionId, message) => {
      sentPrompts.push(message);
      await params?.onSend?.(message);
      return params?.responses ?? [{ text: "Hello from fake agent", messageType: "assistant" }];
    },
    abortSession: async () => {},
    ensureSession: async () => {},
    subscribeToSession: () => () => {},
    replyToQuestion: async ({ answers }) => {
      replyCalls.push(answers);
    },
    normalizeQuestions: () => [],
  };

  return { agent, sentPrompts, replyCalls };
}

describe("core runtime e2e", () => {
  it("handles a full incoming flow and deduplicates duplicate message ids", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent, sentPrompts } = createFakeAgent();

    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const context = {
      channelId: "CE2E-DEDUP-1",
      replyThreadId: "TE2E-DEDUP-1",
      threadId: "TE2E-DEDUP-1",
      userId: "UE2E-1",
      messageId: "ME2E-1",
    };

    await runtime.handleIncomingMessage(context, "hello runtime");
    await runtime.handleIncomingMessage(context, "hello runtime duplicate");

    await waitFor(() => sentPrompts.length === 1);
    await waitFor(() => logs.updates.some((entry) => entry.text.includes("Hello from fake agent")));

    expect(sentPrompts).toEqual(["hello runtime"]);
    expect(logs.sends.some((entry) => entry.text.includes("is running"))).toBe(true);
    expect(logs.updates.some((entry) => entry.text.includes("Hello from fake agent"))).toBe(true);

    deleteSession(context.channelId, context.threadId);
  });

  it("preserves processing order for multiple queued messages in same thread", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const processingOrder: string[] = [];
    const { agent, sentPrompts } = createFakeAgent({
      onSend: async (message) => {
        processingOrder.push(message);
        if (message === "first") {
          await sleep(40);
        }
      },
      responses: [{ text: "ok", messageType: "assistant" }],
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const baseContext = {
      channelId: "CE2E-QUEUE-1",
      replyThreadId: "TE2E-QUEUE-1",
      threadId: "TE2E-QUEUE-1",
      userId: "UE2E-2",
    };

    await runtime.handleIncomingMessage({ ...baseContext, messageId: "ME2E-Q1" }, "first");
    await runtime.handleIncomingMessage({ ...baseContext, messageId: "ME2E-Q2" }, "second");

    await waitFor(() => sentPrompts.length === 2);

    expect(processingOrder).toEqual(["first", "second"]);
    expect(sentPrompts).toEqual(["first", "second"]);

    deleteSession(baseContext.channelId, baseContext.threadId);
  });

  it("routes pending-question replies instead of opening a new request", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent, sentPrompts, replyCalls } = createFakeAgent();

    const channelId = "CE2E-PQ-1";
    const threadId = "TE2E-PQ-1";
    const ownerUserId = "UE2E-owner";
    const pending: PendingQuestion = {
      requestId: "rq-e2e-1",
      sessionId: "session-e2e-pq",
      askedAt: Date.now(),
      questions: [{ question: "Q1" }, { question: "Q2" }],
    };

    saveSession({
      sessionId: "session-e2e-pq",
      providerId: "opencode",
      platform: "slack",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: ownerUserId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingQuestion: pending,
    });
    setPendingQuestion(channelId, threadId, pending);

    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    await runtime.handleIncomingMessage(
      {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId: ownerUserId,
        messageId: "ME2E-PQ-1",
      },
      "first\nsecond"
    );

    await waitFor(() => replyCalls.length === 1);

    expect(replyCalls[0]).toEqual([["first"], ["second"]]);
    expect(sentPrompts.length).toBe(0);

    deleteSession(channelId, threadId);
  });
});
