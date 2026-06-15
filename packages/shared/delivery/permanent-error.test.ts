import { describe, expect, test } from "bun:test";
import { isPermanentChannelError } from "./permanent-error";

describe("isPermanentChannelError", () => {
  test("matches Slack channel_not_found in message", () => {
    expect(
      isPermanentChannelError(
        new Error("An API error occurred: channel_not_found"),
      ),
    ).toBe(true);
  });

  test("matches Slack SDK error shape with data.error", () => {
    const err = Object.assign(new Error("slack_webapi_platform_error"), {
      data: { error: "channel_not_found" },
    });
    expect(isPermanentChannelError(err)).toBe(true);
  });

  test("matches Slack not_in_channel / is_archived / account_inactive", () => {
    expect(isPermanentChannelError(new Error("not_in_channel"))).toBe(true);
    expect(isPermanentChannelError(new Error("is_archived"))).toBe(true);
    expect(isPermanentChannelError(new Error("channel_is_archived"))).toBe(true);
    expect(isPermanentChannelError(new Error("account_inactive"))).toBe(true);
  });

  test("matches Slack auth-revoked errors", () => {
    expect(isPermanentChannelError(new Error("token_revoked"))).toBe(true);
    expect(isPermanentChannelError(new Error("invalid_auth"))).toBe(true);
    expect(isPermanentChannelError(new Error("missing_scope"))).toBe(true);
  });

  test("matches Discord-style numeric codes (Missing Access, Unknown Channel)", () => {
    expect(
      isPermanentChannelError(Object.assign(new Error("Missing Access"), { code: 50001 })),
    ).toBe(true);
    expect(
      isPermanentChannelError(Object.assign(new Error("Unknown Channel"), { code: 10003 })),
    ).toBe(true);
  });

  test("matches the Discord resolveTextChannel wrapper when it carries a DiscordAPIError code", () => {
    // resolveTextChannel() in packages/ims/discord/client.ts wraps the
    // underlying DiscordAPIError in a generic Error("... is not text-based
    // or inaccessible"). The wrapper forwards the original numeric `code`
    // so this helper can still classify it as permanent.
    const wrapper = Object.assign(
      new Error("Discord channel 123 is not text-based or inaccessible"),
      { code: 10003 },
    );
    expect(isPermanentChannelError(wrapper)).toBe(true);
  });

  test("ignores Discord resolveTextChannel wrapper without a forwarded code", () => {
    // When `resolveTextChannel` cannot confidently identify a permanent
    // failure (e.g. mixed pinned-bot transient + unrelated-bot permanent),
    // it forwards a non-permanent or no `code`. The classifier must not
    // promote those to permanent on the wrapper's message alone. See PR
    // #211 discussion: "Avoid disabling Discord jobs on mixed fetch
    // failures".
    const noCode = new Error("Discord channel 123 is not text-based or inaccessible");
    expect(isPermanentChannelError(noCode)).toBe(false);

    const transientCode = Object.assign(
      new Error("Discord channel 123 is not text-based or inaccessible"),
      { code: 500 },
    );
    expect(isPermanentChannelError(transientCode)).toBe(false);
  });

  test("matches Lark chat_not_found", () => {
    expect(isPermanentChannelError(new Error("chat_not_found: chat does not exist"))).toBe(true);
  });

  test("matches Lark deleted-chat message text alone", () => {
    // larkApi() re-throws the raw `msg` field from the Lark API for some
    // payloads — for stale/deleted group chats this surfaces as just
    // "chat does not exist", without the `chat_not_found` token. The
    // shorter "chat not exist" token does NOT match this string because
    // of the "does" infix, so we list the long form explicitly. See PR
    // #211 discussion: "Match Lark's deleted-chat message".
    expect(isPermanentChannelError(new Error("chat does not exist"))).toBe(true);
  });

  test("ignores transient / retryable failures", () => {
    expect(isPermanentChannelError(new Error("status 429"))).toBe(false);
    expect(isPermanentChannelError(new Error("ECONNRESET"))).toBe(false);
    expect(isPermanentChannelError(new Error("status 500"))).toBe(false);
    expect(isPermanentChannelError(new Error("socket hang up"))).toBe(false);
    expect(isPermanentChannelError(new Error("rate_limited"))).toBe(false);
  });

  test("ignores nullish / empty inputs", () => {
    expect(isPermanentChannelError(null)).toBe(false);
    expect(isPermanentChannelError(undefined)).toBe(false);
    expect(isPermanentChannelError("")).toBe(false);
    expect(isPermanentChannelError({})).toBe(false);
  });

  test("ignores message_not_found (that's a delete/update race, not permanent)", () => {
    // `message_not_found` is already handled as a benign update/delete race
    // in @/core/observability/sentry. It is NOT a channel-access problem and
    // must remain retryable from this helper's perspective.
    expect(isPermanentChannelError(new Error("message_not_found"))).toBe(false);
  });
});
