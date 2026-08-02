import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createCoreRuntime } from "@/core/runtime";
import { loadOdeConfig, updateOdeConfig } from "@/config";
import {
  clearMessageStoreForTests,
  closeMessageDatabaseForTests,
} from "@/config/local/inbox";
import {
  createActiveRequest,
  deleteSession,
  loadSession,
  saveSession,
} from "@/config/local/sessions";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import { renderAgentInputAsText } from "@/shared/agent-protocol";
import { LEGACY_AGENT_CAPABILITIES } from "@/shared/agent-protocol";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let sequence = 0;
const tempInboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-runtime-resilience-inbox-test-"));
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

async function withMessageUpdateInterval<T>(
  intervalMs: number,
  run: () => Promise<T>
): Promise<T> {
  const current = loadOdeConfig();
  const previousValue = current.user.IM_MESSAGE_UPDATE_INTERVAL_MS;
  updateOdeConfig((config) => ({
    ...config,
    user: {
      ...config.user,
      IM_MESSAGE_UPDATE_INTERVAL_MS: intervalMs,
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

async function withFastMessageUpdates<T>(run: () => Promise<T>): Promise<T> {
  return withMessageUpdateInterval(250, run);
}

function createFakeIm(logs: {
  sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
  updates: Array<{ channelId: string; messageTs: string; text: string }>;
}, options?: {
  failUpdateWith429?: boolean;
  failUpdateWithErrorOnce?: string;
  failAllSendsWith?: string;
  failInitialSendWith?: string;
  failReplacementSendWith?: string;
}): IMAdapter {
  let nextTs = 0;
  let failedUpdateOnce = false;
  let sendCallCount = 0;
  return {
    sendMessage: async (channelId, threadId, text) => {
      sendCallCount += 1;
      if (options?.failInitialSendWith && sendCallCount === 1) {
        throw new Error(options.failInitialSendWith);
      }
      if (
        options?.failReplacementSendWith
        && (text.startsWith("Status update failed:") || /switching to a new status message/i.test(text))
      ) {
        throw new Error(options.failReplacementSendWith);
      }
      if (options?.failAllSendsWith) {
        throw new Error(options.failAllSendsWith);
      }
      nextTs += 1;
      const messageTs = `ts-${nextTs}`;
      logs.sends.push({ channelId, threadId, text, messageTs });
      return messageTs;
    },
    updateMessage: async (channelId, messageTs, text) => {
      logs.updates.push({ channelId, messageTs, text });
      if (options?.failUpdateWith429) {
        throw new Error("429 rate limited");
      }
      if (!failedUpdateOnce && options?.failUpdateWithErrorOnce) {
        failedUpdateOnce = true;
        throw new Error(options.failUpdateWithErrorOnce);
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
  errorMessage?: string;
  emitToolEvent?: boolean;
}) {
  const sentPrompts: string[] = [];
  const supportsEventStream = Boolean(params?.supportsEventStream);

  const agent: AgentAdapter = {
    supportsEventStream,
    getProviderForSession: () => "opencode",
    getDisplayNameForSession: () => "FakeAgent",
    getTransportForSession: () => "cli-json",
    getCapabilitiesForSession: () => LEGACY_AGENT_CAPABILITIES,
    getOrCreateSession: async () => ({ sessionId: "session-resilience", created: true }),
    sendMessage: async (_channelId, _sessionId, input) => {
      const message = renderAgentInputAsText(input);
      sentPrompts.push(message);
      if (params?.errorMessage) {
        throw new Error(params.errorMessage);
      }
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
        if (params?.emitToolEvent) {
          setTimeout(() => {
            handler({
              type: "message.part.updated",
              properties: {
                part: {
                  id: "tool_1",
                  sessionID: "session-resilience",
                  type: "tool",
                  tool: "Read",
                  state: {
                    status: "running",
                    input: { filePath: "/tmp/repo/README.md" },
                  },
                },
              },
            });
          }, 10);
        }
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

function toInboundEvent(params: {
  channelId: string;
  threadId: string;
  userId: string;
  messageId: string;
  text: string;
}): RawInboundEvent {
  return {
    platform: "slack",
    botId: "default",
    channelId: params.channelId,
    rawChannelId: params.channelId,
    threadId: params.threadId,
    replyThreadId: params.threadId,
    messageId: params.messageId,
    userId: params.userId,
    selfMessage: false,
    threadOwnerMessage: true,
    isTopLevel: false,
    mentionedBot: true,
    activeThread: true,
    rawText: params.text,
    normalizedText: params.text,
    receivedAtMs: Date.now(),
  };
}

describe("core runtime resilience e2e", () => {
  const previousCi = process.env.CI;
  const previousInboxDbFile = process.env.ODE_INBOX_DB_FILE;

  beforeAll(() => {
    process.env.CI = "1";
    process.env.ODE_INBOX_DB_FILE = tempInboxDbFile;
  });

  beforeEach(() => {
    clearMessageStoreForTests();
  });

  afterAll(() => {
    closeMessageDatabaseForTests();
    if (previousInboxDbFile === undefined) {
      delete process.env.ODE_INBOX_DB_FILE;
    } else {
      process.env.ODE_INBOX_DB_FILE = previousInboxDbFile;
    }
    fs.rmSync(tempInboxDir, { recursive: true, force: true });
    if (previousCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = previousCi;
    }
  });

  it("falls back to sending final message when status updates are rate-limited", async () => {
    await withFastMessageUpdates(async () => {
      const logs = { sends: [], updates: [] } as {
        sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
        updates: Array<{ channelId: string; messageTs: string; text: string }>;
      };
      const im = createFakeIm(logs, { failUpdateWith429: true });
      const { agent } = createFakeAgent({
        delayMs: 5200,
        responseText: "final from agent",
      });
      const runtime = createCoreRuntime({ platform: "slack", im, agent });
      const channelId = uniqueId("CE2E-RES-429");
      const threadId = uniqueId("TE2E-RES-429");

      const context = {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId: "UE2E-429",
        messageId: uniqueId("ME2E-429"),
      };

      await runtime.handleInboundEvent(toInboundEvent({
        channelId: context.channelId,
        threadId: context.threadId,
        userId: context.userId,
        messageId: context.messageId,
        text: "trigger rate limit flow",
      }));
      await waitFor(
        () =>
          logs.sends.some((entry) => entry.text === "final from agent")
          || logs.updates.some((entry) => entry.text === "final from agent"),
        8000
      );

      expect(logs.updates.length).toBeGreaterThan(0);
      expect(
        logs.sends.some((entry) => entry.text === "final from agent")
          || logs.updates.some((entry) => entry.text === "final from agent")
      ).toBe(true);

      deleteSession(context.channelId, context.threadId);
    });
  }, 15000);

  it("reports status update errors and continues on a replacement status message", async () => {
    await withFastMessageUpdates(async () => {
      const logs = { sends: [], updates: [] } as {
        sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
        updates: Array<{ channelId: string; messageTs: string; text: string }>;
      };
      const im = createFakeIm(logs, { failUpdateWithErrorOnce: "socket hang up" });
      const { agent } = createFakeAgent({
        delayMs: 1200,
        responseText: "recovered output",
      });
      const runtime = createCoreRuntime({ platform: "slack", im, agent });
      const channelId = uniqueId("CE2E-RECOVER-STATUS");
      const threadId = uniqueId("TE2E-RECOVER-STATUS");

      await runtime.handleInboundEvent(toInboundEvent({
        channelId,
        threadId,
        userId: "UE2E-recover-status",
        messageId: uniqueId("ME2E-recover-status"),
        text: "trigger status replacement flow",
      }));

      await waitFor(
        () => logs.sends.some((entry) => entry.text.startsWith("Status update failed:")),
        5000
      );

      const fallbackNoticeIndex = logs.sends.findIndex((entry) => entry.text.startsWith("Status update failed:"));
      const fallbackNotice = fallbackNoticeIndex >= 0 ? logs.sends[fallbackNoticeIndex] : undefined;
      expect(fallbackNotice).toBeDefined();

      const replacementStatus = fallbackNoticeIndex >= 0 ? logs.sends[fallbackNoticeIndex + 1] : undefined;
      expect(replacementStatus).toBeDefined();
      expect(logs.updates.some((entry) => entry.messageTs === replacementStatus!.messageTs)).toBe(true);

      deleteSession(channelId, threadId);
    });
  }, 15000);

  it("handles stop race in event-stream mode and still completes gracefully", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
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
    const channelId = uniqueId("CE2E-STOP");
    const threadId = uniqueId("TE2E-STOP");

    const context = {
      channelId,
      replyThreadId: threadId,
      threadId,
      userId: "UE2E-stop",
      messageId: uniqueId("ME2E-stop"),
    };

    await runtime.handleInboundEvent(toInboundEvent({
      channelId: context.channelId,
      threadId: context.threadId,
      userId: context.userId,
      messageId: context.messageId,
      text: "please stop soon",
    }));
    await waitFor(() => logs.sends.some((entry) => entry.text === "_Done_"));

    expect(logs.sends.some((entry) => entry.text === "_Done_")).toBe(true);

    deleteSession(context.channelId, context.threadId);
  });

  it("does not crash when the initial status send throws", async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs, { failInitialSendWith: "socket hang up" });
    const { agent } = createFakeAgent({ responseText: "never mind" });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const channelId = uniqueId("CE2E-INIT-FAIL");
    const threadId = uniqueId("TE2E-INIT-FAIL");

    // Should not throw — initial send failure used to bubble up as an
    // unhandled rejection and abort the whole request silently.
    await expect(
      runtime.handleInboundEvent(toInboundEvent({
        channelId,
        threadId,
        userId: "UE2E-init",
        messageId: uniqueId("ME2E-init"),
        text: "hello",
      }))
    ).resolves.toBeUndefined();

    deleteSession(channelId, threadId);
  }, 10000);

  it("does not crash when the fallback replacement send also fails", async () => {
    await withFastMessageUpdates(async () => {
      const logs = { sends: [], updates: [] } as {
        sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
        updates: Array<{ channelId: string; messageTs: string; text: string }>;
      };
      // First update always 429s → triggers the fallback path. Replacement
      // sends also fail, simulating channel-wide throttle. The tick should
      // absorb the error and keep running.
      const im = createFakeIm(logs, {
        failUpdateWith429: true,
        failReplacementSendWith: "rate_limited",
      });
      const { agent } = createFakeAgent({
        delayMs: 1200,
        responseText: "agent finished anyway",
      });
      const runtime = createCoreRuntime({ platform: "slack", im, agent });

      const channelId = uniqueId("CE2E-FB-FAIL");
      const threadId = uniqueId("TE2E-FB-FAIL");

      await runtime.handleInboundEvent(toInboundEvent({
        channelId,
        threadId,
        userId: "UE2E-fbfail",
        messageId: uniqueId("ME2E-fbfail"),
        text: "channel-wide throttle scenario",
      }));

      // Final agent output should still reach the channel as a new message,
      // proving the tick didn't crash.
      await waitFor(
        () => logs.sends.some((entry) => entry.text === "agent finished anyway"),
        6000,
      );
      expect(logs.sends.some((entry) => entry.text === "agent finished anyway")).toBe(true);

      deleteSession(channelId, threadId);
    });
  }, 15000);

  it("recovers pending in-flight requests after restart", async () => {    await withFastMessageUpdates(async () => {
    const logs = { sends: [], updates: [] } as {
      sends: Array<{ channelId: string; threadId: string; text: string; messageTs: string }>;
      updates: Array<{ channelId: string; messageTs: string; text: string }>;
    };
    const im = createFakeIm(logs);
    const { agent } = createFakeAgent();
    const runtime = createCoreRuntime({ platform: "slack", im, agent });

    const channelId = uniqueId("CE2E-REC");
    const threadId = uniqueId("TE2E-REC");
    const statusTs = uniqueId("STATUS");
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
