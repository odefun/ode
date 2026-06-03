import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Both test groups below import `./api`, which imports `./client`. We mock
// the single `./client` module so we don't need a real Slack connection,
// and expose both the raw `apiCall` surface (used by the streaming helpers)
// and the typed `chat.postMessage` surface (used by `postSlackQuestion`).
const apiCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
const postMessageCalls: Array<Record<string, unknown>> = [];

mock.module("./client", () => ({
  getApp: () => ({
    client: {
      apiCall: async (method: string, args: Record<string, unknown>) => {
        apiCalls.push({ method, args });
        return method === "chat.startStream" ? { ts: "111.222" } : {};
      },
      chat: {
        postMessage: async (args: Record<string, unknown>) => {
          postMessageCalls.push(args);
          return { ok: true, ts: "1700000000.000100" };
        },
      },
    },
  }),
  // `postSlackQuestion` does not call getSlackBotToken; we still export it
  // so the module load doesn't fail when ./api re-imports it.
  getSlackBotToken: () => "xoxb-test",
}));

describe("Slack streaming API helpers", () => {
  beforeEach(() => {
    apiCalls.length = 0;
  });

  it("uses raw apiCall methods for stream lifecycle operations", async () => {
    const { appendSlackStream, startSlackStream, stopSlackStream } = await import("./api");

    const ts = await startSlackStream({
      channelId: "C1",
      threadId: "1700000000.000001",
      recipientUserId: "U1",
      recipientTeamId: "T1",
      seedPlanTitle: "Working",
      token: "xoxb-test",
    });
    await appendSlackStream({
      channelId: "C1",
      messageTs: ts!,
      chunks: [{ type: "plan_update", title: "Still working" }],
      token: "xoxb-test",
    });
    await stopSlackStream({
      channelId: "C1",
      messageTs: ts!,
      token: "xoxb-test",
    });

    expect(apiCalls.map((call) => call.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(apiCalls[0]?.args).toMatchObject({
      channel: "C1",
      thread_ts: "1700000000.000001",
      task_display_mode: "plan",
      recipient_user_id: "U1",
      recipient_team_id: "T1",
      token: "xoxb-test",
    });
    expect(apiCalls[1]?.args).toMatchObject({
      channel: "C1",
      ts: "111.222",
      token: "xoxb-test",
    });
    expect(apiCalls[2]?.args).toMatchObject({
      channel: "C1",
      ts: "111.222",
      token: "xoxb-test",
    });
  });
});

describe("postSlackQuestion thread_ts handling", () => {
  afterEach(() => {
    postMessageCalls.length = 0;
  });

  it("omits thread_ts when the thread id is a synthetic cron-job placeholder", async () => {
    const { postSlackQuestion } = await import("./api");
    await postSlackQuestion({
      channelId: "C0ATGCJ0YK0",
      threadId: "cron-job:a86fbdc5-01df-4caf-9e0c-c0c199f00379:1780441200000",
      question: "Ready to deploy?",
      options: ["Yes", "No"],
      token: "xoxb-test",
    });

    expect(postMessageCalls.length).toBeGreaterThan(0);
    for (const call of postMessageCalls) {
      // Slack rejects synthetic placeholders with `invalid_thread_ts`; the
      // adapter must drop `thread_ts` and fall back to a top-level post.
      expect(call).not.toHaveProperty("thread_ts");
      expect(call.channel).toBe("C0ATGCJ0YK0");
    }
  });

  it("omits thread_ts for synthetic task placeholders too", async () => {
    const { postSlackQuestion } = await import("./api");
    await postSlackQuestion({
      channelId: "C0ATGCJ0YK0",
      threadId: "task:abc-123",
      question: "Continue?",
      token: "xoxb-test",
    });

    expect(postMessageCalls.length).toBeGreaterThan(0);
    for (const call of postMessageCalls) {
      expect(call).not.toHaveProperty("thread_ts");
    }
  });

  it("passes thread_ts through for real Slack timestamps", async () => {
    const { postSlackQuestion } = await import("./api");
    const realTs = "1717000000.000200";
    await postSlackQuestion({
      channelId: "C0ATGCJ0YK0",
      threadId: realTs,
      question: "Ready to deploy?",
      options: ["Yes", "No"],
      token: "xoxb-test",
    });

    expect(postMessageCalls.length).toBeGreaterThan(0);
    for (const call of postMessageCalls) {
      expect(call.thread_ts).toBe(realTs);
    }
  });
});
