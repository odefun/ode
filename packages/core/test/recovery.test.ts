import { describe, expect, it } from "bun:test";
import { clearActiveRequest, createActiveRequest, deleteSession, loadSession, saveSession } from "@/config/local/sessions";
import { recoverPendingRequests } from "../kernel/recovery";

describe("recoverPendingRequests", () => {
  it("updates message and clears recent processing request", async () => {
    const channelId = "CR-1";
    const threadId = "TR-1";
    const statusTs = "123.45";

    const active = createActiveRequest("ses-r1", channelId, threadId, threadId, statusTs, "hello");
    active.startedAt = Date.now() - 60_000;

    saveSession({
      sessionId: "ses-r1",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeRequest: active,
    });

    const updates: string[] = [];
    await recoverPendingRequests({
      updateMessage: async (_channelId: string, _ts: string, text: string) => {
        updates.push(text);
      },
    } as any);

    expect(updates).toContain("_Bot restarted - please resend your message_");
    expect(loadSession(channelId, threadId)?.activeRequest).toBeUndefined();

    deleteSession(channelId, threadId);
  });

  it("clears stale request without update", async () => {
    const channelId = "CR-2";
    const threadId = "TR-2";
    const statusTs = "223.45";

    const active = createActiveRequest("ses-r2", channelId, threadId, threadId, statusTs, "hello");
    active.startedAt = Date.now() - 11 * 60_000;

    saveSession({
      sessionId: "ses-r2",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeRequest: active,
    });

    const updates: string[] = [];
    await recoverPendingRequests({
      updateMessage: async (_channelId: string, _ts: string, text: string) => {
        updates.push(text);
      },
    } as any);

    expect(updates).not.toContain("_Bot restarted - please resend your message_");
    expect(loadSession(channelId, threadId)?.activeRequest).toBeUndefined();

    clearActiveRequest(channelId, threadId);
    deleteSession(channelId, threadId);
  });

  it("does not recover requests created after the startup cutoff", async () => {
    const channelId = "CR-3";
    const threadId = "TR-3";
    const statusTs = "323.45";

    const active = createActiveRequest("ses-r3", channelId, threadId, threadId, statusTs, "hello");
    active.startedAt = Date.now();

    saveSession({
      sessionId: "ses-r3",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      activeRequest: active,
    });

    const updates: string[] = [];
    await recoverPendingRequests({
      updateMessage: async (_channelId: string, _ts: string, text: string) => {
        updates.push(text);
      },
    } as any, undefined, { startedBeforeMs: active.startedAt - 1 });

    expect(updates).toEqual([]);
    expect(loadSession(channelId, threadId)?.activeRequest?.state).toBe("processing");

    clearActiveRequest(channelId, threadId);
    deleteSession(channelId, threadId);
  });
});
