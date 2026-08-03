import { describe, expect, it } from "bun:test";
import { isSyntheticOwner, threadTsField } from "./synthetic-owner";

describe("isSyntheticOwner", () => {
  it("returns true for task: prefix", () => {
    expect(isSyntheticOwner("task:abc123")).toBe(true);
  });

  it("returns true for cron-job: prefix (current cron id scheme)", () => {
    expect(isSyntheticOwner("cron-job:daily-report")).toBe(true);
  });

  it("returns true for legacy cron: prefix", () => {
    expect(isSyntheticOwner("cron:daily")).toBe(true);
  });

  it("returns false for real user ids", () => {
    expect(isSyntheticOwner("U0AUCN52VJ4")).toBe(false);
    expect(isSyntheticOwner("123456789")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isSyntheticOwner(null)).toBe(false);
    expect(isSyntheticOwner(undefined)).toBe(false);
    expect(isSyntheticOwner("")).toBe(false);
  });

  it("only matches as prefix, not substring", () => {
    expect(isSyntheticOwner("prefix-task:abc")).toBe(false);
    expect(isSyntheticOwner("user-cron-job:x")).toBe(false);
  });
});

describe("threadTsField", () => {
  it("preserves a real Slack message timestamp", () => {
    expect(threadTsField("1717000000.000200")).toEqual({
      thread_ts: "1717000000.000200",
    });
  });

  it("omits thread_ts for a cron-job placeholder (ODE-DEAMON-7)", () => {
    const field = threadTsField(
      "cron-job:a86fbdc5-01df-4caf-9e0c-c0c199f00379:1781391600000"
    );
    expect(field).toEqual({});
    expect(field).not.toHaveProperty("thread_ts");
  });

  it("omits thread_ts for task: and legacy cron: placeholders", () => {
    expect(threadTsField("task:abc123")).toEqual({});
    expect(threadTsField("cron:daily")).toEqual({});
  });

  it("omits thread_ts for missing/empty thread ids", () => {
    expect(threadTsField(undefined)).toEqual({});
    expect(threadTsField(null)).toEqual({});
    expect(threadTsField("")).toEqual({});
  });

  it("spreads into a payload without leaving an undefined key", () => {
    const payload = { channel: "C1", ...threadTsField("task:abc") };
    expect(Object.keys(payload)).toEqual(["channel"]);
  });
});
