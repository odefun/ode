import * as Sentry from "@sentry/bun";
import { log } from "@/utils";
import type {
  DeliveryOp,
  DeliveryPlatform,
  FailureRecord,
} from "@/ims/shared/delivery-stats";
import { deliveryStats } from "@/ims/shared/delivery-stats";

/**
 * Default Sentry DSN. Can be overridden via ODE_SENTRY_DSN, and disabled via
 * ODE_SENTRY_DISABLED=1 or by setting the DSN to an empty string.
 *
 * The DSN is a public identifier (safe to commit). It only grants the ability
 * to submit events to a specific Sentry project.
 */
const DEFAULT_SENTRY_DSN =
  "https://f609ba8642f76d2d884374dcb4d15345@o4511218045222912.ingest.us.sentry.io/4511234426994689";

let initialized = false;

/**
 * Dedup / rate-limit key → last send timestamp. Keeps Sentry quota from
 * being burned by a flapping channel. Same idea as the throttled WARN log.
 */
const lastCaptureByKey = new Map<string, number>();

// Minimum interval between Sentry events for the same fingerprint, in ms.
const RATE_LIMIT_CAPTURE_INTERVAL_MS = 5 * 60_000; // 429s: 1 per 5 min per channel+op
const ERROR_CAPTURE_INTERVAL_MS = 60_000;          // Other errors: 1 per min per channel+op

function resolveDsn(): string | undefined {
  if (process.env.ODE_SENTRY_DISABLED === "1") return undefined;
  const override = process.env.ODE_SENTRY_DSN;
  if (typeof override === "string") {
    const trimmed = override.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return DEFAULT_SENTRY_DSN;
}

export function initSentry(params?: { release?: string; environment?: string }): void {
  if (initialized) return;
  const dsn = resolveDsn();
  if (!dsn) {
    log.info("Sentry disabled (no DSN configured)");
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment:
        params?.environment ?? process.env.ODE_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      release: params?.release,
      // We don't need perf traces for now — just error capture.
      tracesSampleRate: 0,
      // Send default PII like IP = off; channel IDs are opaque but messages are not.
      sendDefaultPii: false,
      // Limit breadcrumbs (they include console logs which are extensive via pino).
      maxBreadcrumbs: 30,
    });

    initialized = true;
    log.info("Sentry initialized");

    // Install the failure hook so every delivery failure is captured.
    deliveryStats.setFailureHook((failure) => {
      captureDeliveryFailure(failure);
    });
  } catch (err) {
    log.warn("Failed to initialize Sentry", { error: String(err) });
  }
}

/**
 * Flush pending events and close the Sentry client. Call on graceful shutdown
 * so buffered events reach Sentry before the process exits.
 */
export async function shutdownSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
    await Sentry.close(timeoutMs);
  } catch (err) {
    log.warn("Failed to flush Sentry on shutdown", { error: String(err) });
  } finally {
    initialized = false;
  }
}

export function isSentryInitialized(): boolean {
  return initialized;
}

/**
 * Generic helper to capture any handled error with structured context.
 * Use this for failures you already log but also want to track in Sentry.
 */
export function captureHandledError(
  err: unknown,
  context?: {
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    fingerprint?: string[];
    level?: "warning" | "error" | "fatal";
  },
): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
      }
      if (context?.extra) {
        for (const [k, v] of Object.entries(context.extra)) scope.setExtra(k, v);
      }
      if (context?.fingerprint) scope.setFingerprint(context.fingerprint);
      if (context?.level) scope.setLevel(context.level);
      Sentry.captureException(err);
    });
  } catch (hookErr) {
    log.debug("Sentry capture failed", { error: String(hookErr) });
  }
}

function shouldCapture(key: string, intervalMs: number): boolean {
  const now = Date.now();
  const last = lastCaptureByKey.get(key) ?? 0;
  if (now - last < intervalMs) return false;
  lastCaptureByKey.set(key, now);
  return true;
}

function buildFailureFingerprint(
  platform: DeliveryPlatform,
  op: DeliveryOp,
  rateLimited: boolean,
  channelId: string,
): string[] {
  // Group by (platform, op, rateLimited, channelId) so each channel's flapping
  // rolls up into one issue, not one per message.
  return [
    "ode-delivery-failure",
    platform,
    op,
    rateLimited ? "rate_limited" : "error",
    channelId,
  ];
}

function captureDeliveryFailure(failure: FailureRecord): void {
  if (!initialized) return;

  // Some delivery failures are expected race conditions, not bugs:
  //   - `message_not_found` on update/delete: the status message was already
  //     deleted or replaced (common when finalization races with teardown).
  //   - `unknown_message` / `not_found` on update/delete for Discord/Lark.
  // Skipping these entirely keeps Sentry quota focused on real issues like
  // auth/network/payload errors. We still keep them in the local
  // `deliveryStats` counters for debugging.
  if (!failure.rateLimited && isBenignDeliveryFailure(failure)) {
    return;
  }

  const dedupKey = `${failure.platform}|${failure.op}|${failure.rateLimited ? "rl" : "err"}|${failure.channelId}`;
  const interval = failure.rateLimited
    ? RATE_LIMIT_CAPTURE_INTERVAL_MS
    : ERROR_CAPTURE_INTERVAL_MS;
  if (!shouldCapture(dedupKey, interval)) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag("platform", failure.platform);
      scope.setTag("op", failure.op);
      scope.setTag("rate_limited", failure.rateLimited ? "true" : "false");
      scope.setTag("channel_id", failure.channelId);
      if (failure.processorId) {
        scope.setTag("processor_id", failure.processorId);
      }
      if (failure.threadId) {
        // Tag the thread id so issues triggered by a malformed / synthetic
        // thread (e.g. `invalid_thread_ts` when the caller hands Slack a
        // non-`ts` string like `task:<uuid>`) are diagnosable from Sentry
        // alone, without having to correlate with local logs.
        scope.setTag("thread_id", failure.threadId);
      }
      scope.setContext("delivery", {
        platform: failure.platform,
        op: failure.op,
        channelId: failure.channelId,
        threadId: failure.threadId,
        processorId: failure.processorId,
        messageTs: failure.messageTs,
        rateLimited: failure.rateLimited,
        timestamp: new Date(failure.timestamp).toISOString(),
      });
      scope.setFingerprint(
        buildFailureFingerprint(
          failure.platform,
          failure.op,
          failure.rateLimited,
          failure.channelId,
        ),
      );
      // 429 is expected pressure signal, not a bug → warning.
      // Other errors may indicate auth / payload / network issues → error.
      scope.setLevel(failure.rateLimited ? "warning" : "error");

      const title = failure.rateLimited
        ? `IM ${failure.platform} ${failure.op} rate limited (429)`
        : `IM ${failure.platform} ${failure.op} failed: ${failure.error}`;
      Sentry.captureMessage(title);
    });
  } catch (hookErr) {
    log.debug("Sentry capture failed", { error: String(hookErr) });
  }
}

/**
 * Error strings that represent expected races, not real bugs, for a given op.
 * Keep this list narrow; when in doubt, send to Sentry rather than suppress.
 */
const BENIGN_UPDATE_DELETE_PATTERNS = [
  // Slack
  "message_not_found",
  // Discord
  "unknown_message",
  // Lark (generic "not found" codes vary; substring match keeps it simple)
  "not_found",
];

export function isBenignDeliveryFailure(failure: {
  op: DeliveryOp;
  error: string;
}): boolean {
  if (failure.op !== "update" && failure.op !== "delete") return false;
  const text = failure.error.toLowerCase();
  return BENIGN_UPDATE_DELETE_PATTERNS.some((pattern) => text.includes(pattern));
}
