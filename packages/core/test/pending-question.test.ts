import { describe, expect, it } from "bun:test";
import {
  deleteSession,
  getPendingQuestion,
  saveSession,
  setPendingQuestion,
  type PendingQuestion,
} from "@/config/local/sessions";
import { handlePendingQuestionReply } from "../kernel/pending-question";

describe("handlePendingQuestionReply", () => {
  it("accumulates answers across replies and only submits after the last question", async () => {
    const channelId = "CQ-PENDING-1";
    const threadId = "TQ-PENDING-1";
    const userId = "U-OWNER-1";
    const pending: PendingQuestion = {
      requestId: "req-1",
      sessionId: "ses-1",
      askedAt: Date.now(),
      questions: [{ question: "Q1" }, { question: "Q2" }],
      collectedAnswers: [],
    };

    saveSession({
      sessionId: "ses-1",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: userId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingQuestion: pending,
    });
    setPendingQuestion(channelId, threadId, pending);

    const replies: Array<Array<Array<string>>> = [];
    const sentMessages: string[] = [];
    const deps = {
      agent: {
        replyToQuestion: async ({ answers }: { answers: Array<Array<string>> }) => {
          replies.push(answers);
        },
      } as any,
      im: {
        sendMessage: async (_channelId: string, _threadId: string, text: string) => {
          sentMessages.push(text);
          return undefined;
        },
      } as any,
    };

    // First reply — should NOT submit yet, should post Q2 as a new message.
    const firstHandled = await handlePendingQuestionReply({
      deps,
      pendingQuestion: pending,
      context: {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId,
        messageId: "m-first",
      },
      text: "answer one",
    });

    expect(firstHandled).toBe(true);
    expect(replies).toEqual([]);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain("(2/2)");
    expect(sentMessages[0]).toContain("Q2");
    const afterFirst = getPendingQuestion(channelId, threadId);
    expect(afterFirst?.collectedAnswers).toEqual(["answer one"]);

    // Second reply — now submit both answers in one call.
    const secondHandled = await handlePendingQuestionReply({
      deps,
      pendingQuestion: afterFirst!,
      context: {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId,
        messageId: "m-second",
      },
      text: "answer two",
    });

    expect(secondHandled).toBe(true);
    expect(replies).toEqual([[["answer one"], ["answer two"]]]);
    expect(getPendingQuestion(channelId, threadId)).toBeNull();

    deleteSession(channelId, threadId);
  });

  it("submits immediately for single-question flows", async () => {
    const channelId = "CQ-PENDING-SINGLE";
    const threadId = "TQ-PENDING-SINGLE";
    const userId = "U-OWNER-SINGLE";
    const pending: PendingQuestion = {
      requestId: "req-single",
      sessionId: "ses-single",
      askedAt: Date.now(),
      questions: [{ question: "Only question" }],
      collectedAnswers: [],
    };

    saveSession({
      sessionId: "ses-single",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: userId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingQuestion: pending,
    });
    setPendingQuestion(channelId, threadId, pending);

    const replies: Array<Array<Array<string>>> = [];
    const handled = await handlePendingQuestionReply({
      deps: {
        agent: {
          replyToQuestion: async ({ answers }: { answers: Array<Array<string>> }) => {
            replies.push(answers);
          },
        } as any,
        im: {
          sendMessage: async () => undefined,
        } as any,
      },
      pendingQuestion: pending,
      context: {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId,
        messageId: "m-single",
      },
      text: "the answer",
    });

    expect(handled).toBe(true);
    expect(replies).toEqual([[["the answer"]]]);
    expect(getPendingQuestion(channelId, threadId)).toBeNull();

    deleteSession(channelId, threadId);
  });

  it("ignores non-owner replies", async () => {
    const channelId = "CQ-PENDING-2";
    const threadId = "TQ-PENDING-2";
    const ownerUserId = "U-OWNER-2";
    const pending: PendingQuestion = {
      requestId: "req-2",
      sessionId: "ses-2",
      askedAt: Date.now(),
      questions: [{ question: "Q1" }],
    };

    saveSession({
      sessionId: "ses-2",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: ownerUserId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingQuestion: pending,
    });

    const handled = await handlePendingQuestionReply({
      deps: {
        agent: {
          replyToQuestion: async () => {},
        } as any,
        im: {
          sendMessage: async () => undefined,
        } as any,
      },
      pendingQuestion: pending,
      context: {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId: "U-NON-OWNER",
        messageId: `m-${Date.now()}-2`,
      },
      text: "answer",
    });

    expect(handled).toBe(false);
    expect(getPendingQuestion(channelId, threadId)).not.toBeNull();

    deleteSession(channelId, threadId);
  });

  it("lets any real human claim a pending question when owner is synthetic (task:)", async () => {
    const channelId = "CQ-PENDING-3";
    const threadId = "TQ-PENDING-3";
    const replies: Array<Array<Array<string>>> = [];
    const pending: PendingQuestion = {
      requestId: "req-3",
      sessionId: "ses-3",
      askedAt: Date.now(),
      questions: [{ question: "Q1" }],
      collectedAnswers: [],
    };

    saveSession({
      sessionId: "ses-3",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      // Synthetic owner — thread was started by a one-time Task before any
      // human joined. The first real human replier should be allowed in.
      threadOwnerUserId: "task:abc123",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingQuestion: pending,
    });
    setPendingQuestion(channelId, threadId, pending);

    const handled = await handlePendingQuestionReply({
      deps: {
        agent: {
          replyToQuestion: async ({ answers }: { answers: Array<Array<string>> }) => {
            replies.push(answers);
          },
        } as any,
        im: {
          sendMessage: async () => undefined,
        } as any,
      },
      pendingQuestion: pending,
      context: {
        channelId,
        replyThreadId: threadId,
        threadId,
        userId: "U-FIRST-HUMAN",
        messageId: `m-${Date.now()}-3`,
      },
      text: "real answer",
    });

    expect(handled).toBe(true);
    expect(replies).toEqual([[["real answer"]]]);

    deleteSession(channelId, threadId);
  });
});
