import { describe, expect, it } from "bun:test";
import {
  buildFinalResponseText,
  buildQuestionAnswers,
  categorizeRuntimeError,
  formatQuestionPrompt,
  formatSingleQuestionPrompt,
  hasSimpleOptions,
} from "../runtime/helpers";

describe("runtime helpers", () => {
  it("joins non-empty response texts", () => {
    const text = buildFinalResponseText([
      { text: "  first  " },
      { text: "" },
      {},
      { text: "second" },
    ]);

    expect(text).toBe("first\n\nsecond");
  });

  it("returns null for empty response texts", () => {
    const text = buildFinalResponseText([{ text: "   " }, {}]);
    expect(text).toBeNull();
  });

  it("formats multi-question prompts with numbered lines", () => {
    const prompt = formatQuestionPrompt([
      { question: "Pick runtime", options: ["opencode", "claude"] },
      { question: "Need tests?", options: ["yes", "no"] },
    ]);

    expect(prompt).toContain("1. Pick runtime");
    expect(prompt).toContain("Options: opencode / claude");
    expect(prompt).toContain("2. Need tests?");
  });

  it("formats a single-question prompt with i/N prefix in multi-question flows", () => {
    const prompt = formatSingleQuestionPrompt(
      { question: "Need tests?", options: ["yes", "no"] },
      1,
      2
    );

    expect(prompt).toContain("(2/2)");
    expect(prompt).toContain("Need tests?");
    expect(prompt).toContain("Options: yes / no");
  });

  it("omits i/N prefix for single-question flows", () => {
    const prompt = formatSingleQuestionPrompt(
      { question: "Proceed?", options: ["yes", "no"] },
      0,
      1
    );

    expect(prompt).not.toContain("(1/1)");
    expect(prompt.startsWith("Proceed?")).toBe(true);
  });

  it("wraps accumulated answers into the nested shape expected by agents", () => {
    const answers = buildQuestionAnswers(["first", "second", "third"]);

    expect(answers).toEqual([["first"], ["second"], ["third"]]);
  });

  it("categorizes network errors with server override", () => {
    const result = categorizeRuntimeError(new Error("ECONNREFUSED connect failed"));
    expect(result.message).toContain("http://127.0.0.1:4096");
    expect(result.suggestion).toContain("OpenCode server");
  });

  it("categorizes timed out phrasing as timeout", () => {
    const result = categorizeRuntimeError(new Error("Codex CLI timed out"));
    expect(result.message).toBe("Request timed out");
  });

  it("categorizes Anthropic upstream 5xx as upstream timeout", () => {
    const result = categorizeRuntimeError(
      new Error('API Error: 524 {"title":"Error 524: A timeout occurred","cloudflare_error":true}')
    );
    expect(result.message).toBe("Anthropic upstream timeout");
    expect(result.suggestion).toContain("retried once");
  });

  it("categorizes origin_response_timeout as upstream timeout", () => {
    const result = categorizeRuntimeError(
      new Error('something happened with "error_name":"origin_response_timeout"')
    );
    expect(result.message).toBe("Anthropic upstream timeout");
  });

  it("categorizes 'Session ID already in use' as session busy", () => {
    const result = categorizeRuntimeError(
      new Error("Error: Session ID a1c4b262-cb3d-4281-b1c0-6b0128dda381 is already in use.")
    );
    expect(result.message).toBe("Session is busy");
    expect(result.suggestion).toContain("Wait a moment");
  });

  describe("hasSimpleOptions", () => {
    it("accepts 2-5 short options", () => {
      expect(hasSimpleOptions(["yes", "no"])).toBe(true);
      expect(hasSimpleOptions(["a", "b", "c", "d", "e"])).toBe(true);
    });

    it("rejects fewer than 2 or more than 5 options", () => {
      expect(hasSimpleOptions(["only"])).toBe(false);
      expect(hasSimpleOptions(["a", "b", "c", "d", "e", "f"])).toBe(false);
      expect(hasSimpleOptions(undefined)).toBe(false);
      expect(hasSimpleOptions([])).toBe(false);
    });

    it("rejects labels longer than 75 characters", () => {
      // 75 is allowed; 76 is not (Slack button text hard limit is 75).
      expect(hasSimpleOptions(["short", "a".repeat(75)])).toBe(true);
      expect(hasSimpleOptions(["short", "a".repeat(76)])).toBe(false);
      // Realistic medium-length labels (previously rejected at 15) now pass.
      expect(hasSimpleOptions(["Push to PR 98", "Leave uncommitted", "Commit but don't push"])).toBe(true);
    });

    it("rejects labels containing newlines", () => {
      expect(hasSimpleOptions(["yes", "no\nmaybe"])).toBe(false);
      expect(hasSimpleOptions(["yes", "no\r\nmaybe"])).toBe(false);
    });

    it("rejects empty/whitespace-only labels", () => {
      expect(hasSimpleOptions(["yes", ""])).toBe(false);
      expect(hasSimpleOptions(["yes", "   "])).toBe(false);
    });
  });
});
