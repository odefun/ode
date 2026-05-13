import { describe, expect, it } from "bun:test";
import { isTransientClaudeError } from "../claude/client";

describe("isTransientClaudeError", () => {
  it("matches Cloudflare 524 origin timeouts", () => {
    const message =
      'API Error: 524 {"title":"Error 524: A timeout occurred","status":524,"error_name":"origin_response_timeout","cloudflare_error":true,"retryable":true}';
    expect(isTransientClaudeError(new Error(message))).toBe(true);
  });

  it("matches generic Anthropic 5xx", () => {
    expect(isTransientClaudeError(new Error("API Error: 503 service unavailable"))).toBe(true);
    expect(isTransientClaudeError(new Error("API Error: 502 bad gateway"))).toBe(true);
  });

  it("matches the Claude CLI 'session already in use' race", () => {
    const message =
      "Error: Session ID a1c4b262-cb3d-4281-b1c0-6b0128dda381 is already in use.";
    expect(isTransientClaudeError(new Error(message))).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isTransientClaudeError(new Error("Claude returned empty response"))).toBe(false);
    expect(isTransientClaudeError(new Error("API Error: 400 bad request"))).toBe(false);
    expect(isTransientClaudeError(new Error("Permission denied"))).toBe(false);
    expect(isTransientClaudeError(undefined)).toBe(false);
    expect(isTransientClaudeError(null)).toBe(false);
    expect(isTransientClaudeError("")).toBe(false);
  });
});
