import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildThreadKey,
  clearMessageStoreForTests,
  closeMessageDatabaseForTests,
  ensureMessageThread,
  getMessageDetailById,
  getOdeRunEvents,
  startAgentResult,
} from "@/config/local/inbox";
import {
  deleteSession,
  getPendingQuestion,
  saveSession,
} from "@/config/local/sessions";
import type { AgentAdapter, NormalizedQuestion } from "@/core/types";
import {
  categorizeScheduledRunError,
  startScheduledAgentRunObserver,
} from "@/core/runtime/scheduled-agent-run";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-scheduled-observer-test-"));
const inboxDbFile = path.join(tempDir, "inbox.db");

function normalizeQuestions(questions: unknown): NormalizedQuestion[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    if (typeof record.question !== "string") return [];
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option === "string") return [option];
          if (!option || typeof option !== "object") return [];
          const label = (option as Record<string, unknown>).label;
          return typeof label === "string" ? [label] : [];
        })
      : undefined;
    return [{ question: record.question, options }];
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for test condition");
}

describe("scheduled agent run observer", () => {
  beforeAll(() => {
    process.env.ODE_INBOX_DB_FILE = inboxDbFile;
  });

  beforeEach(() => {
    clearMessageStoreForTests();
  });

  afterAll(() => {
    closeMessageDatabaseForTests();
    delete process.env.ODE_INBOX_DB_FILE;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists diagnostics and routes scheduled questions to a real IM thread", async () => {
    const channelId = "C-SCHEDULED-QUESTION";
    const syntheticThreadId = "cron-job:job-1:run-1";
    const realThreadId = "real-thread-1";
    const sessionId = "session-scheduled-1";
    const threadKey = buildThreadKey(channelId, syntheticThreadId);
    ensureMessageThread({
      platform: "slack",
      channelId,
      threadId: syntheticThreadId,
      replyThreadId: syntheticThreadId,
      sessionId,
      providerId: "opencode",
      sourceKind: "cron_job",
    });
    const detail = startAgentResult({
      threadKey,
      requestMessageId: "run-1",
      providerId: "opencode",
    });
    saveSession({
      sessionId,
      providerId: "opencode",
      platform: "slack",
      channelId,
      threadId: syntheticThreadId,
      workingDirectory: "/tmp/repo",
      threadOwnerUserId: "cron-job:job-1",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    let handler: (event: unknown) => void = () => {
      throw new Error("Observer was not subscribed");
    };
    let questionText = "";
    const agent = {
      supportsEventStream: true,
      ensureSession: async () => {},
      getTransportForSession: () => "server-sdk",
      subscribeToSession: (_sessionId: string, next: (event: unknown) => void) => {
        handler = next;
        return () => {
          handler = () => {};
        };
      },
      normalizeQuestions,
      abortSession: async () => {},
    } as unknown as AgentAdapter;

    const observer = await startScheduledAgentRunObserver({
      agent,
      sessionId,
      providerId: "opencode",
      runId: "run-1",
      threadKey,
      syntheticThreadId,
      channelId,
      workingDirectory: "/tmp/repo",
      agentResultDetailId: detail.id,
      requestMessageId: "run-1",
      sendQuestion: async (text) => {
        questionText = text;
        return { messageId: "question-message-1", realThreadId };
      },
      seedRealThread: () => {
        saveSession({
          sessionId,
          providerId: "opencode",
          platform: "slack",
          channelId,
          threadId: realThreadId,
          workingDirectory: "/tmp/repo",
          threadOwnerUserId: "cron-job:job-1",
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
        });
        ensureMessageThread({
          platform: "slack",
          channelId,
          threadId: realThreadId,
          replyThreadId: realThreadId,
          sessionId,
          providerId: "opencode",
          sourceKind: "cron_job",
        });
      },
    });

    handler({
      payload: {
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: sessionId,
          questions: [{ question: "Choose a deployment", options: ["staging", "production"] }],
        },
      },
    });

    await waitUntil(() => Boolean(getPendingQuestion(channelId, realThreadId)));
    expect(questionText).toContain("Choose a deployment");
    expect(getPendingQuestion(channelId, syntheticThreadId)?.requestId).toBe("question-1");
    expect(getPendingQuestion(channelId, realThreadId)?.requestId).toBe("question-1");
    expect(observer.snapshot().pendingInteractions[0]?.question).toBe("Choose a deployment");

    const stored = getMessageDetailById(detail.id);
    expect(stored?.context?.runtimeDiagnostics).toMatchObject({
      sessionId,
      lastEventType: "question.asked",
    });
    expect(getOdeRunEvents({ threadKey, runId: "run-1" }).map((event) => event.type)).toContain(
      "question.requested",
    );

    handler({
      payload: {
        type: "question.replied",
        properties: { requestID: "question-1", sessionID: sessionId },
      },
    });
    await waitUntil(() => getPendingQuestion(channelId, realThreadId) === null);
    expect(observer.snapshot().pendingInteractions).toEqual([]);

    await observer.finish("completed");
    deleteSession(channelId, syntheticThreadId);
    deleteSession(channelId, realThreadId);
  });

  it("does not surface auto-approved external_directory as a question", async () => {
    const channelId = "C-SCHEDULED-AUTO";
    const threadId = "task:task-1";
    const sessionId = "session-scheduled-auto";
    const threadKey = buildThreadKey(channelId, threadId);
    ensureMessageThread({
      platform: "slack",
      channelId,
      threadId,
      replyThreadId: threadId,
      sessionId,
      providerId: "opencode",
      sourceKind: "task",
    });

    let handler: (event: unknown) => void = () => {
      throw new Error("Observer was not subscribed");
    };
    let deliveries = 0;
    const agent = {
      supportsEventStream: true,
      ensureSession: async () => {},
      getTransportForSession: () => "server-sdk",
      subscribeToSession: (_sessionId: string, next: (event: unknown) => void) => {
        handler = next;
        return () => {
          handler = () => {};
        };
      },
      normalizeQuestions,
      abortSession: async () => {},
    } as unknown as AgentAdapter;
    const observer = await startScheduledAgentRunObserver({
      agent,
      sessionId,
      providerId: "opencode",
      runId: "run-auto",
      threadKey,
      syntheticThreadId: threadId,
      channelId,
      workingDirectory: "/tmp/repo",
      requestMessageId: "run-auto",
      sendQuestion: async () => {
        deliveries += 1;
        return { realThreadId: "unused" };
      },
      seedRealThread: () => {},
    });

    handler({
      payload: {
        type: "permission.asked",
        properties: {
          id: "permission-auto",
          sessionID: sessionId,
          permission: "external_directory",
          patterns: ["/tmp/*"],
          odeAutoApproved: true,
        },
      },
    });

    expect(deliveries).toBe(0);
    expect(observer.snapshot().pendingInteractions).toEqual([]);
    expect(getOdeRunEvents({ threadKey, runId: "run-auto" }).map((event) => event.type)).toEqual(
      expect.arrayContaining(["approval.requested", "approval.resolved"]),
    );
    await observer.finish("completed");
  });

  it("turns a generic wall-clock timeout into a last-tool diagnostic", () => {
    expect(categorizeScheduledRunError(new Error("Task agent turn timed out after 1ms"), {
      sessionId: "session-1",
      runId: "run-1",
      lastEventAt: 100,
      lastEventType: "message.part.updated",
      lastTool: {
        name: "read",
        status: "running",
        detail: "/tmp/result.json",
        updatedAt: 100,
      },
      pendingInteractions: [],
    }).message).toBe("Timed out while read was running: /tmp/result.json");
  });
});
