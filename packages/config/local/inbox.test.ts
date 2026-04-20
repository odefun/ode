import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildThreadKey,
  clearMessageStoreForTests,
  closeMessageDatabaseForTests,
  completeAgentQuestion,
  completeAgentResult,
  ensureMessageThread,
  failAgentResult,
  getMessageThreadById,
  getMessageThreadPage,
  recordAgentQuestion,
  recordQuestionReply,
  recordUserPrompt,
  startAgentResult,
} from "@/config/local/inbox";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-inbox-test-"));
const inboxDbFile = path.join(tempDir, "inbox.db");

describe("local inbox store", () => {
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

  it("records a user thread + prompt + agent result end-to-end", () => {
    const threadKey = buildThreadKey("C-inbox", "T-inbox");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-inbox",
      rawChannelId: "workspace-1::C-inbox",
      threadId: "T-inbox",
      replyThreadId: "T-inbox",
      sessionId: "session-inbox",
      providerId: "codex",
      model: "openai/gpt-5.4",
      workingDirectory: "/tmp/ode-inbox",
      threadOwnerUserId: "U-inbox",
      branchName: "main",
      sourceKind: "user",
      context: { isFirstMessageInThread: true },
    });
    recordUserPrompt({
      threadKey,
      messageId: "M-inbox",
      userId: "U-inbox",
      promptText: "Please summarize the release notes and list the most important changes.",
    });
    const agentDetail = startAgentResult({
      threadKey,
      requestMessageId: "M-inbox",
      providerId: "codex",
      model: "openai/gpt-5.4",
      workingDirectory: "/tmp/ode-inbox",
    });
    completeAgentResult({
      detailId: agentDetail.id,
      resultText: "Summary: feature A shipped, feature B changed behavior, and feature C was removed.",
    });

    const page = getMessageThreadPage({ page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(threadKey);
    expect(page.items[0]?.sourceKind).toBe("user");
    expect(page.items[0]?.cronJobId).toBeNull();
    expect(page.items[0]?.providerId).toBe("codex");
    expect(page.items[0]?.model).toBe("openai/gpt-5.4");
    expect(page.items[0]?.detailCount).toBe(2);
    expect(page.items[0]?.pendingDetailCount).toBe(0);
    expect(page.items[0]?.latestResultPreview?.includes("feature A shipped")).toBe(true);

    const detail = getMessageThreadById(threadKey);
    expect(detail).not.toBeNull();
    expect(detail?.details.length).toBe(2);
    const userPrompt = detail?.details.find((d) => d.kind === "user_prompt");
    const agentResult = detail?.details.find((d) => d.kind === "agent_result");
    expect(userPrompt?.promptText).toContain("release notes");
    expect(agentResult?.resultText).toContain("feature C was removed");
    expect(agentResult?.status).toBe("completed");
    expect(detail?.context?.isFirstMessageInThread).toBe(true);
  });

  it("records cron job source metadata at the thread level", () => {
    const threadKey = buildThreadKey("C-cron", "cron-job:job-1");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-cron",
      threadId: "cron-job:job-1",
      replyThreadId: "cron-job:job-1",
      sourceKind: "cron_job",
      cronJobId: "job-1",
      cronJobTitle: "Morning Sync",
    });
    recordUserPrompt({
      threadKey,
      messageId: "123",
      userId: "cron-job:job-1",
      promptText: "summarize overnight alerts",
    });

    const detail = getMessageThreadById(threadKey);
    expect(detail).not.toBeNull();
    expect(detail?.sourceKind).toBe("cron_job");
    expect(detail?.cronJobId).toBe("job-1");
    expect(detail?.cronJobTitle).toBe("Morning Sync");
  });

  it("records one-time task source metadata at the thread level", () => {
    const threadKey = buildThreadKey("C-task", "task:task-42");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-task",
      threadId: "task:task-42",
      replyThreadId: "task:task-42",
      sourceKind: "task",
      taskId: "task-42",
      taskTitle: "Check deploy status after 1h",
    });
    recordUserPrompt({
      threadKey,
      messageId: "1234",
      userId: "task:task-42",
      promptText: "ping deploy status",
    });

    const detail = getMessageThreadById(threadKey);
    expect(detail).not.toBeNull();
    expect(detail?.sourceKind).toBe("task");
    expect(detail?.taskId).toBe("task-42");
    expect(detail?.taskTitle).toBe("Check deploy status after 1h");

    const page = getMessageThreadPage({ page: 1, pageSize: 10 });
    const summary = page.items.find((item) => item.id === threadKey);
    expect(summary?.sourceKind).toBe("task");
    expect(summary?.taskId).toBe("task-42");
    expect(summary?.taskTitle).toBe("Check deploy status after 1h");
  });

  it("preserves task/cron source_kind when a later ensureMessageThread call defaults to user", () => {
    // Simulates the bug where a synthetic task thread was later re-ensured
    // through a path (e.g. runtime-facade) that hardcodes sourceKind: "user".
    const taskThreadKey = buildThreadKey("C-preserve", "task:task-99");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "task:task-99",
      replyThreadId: "task:task-99",
      sourceKind: "task",
      taskId: "task-99",
      taskTitle: "do the thing later",
    });

    // Second call without explicit sourceKind (defaults to "user") must NOT
    // clobber the more specific "task" source already persisted.
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "task:task-99",
      replyThreadId: "task:task-99",
    });

    const taskDetail = getMessageThreadById(taskThreadKey);
    expect(taskDetail?.sourceKind).toBe("task");
    expect(taskDetail?.taskId).toBe("task-99");
    expect(taskDetail?.taskTitle).toBe("do the thing later");

    // Same protection for cron_job.
    const cronThreadKey = buildThreadKey("C-preserve", "cron-job:job-99");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "cron-job:job-99",
      replyThreadId: "cron-job:job-99",
      sourceKind: "cron_job",
      cronJobId: "job-99",
      cronJobTitle: "nightly cron",
    });
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "cron-job:job-99",
      replyThreadId: "cron-job:job-99",
      sourceKind: "user",
    });
    const cronDetail = getMessageThreadById(cronThreadKey);
    expect(cronDetail?.sourceKind).toBe("cron_job");
    expect(cronDetail?.cronJobId).toBe("job-99");

    // Sanity check: a plain user thread upgraded to task still reflects the
    // more specific value (upgrades user -> task are allowed).
    const upgradeKey = buildThreadKey("C-preserve", "T-upgrade");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "T-upgrade",
      replyThreadId: "T-upgrade",
    });
    ensureMessageThread({
      platform: "slack",
      channelId: "C-preserve",
      threadId: "T-upgrade",
      replyThreadId: "T-upgrade",
      sourceKind: "task",
      taskId: "task-upgrade",
    });
    const upgraded = getMessageThreadById(upgradeKey);
    expect(upgraded?.sourceKind).toBe("task");
    expect(upgraded?.taskId).toBe("task-upgrade");
  });

  it("captures a full question → reply → answer batch timeline", () => {
    const threadKey = buildThreadKey("C-q", "T-q");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-q",
      threadId: "T-q",
      replyThreadId: "T-q",
      sessionId: "ses-q",
      providerId: "opencode",
    });
    recordUserPrompt({ threadKey, messageId: "M-prompt", userId: "U", promptText: "help me decide" });
    const agent = startAgentResult({ threadKey, requestMessageId: "M-prompt" });
    const question = recordAgentQuestion({
      threadKey,
      requestMessageId: "M-prompt",
      questionRequestId: "q-1",
      questions: [
        { question: "step?", options: ["a", "b"] },
        { question: "commit?", options: ["y", "n"] },
      ],
    });
    recordQuestionReply({
      threadKey,
      questionDetailId: question.id,
      messageId: "M-reply-1",
      userId: "U",
      answerText: "a",
    });
    recordQuestionReply({
      threadKey,
      questionDetailId: question.id,
      messageId: "M-reply-2",
      userId: "U",
      answerText: "y",
    });
    completeAgentQuestion({ detailId: question.id });
    completeAgentResult({ detailId: agent.id, resultText: "all done" });

    const detail = getMessageThreadById(threadKey);
    expect(detail?.details.length).toBe(5);
    const kinds = detail?.details.map((d) => d.kind);
    expect(kinds).toEqual([
      "user_prompt",
      "agent_result",
      "agent_question",
      "question_reply",
      "question_reply",
    ]);
    const replies = detail?.details.filter((d) => d.kind === "question_reply") ?? [];
    expect(replies.map((r) => r.questionSourceId)).toEqual([question.id, question.id]);
    expect(replies.map((r) => r.promptText)).toEqual(["a", "y"]);
    const completedAgent = detail?.details.find((d) => d.kind === "agent_result");
    expect(completedAgent?.status).toBe("completed");
    expect(completedAgent?.resultText).toBe("all done");
    const completedQuestion = detail?.details.find((d) => d.kind === "agent_question");
    expect(completedQuestion?.status).toBe("completed");
    expect(completedQuestion?.endTime).not.toBeNull();
  });

  it("marks a failing agent result as failed with error text", () => {
    const threadKey = buildThreadKey("C-fail", "T-fail");
    ensureMessageThread({
      platform: "slack",
      channelId: "C-fail",
      threadId: "T-fail",
      replyThreadId: "T-fail",
    });
    recordUserPrompt({ threadKey, messageId: "M-fail", userId: "U", promptText: "make this blow up" });
    const agent = startAgentResult({ threadKey, requestMessageId: "M-fail" });
    failAgentResult({ detailId: agent.id, errorText: "boom" });

    const detail = getMessageThreadById(threadKey);
    const agentDetail = detail?.details.find((d) => d.kind === "agent_result");
    expect(agentDetail?.status).toBe("failed");
    expect(agentDetail?.errorText).toBe("boom");
  });

  it("retains at most the most recent 100 threads", () => {
    // Write 105 threads with monotonic last_message_at so the oldest drop out.
    for (let i = 0; i < 105; i++) {
      const threadKey = buildThreadKey("C-retention", `T-${i}`);
      ensureMessageThread({
        platform: "slack",
        channelId: "C-retention",
        threadId: `T-${i}`,
        replyThreadId: `T-${i}`,
      });
      recordUserPrompt({ threadKey, messageId: `M-${i}`, userId: "U", promptText: `prompt ${i}` });
    }

    const page = getMessageThreadPage({ page: 1, pageSize: 200 });
    expect(page.total).toBe(100);
    // The oldest 5 threads (T-0..T-4) should have been pruned along with
    // their details.
    expect(getMessageThreadById(buildThreadKey("C-retention", "T-0"))).toBeNull();
    expect(getMessageThreadById(buildThreadKey("C-retention", "T-104"))).not.toBeNull();
  });
});
