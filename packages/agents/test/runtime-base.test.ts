import { describe, expect, it } from "bun:test";
import { extractErrorFromStdout } from "../runtime/base";

describe("extractErrorFromStdout", () => {
  it("returns undefined for empty input", () => {
    expect(extractErrorFromStdout("")).toBeUndefined();
    expect(extractErrorFromStdout("   ")).toBeUndefined();
  });

  it("extracts the `error` field from the last result record", () => {
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"stream_event","event":{"type":"message_start"}}',
      '{"type":"result","is_error":true,"error":"API Error: 524 origin_response_timeout"}',
    ].join("\n");
    expect(extractErrorFromStdout(stdout)).toBe("API Error: 524 origin_response_timeout");
  });

  it("falls back to the `result` field when `error` is absent", () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","is_error":true,"result":"API Error: 524 timeout occurred"}',
    ].join("\n");
    expect(extractErrorFromStdout(stdout)).toBe("API Error: 524 timeout occurred");
  });

  it("returns the raw record body when only is_error:true is present", () => {
    const stdout = '{"type":"result","is_error":true,"cloudflare_error":true}';
    expect(extractErrorFromStdout(stdout)).toContain("cloudflare_error");
  });

  it("ignores non-JSON noise and prefers the latest structured error", () => {
    const stdout = [
      "warning: something printed by a shell wrapper",
      '{"type":"result","is_error":false,"result":"earlier ok turn"}',
      "bun: trace line",
      '{"type":"result","is_error":true,"error":"API Error: 503"}',
    ].join("\n");
    expect(extractErrorFromStdout(stdout)).toBe("API Error: 503");
  });

  it("falls back to the last non-empty line when no structured error exists", () => {
    const stdout = "hello\nworld\n   \n";
    expect(extractErrorFromStdout(stdout)).toBe("world");
  });

  it("truncates very long fallback lines", () => {
    const long = "x".repeat(2000);
    const result = extractErrorFromStdout(long);
    expect(result?.length).toBeLessThanOrEqual(501);
    expect(result?.endsWith("…")).toBe(true);
  });
});
