import { afterAll, describe, expect, it } from "bun:test";
import type { SessionEvent } from "@/config/local/redis";
import {
  clearCronJobsForTests,
  closeCronJobDatabaseForTests,
} from "@/config/local/cron-jobs";
import {
  buildThreadKey,
  clearMessageStoreForTests,
  closeMessageDatabaseForTests,
  ensureMessageThread,
  recordOdeRunEvents,
  recordUserPrompt,
  startAgentResult,
  completeAgentResult,
} from "@/config/local/inbox";
import { createOdeRunEvent } from "@/core/runtime/ode-run-events";
import { createWebApp } from "@/core/web/app";
import { collapseTextDeltas } from "@/core/web/session-events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-web-inbox-test-"));
process.env.ODE_INBOX_DB_FILE = path.join(tempDir, "inbox.db");

describe("web app routing", () => {
  it("redirects /local-setting to root", async () => {
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/local-setting"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
  });

  it("redirects /local-setting/* to root-relative path", async () => {
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/local-setting/sessions/abc"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/sessions/abc");
  });

  it("returns 400 for workspace sync without workspaceId", async () => {
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/api/slack-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("Missing workspaceId");
  });

  it("returns 400 for workspace discover without required credentials", async () => {
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/api/slack-discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));

    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error?.startsWith("Missing Slack")).toBe(true);
  });

  it("rejects unknown Computer Gateway actions", async () => {
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/api/computer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "grant-without-consent" }),
    }));
    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("Unknown Computer Gateway action");
  });

  it("returns paginated message threads and a thread's detail timeline", async () => {
    clearMessageStoreForTests();
    const threadKey = buildThreadKey("C-web", "T-web");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-web",
      threadId: "T-web",
      replyThreadId: "T-web",
      providerId: "opencode",
    });
    recordUserPrompt({
      threadKey,
      messageId: "M-web",
      userId: "U-web",
      promptText: "show me the latest build failures",
    });
    const agentDetail = startAgentResult({
      threadKey,
      requestMessageId: "M-web",
      providerId: "opencode",
    });
    completeAgentResult({
      detailId: agentDetail.id,
      resultText: "All builds green.",
    });
    recordOdeRunEvents(threadKey, [
      createOdeRunEvent(
        { providerId: "opencode", sessionId: "session-web", runId: "run-web", timestamp: 10 },
        "run.progress",
        { phase: "Reading tests" },
      ),
      createOdeRunEvent(
        { providerId: "opencode", sessionId: "session-web", runId: "run-web", timestamp: 11 },
        "provider.raw",
        { providerType: "message.part.updated" },
        { rawEvent: { type: "message.part.updated" } },
      ),
    ]);

    const app = createWebApp();
    const listResponse = await app.handle(new Request("http://localhost/api/message-threads?page=1&pageSize=5"));
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json() as {
      ok: boolean;
      result?: {
        total: number;
        items: Array<{ id: string; latestPromptPreview: string | null; latestResultPreview: string | null }>;
      };
    };
    expect(listPayload.ok).toBe(true);
    expect(listPayload.result?.total).toBe(1);
    expect(listPayload.result?.items[0]?.id).toBe(threadKey);
    expect(listPayload.result?.items[0]?.latestPromptPreview).toContain("latest build failures");
    expect(listPayload.result?.items[0]?.latestResultPreview).toContain("All builds green");

    const detailResponse = await app.handle(new Request(`http://localhost/api/message-threads/${encodeURIComponent(threadKey)}`));
    expect(detailResponse.status).toBe(200);
    const detailPayload = await detailResponse.json() as {
      ok: boolean;
      result?: {
        id: string;
        details: Array<{ kind: string; promptText: string | null; resultText: string | null }>;
      };
    };
    expect(detailPayload.ok).toBe(true);
    expect(detailPayload.result?.id).toBe(threadKey);
    const userPrompt = detailPayload.result?.details.find((d) => d.kind === "user_prompt");
    const agentResult = detailPayload.result?.details.find((d) => d.kind === "agent_result");
    expect(userPrompt?.promptText).toBe("show me the latest build failures");
    expect(agentResult?.resultText).toBe("All builds green.");

    const eventsResponse = await app.handle(new Request(
      `http://localhost/api/message-threads/${encodeURIComponent(threadKey)}/events?limit=20`
    ));
    expect(eventsResponse.status).toBe(200);
    const eventsPayload = await eventsResponse.json() as {
      ok: boolean;
      result?: { total: number; items: Array<{ type: string; data: Record<string, unknown> }> };
    };
    expect(eventsPayload.ok).toBe(true);
    expect(eventsPayload.result?.total).toBe(1);
    expect(eventsPayload.result?.items).toEqual([
      expect.objectContaining({ type: "run.progress", data: { phase: "Reading tests" } }),
    ]);
  });

  it("returns cron job list payload", async () => {
    clearCronJobsForTests();
    const app = createWebApp();
    const response = await app.handle(new Request("http://localhost/api/cron-jobs"));
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      ok: boolean;
      result?: {
        jobs: unknown[];
        channels: unknown[];
      };
    };
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.result?.jobs)).toBe(true);
    expect(Array.isArray(payload.result?.channels)).toBe(true);
  });
});

describe("collapseTextDeltas", () => {
  it("keeps only latest text delta for each part id", () => {
    const base = {
      sessionId: "s1",
      channelId: "C1",
      threadId: "T1",
      agentProvider: "opencode",
    };
    const events = [
      {
        ...base,
        timestamp: 1,
        type: "message.part.updated",
        data: { properties: { part: { id: "p1", type: "text", text: "a" } } },
      },
      {
        ...base,
        timestamp: 2,
        type: "message.part.updated",
        data: { properties: { part: { id: "p1", type: "text", text: "ab" } } },
      },
      {
        ...base,
        timestamp: 3,
        type: "tool.started",
        data: { id: "t1" },
      },
      {
        ...base,
        timestamp: 4,
        type: "message.part.updated",
        data: { properties: { part: { id: "p2", type: "text", text: "x" } } },
      },
    ] as SessionEvent[];

    const collapsed = collapseTextDeltas(events);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]?.timestamp).toBe(2);
    expect(collapsed[1]?.type).toBe("tool.started");
    expect(collapsed[2]?.timestamp).toBe(4);
  });
});

afterAll(() => {
  closeCronJobDatabaseForTests();
  closeMessageDatabaseForTests();
  delete process.env.ODE_INBOX_DB_FILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
