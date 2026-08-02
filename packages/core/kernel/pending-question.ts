import {
  clearPendingQuestion,
  isMessageProcessed,
  loadSession,
  markMessageProcessed,
  setPendingQuestion,
  type PendingQuestion,
} from "@/config/local/sessions";
import {
  buildThreadKey,
  recordQuestionReply,
} from "@/config/local/inbox";
import { buildQuestionAnswers, formatSingleQuestionPrompt } from "@/core/runtime/helpers";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import type { RuntimeRequestContext } from "@/core/kernel/request-context";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import { log } from "@/utils";

export async function handlePendingQuestionReply(params: {
  deps: {
    im: IMAdapter;
    agent: AgentAdapter;
  };
  pendingQuestion: PendingQuestion;
  context: RuntimeRequestContext;
  text: string;
}): Promise<boolean> {
  const { deps, pendingQuestion, context, text } = params;

  if (isMessageProcessed(context.channelId, context.threadId, context.messageId)) {
    log.debug("Skipping duplicate question reply", { messageId: context.messageId });
    return true;
  }

  const session = loadSession(context.channelId, context.threadId);
  const threadOwnerUserId = session?.threadOwnerUserId;
  // Synthetic owners (task:/cron:) are claimable by any real human, so
  // don't gate pending-question replies on them.
  if (
    threadOwnerUserId
    && !isSyntheticOwner(threadOwnerUserId)
    && threadOwnerUserId !== context.userId
  ) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    await deps.im.sendMessage(context.channelId, context.replyThreadId, "Please reply with an answer.");
    return true;
  }

  markMessageProcessed(context.channelId, context.threadId, context.messageId);

  const threadKey = buildThreadKey(context.channelId, context.threadId);
  if (pendingQuestion.questionDetailId) {
    try {
      recordQuestionReply({
        threadKey,
        questionDetailId: pendingQuestion.questionDetailId,
        messageId: context.messageId,
        userId: context.userId,
        answerText: trimmed,
      });
    } catch (err) {
      log.warn("Failed to record question_reply detail", {
        threadKey,
        questionDetailId: pendingQuestion.questionDetailId,
        error: String(err),
      });
    }
  }

  const totalQuestions = pendingQuestion.questions.length;
  const previousAnswers = pendingQuestion.collectedAnswers ?? [];
  const nextAnswers = [...previousAnswers, trimmed];
  const nextIndex = nextAnswers.length;

  // Still have more questions to ask — accumulate this answer and post the
  // next question as its own thread reply. This keeps multi-question flows
  // from collapsing into ambiguous "split by newline" territory.
  if (nextIndex < totalQuestions) {
    const updatedPending: PendingQuestion = {
      ...pendingQuestion,
      collectedAnswers: nextAnswers,
    };
    setPendingQuestion(context.channelId, context.threadId, updatedPending);

    try {
      const question = pendingQuestion.questions[nextIndex];
      if (question) {
        const nextPrompt = formatSingleQuestionPrompt(question, nextIndex, totalQuestions);
        await deps.im.sendMessage(context.channelId, context.replyThreadId, nextPrompt);
      }
    } catch (err) {
      log.warn("Failed to send follow-up question", {
        channelId: context.channelId,
        threadId: context.threadId,
        requestId: pendingQuestion.requestId,
        nextIndex,
        error: String(err),
      });
    }
    return true;
  }

  // All answers collected — submit the full batch to the agent.
  try {
    const answers = buildQuestionAnswers(nextAnswers);
    await deps.agent.replyToQuestion({
      requestId: pendingQuestion.requestId,
      sessionId: pendingQuestion.sessionId,
      directory: session?.workingDirectory,
      answers,
    });
    clearPendingQuestion(context.channelId, context.threadId);
    return true;
  } catch (err) {
    log.error("Failed to answer OpenCode question", { error: String(err) });
    await deps.im.sendMessage(
      context.channelId,
      context.replyThreadId,
      "Failed to submit your answer. Please try again."
    );
    return true;
  }
}
