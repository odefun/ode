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
    getOrCreateSession: async () => ({ sessionId: "session-resilience", created: true }),
    sendMessage: async (_channelId, _sessionId, message) => {
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
    ambientMode: false,
    rawText: params.text,
    normalizedText: params.text,
    receivedAtMs: Date.now(),
  };
}

describe("core runtime resilience e2e", () => {
  const previousCi = process.env.CI;
  const previousInboxDbFile = process.env.ODE_INBOX_DB_FILE;
  const previousSlackStatusStreaming = process.env.ODE_SLACK_STATUS_STREAMING;

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
    if (previousSlackStatusStreaming === undefined) {
      delete process.env.ODE_SLACK_STATUS_STREAMING;
    } else {
      process.env.ODE_SLACK_STATUS_STREAMING = previousSlackStatusStreaming;
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

  it("preserves full error status after stopping an active status stream", async () => {
    process.env.ODE_SLACK_STATUS_STREAMING = "1";
    const logs = {
      sends: [] as Array<{ channelId: string; threadId: string; text: string; messageTs: string }>,
      updates: [] as Array<{ channelId: string; messageTs: string; text: string }>,
      appends: [] as Array<{ channelId: string; messageTs: string; chunks: unknown[] }>,
      stops: [] as Array<{ channelId: string; messageTs: string }>,
      events: [] as string[],
    };
    let nextTs = 0;
    const streamTs = "stream-1";
    const im: IMAdapter = {
      sendMessage: async (channelId, threadId, text) => {
        nextTs += 1;
        const messageTs = `ts-${nextTs}`;
        logs.events.push(`send:${text}`);
        logs.sends.push({ channelId, threadId, text, messageTs });
        return messageTs;
      },
      updateMessage: async (channelId, messageTs, text) => {
        logs.updates.push({ channelId, messageTs, text });
        if (messageTs === streamTs) {
          throw new Error("streaming_state_conflict");
        }
      },
      deleteMessage: async () => {},
      fetchThreadHistory: async () => null,
      buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
      startStatusStream: async () => streamTs,
      appendStatusStream: async (channelId, messageTs, chunks) => {
        logs.appends.push({ channelId, messageTs, chunks });
      },
      stopStatusStream: async (channelId, messageTs) => {
        logs.events.push(`stop:${messageTs}`);
        logs.stops.push({ channelId, messageTs });
      },
    };
    const { agent } = createFakeAgent({
      supportsEventStream: true,
      errorMessage: "tool exploded with full details",
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const channelId = uniqueId("CE2E-STREAM-ERR");
    const threadId = uniqueId("TE2E-STREAM-ERR");

    await runtime.handleInboundEvent(toInboundEvent({
      channelId,
      threadId,
      userId: "UE2E-stream-err",
      messageId: uniqueId("ME2E-stream-err"),
      text: "trigger streaming error",
    }));

    await waitFor(
      () => logs.sends.some((entry) => entry.text.includes("Error: tool exploded with full details")),
      5000
    );

    const errorMessage = logs.sends.find((entry) => entry.text.includes("Error: tool exploded with full details"));
    expect(errorMessage?.text).toContain("_If this persists, try starting a new thread or contact support._");
    expect(logs.stops).toEqual([{ channelId, messageTs: streamTs }]);
    expect(logs.updates.some((entry) => entry.messageTs === streamTs)).toBe(false);
    expect(logs.events.indexOf(`stop:${streamTs}`)).toBeLessThan(
      logs.events.findIndex((entry) => entry.startsWith("send:Error: tool exploded"))
    );

    deleteSession(channelId, threadId);
  });

  it("keeps persisted stream state active when stopStream fails during finalization", async () => {
    process.env.ODE_SLACK_STATUS_STREAMING = "1";
    const streamTs = "stream-stop-fail";
    const logs = {
      sends: [] as Array<{ channelId: string; threadId: string; text: string; messageTs: string }>,
      appends: [] as Array<{ channelId: string; messageTs: string; chunks: unknown[] }>,
      stops: [] as Array<{ channelId: string; messageTs: string }>,
      deletes: [] as Array<{ channelId: string; messageTs: string }>,
    };
    let nextTs = 0;
    const im: IMAdapter = {
      sendMessage: async (channelId, threadId, text) => {
        nextTs += 1;
        const messageTs = `ts-${nextTs}`;
        logs.sends.push({ channelId, threadId, text, messageTs });
        return messageTs;
      },
      updateMessage: async () => {},
      deleteMessage: async (channelId, messageTs) => {
        logs.deletes.push({ channelId, messageTs });
        if (messageTs === streamTs) {
          throw new Error("streaming_state_conflict");
        }
      },
      fetchThreadHistory: async () => null,
      buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
      startStatusStream: async () => streamTs,
      appendStatusStream: async (channelId, messageTs, chunks) => {
        logs.appends.push({ channelId, messageTs, chunks });
      },
      stopStatusStream: async (channelId, messageTs) => {
        logs.stops.push({ channelId, messageTs });
        throw new Error("temporarily_unavailable");
      },
    };
    const { agent } = createFakeAgent({
      supportsEventStream: true,
      responseText: "finished despite stop failure",
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const channelId = uniqueId("CE2E-STREAM-STOP-FAIL");
    const threadId = uniqueId("TE2E-STREAM-STOP-FAIL");

    await runtime.handleInboundEvent(toInboundEvent({
      channelId,
      threadId,
      userId: "UE2E-stream-stop-fail",
      messageId: uniqueId("ME2E-stream-stop-fail"),
      text: "trigger streaming stop failure",
    }));

    await waitFor(
      () => logs.sends.some((entry) => entry.text === "finished despite stop failure"),
      5000
    );

    const savedRequest = loadSession(channelId, threadId)?.activeRequest;
    expect(logs.stops).toEqual([{ channelId, messageTs: streamTs }]);
    expect(logs.deletes).toContainEqual({ channelId, messageTs: streamTs });
    expect(savedRequest?.statusStreamActive).toBe(true);
    expect(savedRequest?.statusStreamTs).toBe(streamTs);

    deleteSession(channelId, threadId);
  });

  it("recreates the Slack AI card when append finds a stale stream", async () => {
    process.env.ODE_SLACK_STATUS_STREAMING = "1";
    const logs = {
      sends: [] as Array<{ channelId: string; threadId: string; text: string; messageTs: string }>,
      starts: [] as Array<{ channelId: string; threadId: string; messageTs: string }>,
      appends: [] as Array<{ channelId: string; messageTs: string; chunks: unknown[] }>,
      stops: [] as Array<{ channelId: string; messageTs: string }>,
      deletes: [] as Array<{ channelId: string; messageTs: string }>,
    };
    let nextSendTs = 0;
    let nextStreamTs = 0;
    let failedFirstAppend = false;
    const im: IMAdapter = {
      sendMessage: async (channelId, threadId, text) => {
        nextSendTs += 1;
        const messageTs = `ts-${nextSendTs}`;
        logs.sends.push({ channelId, threadId, text, messageTs });
        return messageTs;
      },
      updateMessage: async () => {},
      deleteMessage: async (channelId, messageTs) => {
        logs.deletes.push({ channelId, messageTs });
      },
      fetchThreadHistory: async () => null,
      buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
      startStatusStream: async (channelId, threadId) => {
        nextStreamTs += 1;
        const messageTs = `stream-${nextStreamTs}`;
        logs.starts.push({ channelId, threadId, messageTs });
        return messageTs;
      },
      appendStatusStream: async (channelId, messageTs, chunks) => {
        if (!failedFirstAppend && messageTs === "stream-1") {
          failedFirstAppend = true;
          throw new Error("message_not_in_streaming_state");
        }
        logs.appends.push({ channelId, messageTs, chunks });
      },
      stopStatusStream: async (channelId, messageTs) => {
        logs.stops.push({ channelId, messageTs });
      },
    };
    const { agent } = createFakeAgent({
      supportsEventStream: true,
      emitToolEvent: true,
      streamStopAfterMs: 2500,
      delayMs: 2600,
      responseText: "finished after stream recreation",
    });
    const runtime = createCoreRuntime({ platform: "slack", im, agent });
    const channelId = uniqueId("CE2E-STREAM-STALE");
    const threadId = uniqueId("TE2E-STREAM-STALE");

    await runtime.handleInboundEvent(toInboundEvent({
      channelId,
      threadId,
      userId: "UE2E-stream-stale",
      messageId: uniqueId("ME2E-stream-stale"),
      text: "trigger stale stream recovery",
    }));

    await waitFor(
      () => logs.stops.some((entry) => entry.messageTs === "stream-2"),
      5000
    );

    expect(logs.starts.map((entry) => entry.messageTs)).toEqual(["stream-1", "stream-2"]);
    expect(logs.deletes).toContainEqual({ channelId, messageTs: "stream-1" });
    expect(logs.appends.some((entry) => entry.messageTs === "stream-2")).toBe(true);
    const stream2Chunks = logs.appends
      .filter((entry) => entry.messageTs === "stream-2")
      .flatMap((entry) => entry.chunks);
    expect(stream2Chunks).toContainEqual(expect.objectContaining({
      id: "result",
      status: "complete",
      title: "Result",
      type: "task_update",
    }));
    expect(logs.stops).toContainEqual({ channelId, messageTs: "stream-2" });

    deleteSession(channelId, threadId);
  }, 10_000);

  it("cleans up a replacement Slack AI card when seeding it fails", async () => {
    await withMessageUpdateInterval(5_000, async () => {
      process.env.ODE_SLACK_STATUS_STREAMING = "1";
      const logs = {
        sends: [] as Array<{ channelId: string; threadId: string; text: string; messageTs: string }>,
        starts: [] as Array<{ channelId: string; threadId: string; messageTs: string }>,
        appends: [] as Array<{ channelId: string; messageTs: string; chunks: unknown[] }>,
        stops: [] as Array<{ channelId: string; messageTs: string }>,
        deletes: [] as Array<{ channelId: string; messageTs: string }>,
        updates: [] as Array<{ channelId: string; messageTs: string; text: string }>,
      };
      let nextSendTs = 0;
      let nextStreamTs = 0;
      let failedFirstAppend = false;
      const im: IMAdapter = {
        sendMessage: async (channelId, threadId, text) => {
          nextSendTs += 1;
          const messageTs = `ts-${nextSendTs}`;
          logs.sends.push({ channelId, threadId, text, messageTs });
          return messageTs;
        },
        updateMessage: async (channelId, messageTs, text) => {
          logs.updates.push({ channelId, messageTs, text });
        },
        deleteMessage: async (channelId, messageTs) => {
          logs.deletes.push({ channelId, messageTs });
        },
        fetchThreadHistory: async () => null,
        buildAgentContext: async () => ({ slack: { channelId: "C", threadId: "T", userId: "U" } }),
        startStatusStream: async (channelId, threadId) => {
          nextStreamTs += 1;
          const messageTs = `stream-${nextStreamTs}`;
          logs.starts.push({ channelId, threadId, messageTs });
          return messageTs;
        },
        appendStatusStream: async (channelId, messageTs, chunks) => {
          if (!failedFirstAppend && messageTs === "stream-1") {
            failedFirstAppend = true;
            throw new Error("message_not_in_streaming_state");
          }
          if (messageTs === "stream-2") {
            throw new Error("rate_limited while seeding replacement stream");
          }
          logs.appends.push({ channelId, messageTs, chunks });
        },
        stopStatusStream: async (channelId, messageTs) => {
          logs.stops.push({ channelId, messageTs });
        },
      };
      const { agent } = createFakeAgent({
        supportsEventStream: true,
        emitToolEvent: true,
        streamStopAfterMs: 2500,
        delayMs: 3800,
        responseText: "finished after replacement fallback",
      });
      const runtime = createCoreRuntime({ platform: "slack", im, agent });
      const channelId = uniqueId("CE2E-STREAM-SEED-FAIL");
      const threadId = uniqueId("TE2E-STREAM-SEED-FAIL");

      await runtime.handleInboundEvent(toInboundEvent({
        channelId,
        threadId,
        userId: "UE2E-stream-seed-fail",
        messageId: uniqueId("ME2E-stream-seed-fail"),
        text: "trigger replacement stream seed failure",
      }));

      await waitFor(() => {
        const savedRequest = loadSession(channelId, threadId)?.activeRequest;
        return Boolean(
          savedRequest?.statusStreamActive === false &&
            savedRequest.statusMessageTs &&
            logs.sends.some((entry) => entry.messageTs === savedRequest.statusMessageTs)
        );
      }, 12_000);

      const savedRequest = loadSession(channelId, threadId)?.activeRequest;
      const fallbackMessage = logs.sends.find(
        (entry) => entry.messageTs === savedRequest?.statusMessageTs
      );
      await sleep(1_200);
      expect(logs.starts.map((entry) => entry.messageTs)).toEqual(["stream-1", "stream-2"]);
      expect(logs.deletes).toContainEqual({ channelId, messageTs: "stream-1" });
      expect(logs.stops).toContainEqual({ channelId, messageTs: "stream-2" });
      expect(logs.deletes).toContainEqual({ channelId, messageTs: "stream-2" });
      expect(savedRequest?.statusStreamActive).toBe(false);
      expect(savedRequest?.statusStreamTs).toBeUndefined();
      expect(fallbackMessage).toBeDefined();
      expect(logs.updates.some((entry) => entry.messageTs === fallbackMessage?.messageTs)).toBe(false);

      deleteSession(channelId, threadId);
    });
  }, 20_000);

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
