import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "@/utils";
import { isRateLimitError as sharedIsRateLimitError } from "@/shared/delivery/rate-limit";

export { getRetryAfterMs } from "@/shared/delivery/rate-limit";

/**
 * Process-wide observability for IM message delivery.
 *
 * This module is intentionally decoupled from Slack/Discord/Lark adapters so
 * each platform client can record attempts/success/failures in one place and
 * we can surface the data via a slash-style command or a JSON dump.
 *
 * Rationale: previously non-429 `chat.update` failures were swallowed at
 * DEBUG log level in `packages/ims/slack/client.ts:performSlackMessageUpdate`,
 * and `sendMessage` / `deleteMessage` had no retries or metrics. That made
 * "status message disappeared" bugs essentially invisible. This gives us a
 * baseline signal before we add retry / adaptive backoff.
 */

export type DeliveryPlatform = "slack" | "discord" | "lark";
export type DeliveryOp = "send" | "update" | "delete";

export type DeliveryCounters = {
  attempts: number;
  success: number;
  failure: number;
  rateLimited: number;
  retries: number;
  retrySuccess: number;
};

export type ChannelDeliveryStats = {
  platform: DeliveryPlatform;
  processorId?: string;
  channelId: string;
  ops: Record<DeliveryOp, DeliveryCounters>;
  lastFailureAt?: number;
  lastFailureError?: string;
  lastSuccessAt?: number;
};

export type FailureRecord = {
  timestamp: number;
  platform: DeliveryPlatform;
  processorId?: string;
  channelId: string;
  /**
   * The thread identifier the adapter tried to post into, if the op was a
   * threaded send. Useful for diagnosing `invalid_thread_ts` / routing bugs
   * where the caller hands the adapter a synthetic or malformed thread id.
   * Only set when the op actually targets a thread; top-level channel sends
   * and update/delete ops leave this undefined.
   */
  threadId?: string;
  op: DeliveryOp;
  error: string;
  rateLimited: boolean;
  messageTs?: string;
};

export type DeliveryStatsSnapshot = {
  capturedAt: number;
  global: Record<DeliveryOp, DeliveryCounters>;
  channels: ChannelDeliveryStats[];
  recentFailures: FailureRecord[];
};

const MAX_RECENT_FAILURES = 100;
const DEFAULT_THROTTLE_MS = 60_000;

const OPS: readonly DeliveryOp[] = ["send", "update", "delete"];

function emptyCounters(): DeliveryCounters {
  return {
    attempts: 0,
    success: 0,
    failure: 0,
    rateLimited: 0,
    retries: 0,
    retrySuccess: 0,
  };
}

function emptyOpCounters(): Record<DeliveryOp, DeliveryCounters> {
  return {
    send: emptyCounters(),
    update: emptyCounters(),
    delete: emptyCounters(),
  };
}

function buildKey(platform: DeliveryPlatform, channelId: string, processorId?: string): string {
  return `${platform}|${processorId ?? "default"}|${channelId}`;
}

export class DeliveryStats {
  private readonly channels = new Map<string, ChannelDeliveryStats>();
  private readonly global = emptyOpCounters();
  private readonly recentFailures: FailureRecord[] = [];
  private readonly throttleState = new Map<string, number>();
  private failureHook: ((failure: FailureRecord) => void) | undefined;

  /**
   * Register a callback invoked on every recorded failure. Used by the core
   * layer to forward failures to Sentry without this module taking a direct
   * dependency on observability infrastructure.
   */
  setFailureHook(hook: ((failure: FailureRecord) => void) | undefined): void {
    this.failureHook = hook;
  }

  recordAttempt(params: {
    platform: DeliveryPlatform;
    channelId: string;
    op: DeliveryOp;
    processorId?: string;
  }): void {
    const channel = this.ensureChannel(params.platform, params.channelId, params.processorId);
    channel.ops[params.op].attempts += 1;
    this.global[params.op].attempts += 1;
  }

  recordSuccess(params: {
    platform: DeliveryPlatform;
    channelId: string;
    op: DeliveryOp;
    processorId?: string;
    retried?: boolean;
  }): void {
    const channel = this.ensureChannel(params.platform, params.channelId, params.processorId);
    channel.ops[params.op].success += 1;
    this.global[params.op].success += 1;
    channel.lastSuccessAt = Date.now();
    if (params.retried) {
      channel.ops[params.op].retrySuccess += 1;
      this.global[params.op].retrySuccess += 1;
    }
  }

  recordFailure(params: {
    platform: DeliveryPlatform;
    channelId: string;
    op: DeliveryOp;
    error: unknown;
    rateLimited?: boolean;
    processorId?: string;
    messageTs?: string;
    threadId?: string;
  }): void {
    const channel = this.ensureChannel(params.platform, params.channelId, params.processorId);
    const errorText = stringifyError(params.error);
    channel.ops[params.op].failure += 1;
    this.global[params.op].failure += 1;
    if (params.rateLimited) {
      channel.ops[params.op].rateLimited += 1;
      this.global[params.op].rateLimited += 1;
    }
    channel.lastFailureAt = Date.now();
    channel.lastFailureError = errorText;

    const record: FailureRecord = {
      timestamp: Date.now(),
      platform: params.platform,
      processorId: params.processorId,
      channelId: params.channelId,
      threadId: params.threadId,
      op: params.op,
      error: errorText,
      rateLimited: Boolean(params.rateLimited),
      messageTs: params.messageTs,
    };
    this.recentFailures.push(record);
    if (this.recentFailures.length > MAX_RECENT_FAILURES) {
      this.recentFailures.splice(0, this.recentFailures.length - MAX_RECENT_FAILURES);
    }

    if (this.failureHook) {
      try {
        this.failureHook(record);
      } catch {
        // Hook failures must never break the recording path.
      }
    }
  }

  recordRetry(params: {
    platform: DeliveryPlatform;
    channelId: string;
    op: DeliveryOp;
    processorId?: string;
  }): void {
    const channel = this.ensureChannel(params.platform, params.channelId, params.processorId);
    channel.ops[params.op].retries += 1;
    this.global[params.op].retries += 1;
  }

  /**
   * Log a warning at WARN level at most once per `throttleMs` per key.
   * Useful for noisy per-tick failures like a repeated `chat.update` error.
   */
  logThrottledWarn(
    key: string,
    message: string,
    data?: Record<string, unknown>,
    throttleMs: number = DEFAULT_THROTTLE_MS,
  ): void {
    const now = Date.now();
    const last = this.throttleState.get(key) ?? 0;
    if (now - last < throttleMs) return;
    this.throttleState.set(key, now);
    log.warn(message, data);
  }

  getSnapshot(): DeliveryStatsSnapshot {
    return {
      capturedAt: Date.now(),
      global: cloneOpCounters(this.global),
      channels: Array.from(this.channels.values()).map(cloneChannel),
      recentFailures: [...this.recentFailures],
    };
  }

  getChannelStats(
    platform: DeliveryPlatform,
    channelId: string,
    processorId?: string,
  ): ChannelDeliveryStats | undefined {
    const channel = this.channels.get(buildKey(platform, channelId, processorId));
    return channel ? cloneChannel(channel) : undefined;
  }

  reset(): void {
    this.channels.clear();
    this.recentFailures.length = 0;
    for (const op of OPS) {
      this.global[op] = emptyCounters();
    }
    this.throttleState.clear();
  }

  async dumpToFile(path: string = defaultDumpPath()): Promise<string> {
    ensureDir(path);
    const snapshot = this.getSnapshot();
    await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8");
    return path;
  }

  dumpToFileSync(path: string = defaultDumpPath()): string {
    ensureDir(path);
    const snapshot = this.getSnapshot();
    writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");
    return path;
  }

  private ensureChannel(
    platform: DeliveryPlatform,
    channelId: string,
    processorId?: string,
  ): ChannelDeliveryStats {
    const key = buildKey(platform, channelId, processorId);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        platform,
        processorId,
        channelId,
        ops: emptyOpCounters(),
      };
      this.channels.set(key, channel);
    }
    return channel;
  }
}

export function defaultDumpPath(): string {
  return join(homedir(), ".config", "ode", "diagnostics", "delivery-stats.json");
}

function ensureDir(filePath: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function cloneOpCounters(
  ops: Record<DeliveryOp, DeliveryCounters>,
): Record<DeliveryOp, DeliveryCounters> {
  return {
    send: { ...ops.send },
    update: { ...ops.update },
    delete: { ...ops.delete },
  };
}

function cloneChannel(channel: ChannelDeliveryStats): ChannelDeliveryStats {
  return {
    platform: channel.platform,
    processorId: channel.processorId,
    channelId: channel.channelId,
    ops: cloneOpCounters(channel.ops),
    lastFailureAt: channel.lastFailureAt,
    lastFailureError: channel.lastFailureError,
    lastSuccessAt: channel.lastSuccessAt,
  };
}

// Module-level singleton so every IM adapter records into the same counters.
export const deliveryStats = new DeliveryStats();

/**
 * Detect a rate-limit error across SDK variants. Thin re-export of the shared
 * detector so both core and ims layers agree on 429 semantics — previously
 * each had its own implementation and they disagreed on Slack SDK errors
 * carrying `data.retry_after`.
 */
export const isRateLimitError = sharedIsRateLimitError;

export function renderDeliveryStatsForSlack(params: {
  channelId?: string;
  platform?: DeliveryPlatform;
  snapshot?: DeliveryStatsSnapshot;
  recentLimit?: number;
}): string {
  const snapshot = params.snapshot ?? deliveryStats.getSnapshot();
  const lines: string[] = [];
  const platformLabel = params.platform ? `[${params.platform}] ` : "";
  lines.push(`*${platformLabel}Delivery stats* (captured ${new Date(snapshot.capturedAt).toISOString()})`);

  const globalLine = renderCountersLine(snapshot.global);
  lines.push(`• *global* — ${globalLine}`);

  const channels = snapshot.channels.filter((c) => {
    if (params.platform && c.platform !== params.platform) return false;
    if (params.channelId && c.channelId !== params.channelId) return false;
    return true;
  });

  if (params.channelId) {
    const match = channels.find((c) => c.channelId === params.channelId);
    if (match) {
      lines.push(`• *channel* \`${params.channelId}\` — ${renderCountersLine(match.ops)}`);
      if (match.lastFailureError) {
        const ts = match.lastFailureAt ? new Date(match.lastFailureAt).toISOString() : "?";
        lines.push(`   last failure @ ${ts}: \`${truncate(match.lastFailureError, 200)}\``);
      }
    } else {
      lines.push(`• *channel* \`${params.channelId}\` — no activity recorded yet`);
    }
  } else if (channels.length > 0) {
    const top = [...channels]
      .sort((a, b) => sumFailures(b.ops) - sumFailures(a.ops))
      .slice(0, 5);
    for (const c of top) {
      lines.push(`• \`${c.channelId}\` (${c.platform}) — ${renderCountersLine(c.ops)}`);
    }
  }

  const recent = snapshot.recentFailures
    .filter((r) => {
      if (params.platform && r.platform !== params.platform) return false;
      if (params.channelId && r.channelId !== params.channelId) return false;
      return true;
    })
    .slice(-(params.recentLimit ?? 5));

  if (recent.length > 0) {
    lines.push(`*Recent failures (${recent.length}):*`);
    for (const failure of recent) {
      const ts = new Date(failure.timestamp).toISOString();
      const tag = failure.rateLimited ? "429" : "ERR";
      lines.push(
        `   [${tag}] ${ts} ${failure.op} \`${failure.channelId}\`: ${truncate(failure.error, 140)}`,
      );
    }
  }
  return lines.join("\n");
}

function renderCountersLine(ops: Record<DeliveryOp, DeliveryCounters>): string {
  const parts: string[] = [];
  for (const op of OPS) {
    const c = ops[op];
    if (c.attempts === 0 && c.failure === 0) continue;
    const rate = c.attempts > 0 ? Math.round((c.success / c.attempts) * 100) : 0;
    const pieces = [`${c.success}/${c.attempts} ok (${rate}%)`];
    if (c.failure > 0) pieces.push(`${c.failure} fail`);
    if (c.rateLimited > 0) pieces.push(`${c.rateLimited} 429`);
    if (c.retries > 0) pieces.push(`${c.retries} retries`);
    parts.push(`${op}: ${pieces.join(", ")}`);
  }
  if (parts.length === 0) return "(no activity)";
  return parts.join(" · ");
}

function sumFailures(ops: Record<DeliveryOp, DeliveryCounters>): number {
  return ops.send.failure + ops.update.failure + ops.delete.failure;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
