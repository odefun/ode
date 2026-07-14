import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createCoreRuntime } from "@/core/runtime";
import {
  buildThreadKey,
  clearMessageStoreForTests,
  closeMessageDatabaseForTests,
  getMessageThreadById,
} from "@/config/local/inbox";
import {
  deleteSession,
  saveSession,
  setPendingQuestion,
  type PendingQuestion,
} from "@/config/local/sessions";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sequence = 0;
const tempInboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-runtime-inbox-test-"));
const tempInboxDbFile = path.join(tempInboxDir, "inbox.db");

function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sequence}`;
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
  deletes?: Array<{ channelId: string; messageTs: string }>;
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
    deleteMessage: async (channelId, messageTs) => {
      logs.deletes?.push({ channelId, messageTs });
    },
    fetchThreadHistory: async () => null,
    buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
  };
}

function toInboundEvent(params: {
  platform: "slack" | "discord" | "lark";
  botId?: string;
  channelId: string;
  threadId: string;
  userId: string;
  messageId: string;
  text: string;
  isTopLevel?: boolean;
  mentionedBot?: boolean;
  activeThread?: boolean;
}): RawInboundEvent {
  return {
    platform: params.platform,
    botId: params.botId ?? "default",
    channelId: params.channelId,
    rawChannelId: params.channelId,
    threadId: params.threadId,
    replyThreadId: params.threadId,
    messageId: params.messageId,
    userId: params.userId,
    selfMessage: false,
    threadOwnerMessage: true,
    isTopLevel: params.isTopLevel ?? false,
    mentionedBot: params.mentionedBot ?? true,
    activeThread: params.activeThread ?? true,
    ambientMode: false,
    rawText: params.text,
    normalizedText: params.text,
    receivedAtMs: Date.now(),
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
  const previousCi = process.env.CI;

  beforeAll(() => {
    process.env.CI = "1";
    process.env.ODE_INBOX_DB_FILE = tempInboxDbFile;
  });

  afterAll(() => {
    closeMessageDatabaseForTests();
    delete process.env.ODE_INBOX_DB_FILE;
    fs.rmSync(tempInboxDir, { recursive: true, force: true });
    if (previousCi === undefined) {
      delete process.env.CI;
      return;
    }
    process.env.CI = previousCi;
  });

  it("handles a full incoming flow and deduplicates duplicate message ids", async () => {
    clearMessageStoreForTests();
    const logs = { sends: [], updates: [], deletes: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
      deletes: Array<{ channelId: string; messageTs: string }>;
    };
    const im = createFakeIm(logs);
    const { agent, sentPrompts } = createFakeAgent();

    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const channelId = uniqueId("CE2E-DEDUP");
    const threadId = uniqueId("TE2E-DEDUP");
    const context = {
      channelId,
      replyThreadId: threadId,
      threadId,
      userId: "UE2E-1",
      messageId: uniqueId("ME2E"),
    };

    await runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId: context.channelId,
      threadId: context.threadId,
      userId: context.userId,
      messageId: context.messageId,
      text: "hello runtime",
    }));
    await runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId: context.channelId,
      threadId: context.threadId,
      userId: context.userId,
      messageId: context.messageId,
      text: "hello runtime duplicate",
    }));

    await waitFor(() => sentPrompts.length === 1);
    await waitFor(() => logs.sends.some((entry) => entry.text.includes("Hello from fake agent")));

    expect(sentPrompts).toEqual(["hello runtime"]);
    expect(logs.sends.some((entry) => entry.text.includes("is running"))).toBe(true);
    // Final result is always posted as a new message (not an update of the status message).
    expect(logs.sends.some((entry) => entry.text.includes("Hello from fake agent"))).toBe(true);
    // The original status message is deleted after the final result is posted.
    expect(logs.deletes.length).toBeGreaterThan(0);
    const thread = getMessageThreadById(buildThreadKey(context.channelId, context.threadId));
    expect(thread).not.toBeNull();
    const userPrompt = thread?.details.find((d) => d.kind === "user_prompt");
    const agentResult = thread?.details.find((d) => d.kind === "agent_result");
    expect(userPrompt?.promptText).toBe("hello runtime");
    expect(agentResult?.resultText).toBe("Hello from fake agent");
    expect(agentResult?.status).toBe("completed");

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
          await sleep(10);
        }
      },
      responses: [{ text: "ok", messageType: "assistant" }],
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const channelId = uniqueId("CE2E-QUEUE");
    const threadId = uniqueId("TE2E-QUEUE");

    const baseContext = {
      channelId,
      replyThreadId: threadId,
      threadId,
      userId: "UE2E-2",
    };

    const firstRun = runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId: baseContext.channelId,
      threadId: baseContext.threadId,
      userId: baseContext.userId,
      messageId: uniqueId("ME2E-Q1"),
      text: "first",
    }));
    const secondRun = runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId: baseContext.channelId,
      threadId: baseContext.threadId,
      userId: baseContext.userId,
      messageId: uniqueId("ME2E-Q2"),
      text: "second",
    }));
    await Promise.all([firstRun, secondRun]);

    await waitFor(() => sentPrompts.length === 2);

    expect(processingOrder).toEqual(["first", "second"]);
    expect(sentPrompts).toEqual(["first", "second"]);

    deleteSession(baseContext.channelId, baseContext.threadId);
  }, 15000);

  it("routes pending-question replies instead of opening a new request", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent, sentPrompts, replyCalls } = createFakeAgent();

    const channelId = uniqueId("CE2E-PQ");
    const threadId = uniqueId("TE2E-PQ");
    const ownerUserId = "UE2E-owner";
    const pending: PendingQuestion = {
      requestId: "rq-e2e-1",
      sessionId: "session-e2e-pq",
      askedAt: Date.now(),
      questions: [{ question: "Q1" }, { question: "Q2" }],
      collectedAnswers: [],
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

    // First reply — should not submit; should post follow-up Q2 to the thread.
    await runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId,
      threadId,
      userId: ownerUserId,
      messageId: uniqueId("ME2E-PQ-1"),
      text: "first",
    }));

    await waitFor(() =>
      logs.sends.some((entry) => entry.channelId === channelId && entry.text.includes("(2/2)"))
    );
    expect(replyCalls.length).toBe(0);
    expect(sentPrompts.length).toBe(0);

    // Second reply — now the accumulated answers should be submitted.
    await runtime.handleInboundEvent(toInboundEvent({
      platform: "slack",
      channelId,
      threadId,
      userId: ownerUserId,
      messageId: uniqueId("ME2E-PQ-2"),
      text: "second",
    }));

    await waitFor(() => replyCalls.length === 1);

    expect(replyCalls[0]).toEqual([["first"], ["second"]]);
    expect(sentPrompts.length).toBe(0);

    deleteSession(channelId, threadId);
  });

  it("keeps dispatch parity for Discord between message and inbound-event entry points", async () => {
    const messageLogs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const eventLogs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const messageIm = createFakeIm(messageLogs);
    const eventIm = createFakeIm(eventLogs);
    const messageAgent = createFakeAgent();
    const eventAgent = createFakeAgent();

    const runtimeFromMessage = createCoreRuntime({ platform: "discord", im: messageIm, agent: messageAgent.agent });
    const channelIdMessage = uniqueId("CE2E-DIS-MSG");
    const threadIdMessage = uniqueId("TE2E-DIS-MSG");
    await runtimeFromMessage.handleInboundEvent(toInboundEvent({
      platform: "discord",
      botId: "bot-1",
      channelId: channelIdMessage,
      threadId: threadIdMessage,
      userId: "UE2E-dis",
      messageId: uniqueId("ME2E-dis-msg"),
      text: "hello discord",
    }));
    await waitFor(() => messageAgent.sentPrompts.length === 1);
    deleteSession(channelIdMessage, threadIdMessage);

    const runtimeFromEvent = createCoreRuntime({ platform: "discord", im: eventIm, agent: eventAgent.agent });
    const channelIdEvent = uniqueId("CE2E-DIS-EVT");
    const threadIdEvent = uniqueId("TE2E-DIS-EVT");
    const event: RawInboundEvent = {
      platform: "discord",
      botId: "bot-1",
      channelId: channelIdEvent,
      rawChannelId: channelIdEvent,
      threadId: threadIdEvent,
      replyThreadId: threadIdEvent,
      messageId: uniqueId("ME2E-dis-evt"),
      userId: "UE2E-dis",
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      mentionedBot: true,
      activeThread: true,
      ambientMode: false,
      rawText: "hello discord",
      normalizedText: "hello discord",
      receivedAtMs: Date.now(),
    };
    await runtimeFromEvent.handleInboundEvent(event);
    await waitFor(() => eventAgent.sentPrompts.length === 1);
    deleteSession(channelIdEvent, threadIdEvent);

    expect(messageAgent.sentPrompts).toEqual(["hello discord"]);
    expect(eventAgent.sentPrompts).toEqual(["hello discord"]);
  });

  it("keeps dispatch parity for Lark and ignores unmentioned top-level messages", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent, sentPrompts } = createFakeAgent();

    const runtime = createCoreRuntime({ platform: "lark", im, agent });
    const channelId = uniqueId("CE2E-LARK");
    const threadId = uniqueId("TE2E-LARK");

    await runtime.handleInboundEvent({
      platform: "lark",
      botId: "bot-lark",
      channelId,
      rawChannelId: channelId,
      threadId,
      replyThreadId: threadId,
      messageId: uniqueId("ME2E-lark-ignore"),
      userId: "UE2E-lark",
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: true,
      mentionedBot: false,
      activeThread: false,
      ambientMode: false,
      rawText: "random text",
      normalizedText: "random text",
      receivedAtMs: Date.now(),
    });

    await runtime.handleInboundEvent({
      platform: "lark",
      botId: "bot-lark",
      channelId,
      rawChannelId: channelId,
      threadId,
      replyThreadId: threadId,
      messageId: uniqueId("ME2E-lark-forward"),
      userId: "UE2E-lark",
      selfMessage: false,
      threadOwnerMessage: true,
      isTopLevel: false,
      mentionedBot: true,
      activeThread: true,
      ambientMode: false,
      rawText: "hello lark",
      normalizedText: "hello lark",
      receivedAtMs: Date.now(),
    });

    await waitFor(() => sentPrompts.length === 1);
    deleteSession(channelId, threadId);

    expect(sentPrompts).toEqual(["hello lark"]);
  });
});
