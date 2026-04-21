import type { IMAdapter } from "@/core/types";
import { getMessageUpdateIntervalMs } from "@/config";
import { BoundedMap, BoundedSet, log } from "@/utils";
import { CoalescedUpdateQueue } from "@/shared/queue/coalesced-update-queue";
import { isRateLimitError } from "@/shared/delivery/rate-limit";

/**
 * Soft cap for the per-daemon record of which messages we have finalized or
 * hit rate limits on. The runtime is a long-lived singleton (one per daemon,
 * see `packages/core/kernel/runtime-facade.ts`) so an unbounded Set here leaks
 * ~40 bytes per finalized message for the life of the daemon.
 *
 * A bounded FIFO is fine because the only consumers (`updateMessage`,
 * `wasRateLimited`, `getRateLimitError`) only care about recent messages — a
 * message finalized millions of updates ago will not receive further updates.
 */
const FINALIZED_SET_MAX_ENTRIES = 5000;
const RATE_LIMIT_MAP_MAX_ENTRIES = 5000;

export function createRateLimitedImAdapter(
  im: IMAdapter,
  intervalMs = getMessageUpdateIntervalMs()
): IMAdapter {
  const rateLimitedMessages = new BoundedSet<string>(FINALIZED_SET_MAX_ENTRIES);
  const finalizedMessages = new BoundedSet<string>(FINALIZED_SET_MAX_ENTRIES);
  const rateLimitErrors = new BoundedMap<string, string>(RATE_LIMIT_MAP_MAX_ENTRIES);
  const updateErrors = new Map<string, string>();

  function key(channelId: string, messageTs: string): string {
    return `${channelId}:${messageTs}`;
  }

  const queue = new CoalescedUpdateQueue<string | undefined>(
    intervalMs,
    async ({ channelId, messageId }, text) => {
      const updateKey = key(channelId, messageId);
      if (finalizedMessages.has(updateKey)) {
        log.debug("Skipping queued message update after finalization", {
          channelId,
          messageTs: messageId,
        });
        return undefined;
      }
      try {
        const maybeUpdatedTs = await im.updateMessage(channelId, messageId, text);
        updateErrors.delete(updateKey);
        return typeof maybeUpdatedTs === "string" ? maybeUpdatedTs : undefined;
      } catch (error) {
        const errorText = String(error);
        updateErrors.set(updateKey, errorText);
        if (isRateLimitError(error)) {
          rateLimitedMessages.add(updateKey);
          rateLimitErrors.set(updateKey, errorText);
          log.warn("IM message update hit rate limit (429)", {
            channelId,
            messageTs: messageId,
            error: errorText,
          });
        }
        log.debug("IM message update failed", {
          channelId,
          messageTs: messageId,
          error: errorText,
        });
        return undefined;
      }
    }
  );

  return {
    ...im,
    wasRateLimited: (channelId: string, messageTs: string): boolean => {
      if (typeof im.wasRateLimited === "function" && im.wasRateLimited(channelId, messageTs)) {
        return true;
      }
      return rateLimitedMessages.has(key(channelId, messageTs));
    },
    getRateLimitError: (channelId: string, messageTs: string): string | undefined => {
      if (typeof im.getRateLimitError === "function") {
        const upstream = im.getRateLimitError(channelId, messageTs);
        if (upstream) return upstream;
      }
      return rateLimitErrors.get(key(channelId, messageTs));
    },
    cancelPendingUpdates: (channelId: string, messageTs: string): void => {
      if (typeof im.cancelPendingUpdates === "function") {
        im.cancelPendingUpdates(channelId, messageTs);
      }
      queue.cancel({ channelId, messageId: messageTs });
    },
    markMessageFinalized: (channelId: string, messageTs: string): void => {
      if (typeof im.markMessageFinalized === "function") {
        im.markMessageFinalized(channelId, messageTs);
      }
      const updateKey = key(channelId, messageTs);
      finalizedMessages.add(updateKey);
      queue.cancel({ channelId, messageId: messageTs });
      updateErrors.delete(updateKey);
    },
    takeUpdateError: (channelId: string, messageTs: string): string | undefined => {
      const updateErrorKey = key(channelId, messageTs);
      if (typeof im.takeUpdateError === "function") {
        const upstream = im.takeUpdateError(channelId, messageTs);
        if (upstream) {
          updateErrors.delete(updateErrorKey);
          return upstream;
        }
      }
      const captured = updateErrors.get(updateErrorKey);
      if (!captured) return undefined;
      updateErrors.delete(updateErrorKey);
      return captured;
    },
    updateMessage: async (
      channelId: string,
      messageTs: string,
      text: string
    ): Promise<string | undefined> => {
      if (finalizedMessages.has(key(channelId, messageTs))) {
        log.debug("Skipping message update after finalization", {
          channelId,
          messageTs,
        });
        return undefined;
      }
      return queue.enqueue({ channelId, messageId: messageTs }, text);
    },
  };
}
