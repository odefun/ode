/**
 * Detect "permanent" channel-access delivery failures — cases where retrying
 * the same send is guaranteed to fail until a human intervenes (bot removed
 * from the channel, channel archived/deleted, workspace token revoked, etc.).
 *
 * This is used by the cron scheduler to auto-disable a job whose target
 * channel is unreachable. Without this guard the scheduler keeps firing the
 * job every cron tick, each failure capturing a fresh Sentry event with the
 * same `channel_not_found` fingerprint — turning one broken job into a
 * permanent noise source (see Sentry ODE-DEAMON-7).
 *
 * The detection is intentionally narrow: we only return `true` for errors
 * whose remediation is *outside the daemon's control*. Transient failures
 * (network blips, 5xx, rate limits) must remain retryable and therefore
 * MUST NOT be classified as permanent here.
 */

// Tokens are matched case-insensitively against the stringified error.
//
// Slack:
//   - channel_not_found: channel doesn't exist OR bot can't see it
//   - not_in_channel: bot needs to be invited to post
//   - is_archived / channel_is_archived: channel was archived
//   - account_inactive: workspace user/account disabled
//   - token_revoked / invalid_auth / not_authed: token no longer works
//   - missing_scope: token lacks chat:write or similar — retrying won't help
//
// Discord (discord.js DiscordAPIError exposes `code`):
//   - 10003 Unknown Channel
//   - 50001 Missing Access
//   - 50013 Missing Permissions
//   - 50007 Cannot send messages to this user
//
// Lark (open-platform error codes vary; we match the common "permission
// denied" / "chat not exist" / "chat does not exist" message text):
//   - chat_not_found / chat not exist / chat does not exist
//   - permission denied (generic; only matched when paired with chat context)
const PERMANENT_MESSAGE_TOKENS = [
  // Slack
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "channel_is_archived",
  "account_inactive",
  "token_revoked",
  "invalid_auth",
  "not_authed",
  "missing_scope",
  // Lark
  "chat_not_found",
  "chat not exist",
  // `larkApi` re-throws the raw `msg` text from the Lark API for some
  // payloads (notably stale/deleted group chats), which surfaces as the
  // human-readable "chat does not exist". The shorter "chat not exist"
  // token does not contain this substring (due to the "does" infix), so
  // we list it explicitly.
  "chat does not exist",
];

// Discord.js surfaces the raw API code on `err.code` as a number.
const PERMANENT_DISCORD_CODES = new Set<number>([
  10003, // Unknown Channel
  50001, // Missing Access
  50013, // Missing Permissions
  50007, // Cannot send messages to this user
]);

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isPermanentChannelError(err: unknown): boolean {
  if (!err) return false;
  const message = stringifyError(err).toLowerCase();
  for (const token of PERMANENT_MESSAGE_TOKENS) {
    if (message.includes(token)) return true;
  }
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && PERMANENT_DISCORD_CODES.has(code)) {
      return true;
    }
    // Slack SDK exposes the API error string on `err.data.error`.
    const data = (err as { data?: { error?: unknown } }).data;
    const apiError = data?.error;
    if (typeof apiError === "string") {
      const normalized = apiError.toLowerCase();
      for (const token of PERMANENT_MESSAGE_TOKENS) {
        if (normalized.includes(token)) return true;
      }
    }
  }
  return false;
}
