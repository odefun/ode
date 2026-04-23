import { describe, expect, test } from "bun:test";
import {
  DeliveryStats,
  isRateLimitError,
  renderDeliveryStatsForSlack,
} from "./delivery-stats";

describe("DeliveryStats", () => {
  test("records attempts/success/failures per channel and globally", () => {
    const stats = new DeliveryStats();
    stats.recordAttempt({ platform: "slack", channelId: "C1", op: "send" });
    stats.recordSuccess({ platform: "slack", channelId: "C1", op: "send" });
    stats.recordAttempt({ platform: "slack", channelId: "C1", op: "update" });
    stats.recordFailure({
      platform: "slack",
      channelId: "C1",
      op: "update",
      error: new Error("boom"),
    });
    stats.recordAttempt({ platform: "slack", channelId: "C2", op: "update" });
    stats.recordFailure({
      platform: "slack",
      channelId: "C2",
      op: "update",
      error: "ratelimited",
      rateLimited: true,
    });

    const snap = stats.getSnapshot();
    expect(snap.global.send.success).toBe(1);
    expect(snap.global.update.attempts).toBe(2);
    expect(snap.global.update.failure).toBe(2);
    expect(snap.global.update.rateLimited).toBe(1);
    expect(snap.channels).toHaveLength(2);
    expect(snap.recentFailures).toHaveLength(2);
    expect(snap.recentFailures[1]?.rateLimited).toBe(true);
  });

  test("caps recent failures ring buffer at 100", () => {
    const stats = new DeliveryStats();
    for (let i = 0; i < 150; i++) {
      stats.recordFailure({
        platform: "slack",
        channelId: "C1",
        op: "update",
        error: `err-${i}`,
      });
    }
    const snap = stats.getSnapshot();
    expect(snap.recentFailures).toHaveLength(100);
    expect(snap.recentFailures[0]?.error).toBe("err-50");
    expect(snap.recentFailures[99]?.error).toBe("err-149");
  });

  test("tracks retries and retry successes", () => {
    const stats = new DeliveryStats();
    stats.recordAttempt({ platform: "slack", channelId: "C1", op: "update" });
    stats.recordRetry({ platform: "slack", channelId: "C1", op: "update" });
    stats.recordSuccess({
      platform: "slack",
      channelId: "C1",
      op: "update",
      retried: true,
    });
    const snap = stats.getSnapshot();
    expect(snap.global.update.retries).toBe(1);
    expect(snap.global.update.retrySuccess).toBe(1);
    expect(snap.channels[0]?.ops.update.retrySuccess).toBe(1);
  });

  test("reset clears all state", () => {
    const stats = new DeliveryStats();
    stats.recordAttempt({ platform: "slack", channelId: "C1", op: "send" });
    stats.recordFailure({
      platform: "slack",
      channelId: "C1",
      op: "send",
      error: "x",
    });
    stats.reset();
    const snap = stats.getSnapshot();
    expect(snap.channels).toHaveLength(0);
    expect(snap.recentFailures).toHaveLength(0);
    expect(snap.global.send.attempts).toBe(0);
  });

  test("invokes the failure hook with the recorded failure", () => {
    const stats = new DeliveryStats();
    const received: unknown[] = [];
    stats.setFailureHook((failure) => {
      received.push(failure);
    });
    stats.recordFailure({
      platform: "slack",
      channelId: "C1",
      op: "update",
      error: new Error("boom"),
      rateLimited: true,
    });
    expect(received).toHaveLength(1);
    const failure = received[0] as {
      platform: string;
      op: string;
      rateLimited: boolean;
      error: string;
    };
    expect(failure.platform).toBe("slack");
    expect(failure.op).toBe("update");
    expect(failure.rateLimited).toBe(true);
    expect(failure.error).toBe("boom");
  });

  test("failure record includes threadId when provided", () => {
    const stats = new DeliveryStats();
    const received: unknown[] = [];
    stats.setFailureHook((failure) => {
      received.push(failure);
    });
    stats.recordFailure({
      platform: "slack",
      channelId: "C1",
      op: "send",
      error: new Error("invalid_thread_ts"),
      threadId: "task:abc-123",
    });
    expect(received).toHaveLength(1);
    const failure = received[0] as { threadId?: string };
    expect(failure.threadId).toBe("task:abc-123");
  });

  test("failure hook errors do not break recording", () => {
    const stats = new DeliveryStats();
    stats.setFailureHook(() => {
      throw new Error("hook broken");
    });
    expect(() =>
      stats.recordFailure({
        platform: "slack",
        channelId: "C1",
        op: "send",
        error: "x",
      }),
    ).not.toThrow();
    expect(stats.getSnapshot().recentFailures).toHaveLength(1);
  });

  test("renders a slack-friendly snapshot string", () => {
    const stats = new DeliveryStats();
    stats.recordAttempt({ platform: "slack", channelId: "C1", op: "update" });
    stats.recordFailure({
      platform: "slack",
      channelId: "C1",
      op: "update",
      error: "rate_limited",
      rateLimited: true,
    });
    const rendered = renderDeliveryStatsForSlack({
      channelId: "C1",
      platform: "slack",
      snapshot: stats.getSnapshot(),
    });
    expect(rendered).toContain("Delivery stats");
    expect(rendered).toContain("`C1`");
    expect(rendered).toContain("Recent failures");
    expect(rendered).toContain("429");
  });
});

describe("isRateLimitError", () => {
  test("matches common 429 / rate-limit strings", () => {
    expect(isRateLimitError(new Error("status 429"))).toBe(true);
    expect(isRateLimitError(new Error("rate_limited"))).toBe(true);
    expect(isRateLimitError(new Error("ratelimit"))).toBe(true);
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
  });

  test("matches Slack SDK SlackAPIRateLimitedError shape", () => {
    const err = Object.assign(new Error("An API error occurred"), {
      data: { retry_after: 30 },
    });
    expect(isRateLimitError(err)).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isRateLimitError(new Error("not found"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});
