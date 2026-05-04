import { describe, expect, it } from "bun:test";
import { extractAskUserQuestionToolUse, replyToQuestion } from "../claude/client";
import { createAgentAdapter } from "../adapter";

const ASSISTANT_WITH_ASK = JSON.stringify({
  type: "assistant",
  message: {
    content: [
      {
        type: "tool_use",
        id: "toolu_test_123",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "How should I access prod DB?",
              header: "Prod access",
              multiSelect: false,
              options: [
                { label: "Run railway login", description: "Re-auth Railway CLI" },
                { label: "Give me PROD_DATABASE_URL", description: "Paste connection string" },
                { label: "I'll run SQL myself", description: "Send me SQL" },
              ],
            },
            {
              question: "How do I filter test users?",
              header: "Filter rules",
              multiSelect: true,
              options: [
                { label: "Strip example.com / test", description: "Common placeholders" },
                { label: "Only example.com", description: "Just that domain" },
                { label: "Pull all, I'll filter", description: "" },
              ],
            },
          ],
        },
      },
    ],
  },
});

const STREAM_WITH_ASK = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
  JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
  }),
  ASSISTANT_WITH_ASK,
  JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_test_123",
          is_error: true,
          content: "Answer questions?",
        },
      ],
    },
  }),
].join("\n");

describe("extractAskUserQuestionToolUse", () => {
  it("returns null when no AskUserQuestion tool_use is present", () => {
    const out = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "hi", session_id: "abc" }),
    ].join("\n");
    expect(extractAskUserQuestionToolUse(out)).toBeNull();
  });

  it("ignores Bash and other tools", () => {
    const out = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    expect(extractAskUserQuestionToolUse(out)).toBeNull();
  });

  it("extracts the AskUserQuestion payload from a fully assembled assistant record", () => {
    const result = extractAskUserQuestionToolUse(STREAM_WITH_ASK);
    expect(result).not.toBeNull();
    expect(result?.toolUseId).toBe("toolu_test_123");
    expect(result?.questions.length).toBe(2);
    const [q1, q2] = result!.questions;
    expect(q1?.question).toBe("How should I access prod DB?");
    expect(q1?.header).toBe("Prod access");
    expect(q1?.multiSelect).toBe(false);
    expect(q1?.options?.map((o) => o.label)).toEqual([
      "Run railway login",
      "Give me PROD_DATABASE_URL",
      "I'll run SQL myself",
    ]);
    expect(q2?.multiSelect).toBe(true);
    expect(q2?.options?.[2]?.description).toBeUndefined();
  });

  it("returns the LAST AskUserQuestion when the model loops", () => {
    const first = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_first",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Old?", options: [{ label: "x" }] }] },
          },
        ],
      },
    });
    const second = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_second",
            name: "AskUserQuestion",
            input: { questions: [{ question: "New?", options: [{ label: "y" }] }] },
          },
        ],
      },
    });
    const result = extractAskUserQuestionToolUse([first, second].join("\n"));
    expect(result?.toolUseId).toBe("toolu_second");
    expect(result?.questions[0]?.question).toBe("New?");
  });

  it("ignores AskUserQuestion tool_use blocks with empty / malformed questions arrays", () => {
    const out = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t", name: "AskUserQuestion", input: { questions: [] } },
          { type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [{}] } },
        ],
      },
    });
    expect(extractAskUserQuestionToolUse(out)).toBeNull();
  });
});

describe("createAgentAdapter().normalizeQuestions for Claude shape", () => {
  it("normalizes Claude AskUserQuestion entries (multiSelect, label, description) to NormalizedQuestion", () => {
    const adapter = createAgentAdapter();
    const claudeQuestions = [
      {
        question: "Pick env",
        header: "env",
        multiSelect: false,
        options: [
          { label: "prod", description: "production" },
          { label: "staging", description: "" },
        ],
      },
      {
        question: "Allow tools",
        multiSelect: true,
        options: [{ label: "Bash" }, { label: "Read" }],
      },
    ];
    const normalized = adapter.normalizeQuestions(claudeQuestions);
    expect(normalized.length).toBe(2);
    expect(normalized[0]?.question).toBe("Pick env");
    expect(normalized[0]?.options).toEqual(["prod", "staging"]);
    expect(normalized[0]?.multiple).toBe(false);
    expect(normalized[1]?.multiple).toBe(true);
    expect(normalized[1]?.options).toEqual(["Bash", "Read"]);
  });

  it("still normalizes OpenCode-style QuestionInfo entries (multiple/options[].label)", () => {
    const adapter = createAgentAdapter();
    const openCodeQuestions = [
      {
        question: "Choose model",
        multiple: false,
        custom: true,
        options: [{ label: "claude" }, { label: "codex" }],
      },
    ];
    const normalized = adapter.normalizeQuestions(openCodeQuestions);
    expect(normalized.length).toBe(1);
    expect(normalized[0]?.question).toBe("Choose model");
    expect(normalized[0]?.options).toEqual(["claude", "codex"]);
    expect(normalized[0]?.multiple).toBe(false);
    expect(normalized[0]?.custom).toBe(true);
  });

  it("drops questions whose prompt text is empty", () => {
    const adapter = createAgentAdapter();
    const normalized = adapter.normalizeQuestions([
      { question: "  ", options: [{ label: "x" }] },
      { question: "ok?", options: [{ label: "y" }] },
    ]);
    expect(normalized.length).toBe(1);
    expect(normalized[0]?.question).toBe("ok?");
  });
});

describe("Claude replyToQuestion guards", () => {
  it("rejects when no AskUserQuestion is pending for the session", async () => {
    await expect(
      replyToQuestion({
        sessionId: "session-with-no-pending-question",
        requestId: "toolu_does_not_exist",
        answers: [["whatever"]],
      })
    ).rejects.toThrow(/No pending Claude question/);
  });
});
