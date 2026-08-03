/**
 * A "synthetic" thread owner is an internal marker for threads that Ode
 * started on its own (one-time Tasks, scheduled Cron jobs, etc.), before
 * any human joined the conversation. These user IDs use the form
 * `task:{taskId}` or `cron-job:{jobId}` and never correspond to a real
 * Slack / Discord / Lark user.
 *
 * Synthetic owners are _claimable_: the first real human to reply in such
 * a thread becomes the persistent `threadOwnerUserId`. Downstream policy
 * and session-bootstrap code treats a synthetic owner as "unset" so the
 * owner gate does not reject real humans.
 */

const SYNTHETIC_OWNER_PREFIXES = ["task:", "cron-job:", "cron:"] as const;

export function isSyntheticOwner(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return SYNTHETIC_OWNER_PREFIXES.some((prefix) => userId.startsWith(prefix));
}

/**
 * Build the `thread_ts` field for a Slack API payload, omitting it entirely
 * when `threadId` is a synthetic placeholder.
 *
 * The task/cron schedulers address a run by a synthetic thread id
 * (`task:{id}` / `cron-job:{id}:{run}`) before Slack has assigned a real
 * `thread_ts`. Slack rejects those strings with `invalid_thread_ts` because
 * they are not message timestamps, so the message is dropped and reported as
 * a delivery failure. Omitting the field degrades to a top-level channel
 * post, which keeps the message visible.
 *
 * Spread the result into the payload: `{ channel, ...threadTsField(id) }`.
 */
export function threadTsField(
  threadId: string | null | undefined
): { thread_ts?: string } {
  if (!threadId || isSyntheticOwner(threadId)) return {};
  return { thread_ts: threadId };
}
