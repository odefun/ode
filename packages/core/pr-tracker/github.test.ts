import { describe, expect, test } from "bun:test";
import {
  fetchPrActivity,
  GitHubActivityFetchError,
  renderEventsSummary,
  renderPrompt,
  resolveApiBaseUrl,
  resolveGitHubToken,
  type PrEvent,
} from "./github";

function buildMockFetch(
  responses: Record<string, unknown>,
): (url: string) => Promise<Response> {
  return async (url: string) => {
    // Strip the base URL so test keys can stay short.
    const key = url.replace(/^https?:\/\/[^/]+/, "");
    if (!(key in responses)) {
      return new Response(JSON.stringify({ message: `no mock for ${key}` }), {
        status: 404,
      });
    }
    const value = responses[key];
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("resolveGitHubToken", () => {
  test("prefers tracker token over global", () => {
    expect(
      resolveGitHubToken({ trackerToken: "tracker", globalToken: "global" }),
    ).toBe("tracker");
  });

  test("falls back to global when tracker empty", () => {
    expect(
      resolveGitHubToken({ trackerToken: "   ", globalToken: "global" }),
    ).toBe("global");
  });

  test("returns null or a string from gh CLI when neither is set", () => {
    const result = resolveGitHubToken({});
    // We can't assert the value because it depends on the host machine; we
    // only assert the shape.
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("renderEventsSummary", () => {
  test("returns placeholder when no events", () => {
    expect(renderEventsSummary([])).toBe("(no new events)");
  });

  test("labels each kind", () => {
    const events: PrEvent[] = [
      { kind: "comment", githubEventId: "1", timestamp: 1, author: "alice", body: "looks good" },
      {
        kind: "review",
        githubEventId: "2",
        timestamp: 2,
        author: "bob",
        body: "nit: fix typo",
        meta: { state: "changes_requested" },
      },
      { kind: "review_comment", githubEventId: "3", timestamp: 3, author: "carol", body: "?" },
      { kind: "pr_updated", githubEventId: "4", timestamp: 4, author: "dan", body: "Add feature" },
    ];
    const out = renderEventsSummary(events);
    expect(out).toContain("[Comment] @alice");
    expect(out).toContain("[Review (changes_requested)] @bob");
    expect(out).toContain("[Review comment] @carol");
    expect(out).toContain("[PR update] @dan");
  });

  test("caps to 20 events with overflow marker", () => {
    const events: PrEvent[] = Array.from({ length: 25 }, (_, i) => ({
      kind: "comment" as const,
      githubEventId: `c${i}`,
      timestamp: i,
      author: `user${i}`,
      body: `body ${i}`,
    }));
    const out = renderEventsSummary(events);
    // First line is overflow marker, then 20 events.
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/\.\.\.and 5 older event/);
    expect(lines).toHaveLength(21);
    // Latest events are kept.
    expect(out).toContain("@user24");
    expect(out).not.toContain("@user4");
  });

  test("truncates very long bodies", () => {
    const big = "x".repeat(1000);
    const out = renderEventsSummary([
      { kind: "comment", githubEventId: "1", timestamp: 1, author: "a", body: big },
    ]);
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("...");
  });
});

describe("renderPrompt", () => {
  test("substitutes known variables", () => {
    const out = renderPrompt(
      "Repo: {{repo_full_name}} PR #{{pr_number}} by {{pr_author}}\n{{new_events_summary}}",
      {
        repoFullName: "acme/thing",
        prNumber: 42,
        prTitle: "Do the thing",
        prUrl: "https://github.com/acme/thing/pull/42",
        prAuthor: "alice",
        prState: "open",
        headRef: "feature",
        baseRef: "main",
        events: [
          { kind: "comment", githubEventId: "1", timestamp: 1, author: "bob", body: "hi" },
        ],
      },
    );
    expect(out).toContain("Repo: acme/thing PR #42 by alice");
    expect(out).toContain("[Comment] @bob");
  });

  test("leaves unknown tokens untouched (graceful)", () => {
    const out = renderPrompt("Keep {{unknown}} as-is", {
      repoFullName: "a/b",
      prNumber: 1,
      prTitle: "t",
      prUrl: "u",
      prAuthor: "x",
      prState: "open",
      headRef: null,
      baseRef: null,
      events: [],
    });
    expect(out).toContain("{{unknown}}");
  });
});

describe("fetchPrActivity", () => {
  test("aggregates issue comments, review comments, and PR updates by PR", async () => {
    const since = Date.parse("2026-04-20T00:00:00Z");
    const newer = new Date(since + 60_000).toISOString();
    const older = new Date(since - 60_000).toISOString();

    const fetchImpl = buildMockFetch({
      // Pulls page 1
      "/repos/acme/thing/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1": [
        {
          number: 42,
          title: "Feature A",
          html_url: "https://github.com/acme/thing/pull/42",
          state: "open",
          updated_at: newer,
          user: { login: "alice" },
          head: { ref: "feat/a" },
          base: { ref: "main" },
        },
        {
          number: 7,
          title: "Old PR",
          html_url: "https://github.com/acme/thing/pull/7",
          state: "open",
          updated_at: older, // cursor stops here
          user: { login: "zed" },
          head: { ref: "old" },
          base: { ref: "main" },
        },
      ],
      [`/repos/acme/thing/issues/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [
        {
          id: 111,
          html_url: "https://github.com/acme/thing/pull/42#issuecomment-111",
          body: "Comment on 42",
          user: { login: "bob" },
          created_at: newer,
          updated_at: newer,
          issue_url: "https://api.github.com/repos/acme/thing/issues/42",
          pull_request_url: "https://api.github.com/repos/acme/thing/pulls/42",
        },
        // An issue-only comment (no pull_request_url field). Should be dropped
        // so we don't fabricate a PR bucket for a regular issue.
        {
          id: 112,
          html_url: "https://github.com/acme/thing/issues/99#issuecomment-112",
          body: "Comment on an issue",
          user: { login: "bob" },
          created_at: newer,
          updated_at: newer,
          issue_url: "https://api.github.com/repos/acme/thing/issues/99",
        },
      ],
      [`/repos/acme/thing/pulls/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [
        {
          id: 222,
          html_url: "https://github.com/acme/thing/pull/42#discussion_r222",
          body: "Inline nit",
          user: { login: "carol" },
          created_at: newer,
          updated_at: newer,
          pull_request_url: "https://api.github.com/repos/acme/thing/pulls/42",
        },
      ],
      "/repos/acme/thing/pulls/42/reviews?per_page=100": [
        {
          id: 333,
          user: { login: "dan" },
          state: "APPROVED",
          body: "lgtm",
          submitted_at: newer,
          html_url: "https://github.com/acme/thing/pull/42#review-333",
        },
        {
          // Stale review from before cursor — filtered out.
          id: 334,
          user: { login: "old" },
          state: "COMMENTED",
          body: "old",
          submitted_at: older,
          html_url: "https://github.com/acme/thing/pull/42#review-334",
        },
      ],
      "/repos/acme/thing/pulls/99/reviews?per_page=100": [],
    });

    const summaries = await fetchPrActivity(
      { owner: "acme", repo: "thing", sinceMs: since, token: "fake" },
      fetchImpl,
    );

    // PR 42 should contain the pr_updated event, the issue comment, the review
    // comment, and the fresh review. The issue-99 comment has no
    // pull_request_url so it's correctly dropped (not a PR thread).
    const byNumber = new Map(summaries.map((s) => [s.prNumber, s] as const));
    expect(Array.from(byNumber.keys()).sort()).toEqual([42]);

    const pr42 = byNumber.get(42)!;
    expect(pr42.title).toBe("Feature A");
    expect(pr42.author).toBe("alice");
    const kinds42 = pr42.events.map((e) => e.kind).sort();
    expect(kinds42).toEqual(["comment", "pr_updated", "review", "review_comment"]);
    // Events are sorted by timestamp ascending.
    const times = pr42.events.map((e) => e.timestamp);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  test("returns empty when no activity", async () => {
    const since = Date.parse("2026-04-20T00:00:00Z");
    const fetchImpl = buildMockFetch({
      "/repos/acme/quiet/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1": [],
      [`/repos/acme/quiet/issues/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [],
      [`/repos/acme/quiet/pulls/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [],
    });
    const summaries = await fetchPrActivity(
      { owner: "acme", repo: "quiet", sinceMs: since, token: "fake" },
      fetchImpl,
    );
    expect(summaries).toEqual([]);
  });

  test("swallows individual endpoint failures (degraded mode)", async () => {    const since = Date.parse("2026-04-20T00:00:00Z");
    const newer = new Date(since + 60_000).toISOString();

    const fetchImpl: (url: string) => Promise<Response> = async (url: string) => {
      const key = url.replace(/^https?:\/\/[^/]+/, "");
      if (key.startsWith("/repos/acme/thing/pulls?")) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
      }
      if (key.startsWith("/repos/acme/thing/issues/comments")) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              html_url: "https://github.com/acme/thing/pull/1",
              body: "survives",
              user: { login: "x" },
              created_at: newer,
              updated_at: newer,
              issue_url: "https://api.github.com/repos/acme/thing/issues/1",
              pull_request_url: "https://api.github.com/repos/acme/thing/pulls/1",
            },
          ]),
          { status: 200 },
        );
      }
      if (key.startsWith("/repos/acme/thing/pulls/comments")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (key.includes("/pulls/1/reviews")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    const summaries = await fetchPrActivity(
      { owner: "acme", repo: "thing", sinceMs: since, token: "fake" },
      fetchImpl,
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.prNumber).toBe(1);
    expect(summaries[0]!.events.map((e) => e.kind)).toEqual(["comment"]);
  });

  test("throws GitHubActivityFetchError when all three endpoints fail", async () => {
    const since = Date.parse("2026-04-20T00:00:00Z");
    const fetchImpl: (url: string) => Promise<Response> = async () =>
      new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });

    await expect(
      fetchPrActivity(
        { owner: "acme", repo: "thing", sinceMs: since, token: "fake" },
        fetchImpl,
      ),
    ).rejects.toThrow(GitHubActivityFetchError);
  });

  test("routes enterprise host into GHES base URL", async () => {
    const since = Date.parse("2026-04-20T00:00:00Z");
    const newer = new Date(since + 60_000).toISOString();
    const calls: string[] = [];
    const fetchImpl: (url: string) => Promise<Response> = async (url: string) => {
      calls.push(url);
      // Return a valid (empty-ish) response for the enterprise base URL.
      if (url.startsWith("https://github.corp.example.com/api/v3")) {
        if (url.includes("/pulls?")) {
          return new Response(
            JSON.stringify([
              {
                number: 7,
                title: "T",
                html_url: "https://github.corp.example.com/acme/thing/pull/7",
                state: "open",
                updated_at: newer,
                user: { login: "alice" },
                head: { ref: "feat" },
                base: { ref: "main" },
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "wrong host" }), { status: 404 });
    };

    const summaries = await fetchPrActivity(
      {
        owner: "acme",
        repo: "thing",
        sinceMs: since,
        token: "fake",
        host: "github.corp.example.com",
      },
      fetchImpl,
    );
    expect(summaries.map((s) => s.prNumber)).toEqual([7]);
    // Every call should hit the enterprise base URL.
    expect(calls.every((u) => u.startsWith("https://github.corp.example.com/api/v3"))).toBe(true);
  });

  test("drops issue comments without pull_request_url", async () => {
    const since = Date.parse("2026-04-20T00:00:00Z");
    const newer = new Date(since + 60_000).toISOString();
    const fetchImpl = buildMockFetch({
      "/repos/acme/thing/pulls?state=all&sort=updated&direction=desc&per_page=50&page=1": [],
      [`/repos/acme/thing/issues/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [
        {
          id: 1,
          html_url: "https://github.com/acme/thing/issues/100#issuecomment-1",
          body: "plain issue comment",
          user: { login: "x" },
          created_at: newer,
          updated_at: newer,
          issue_url: "https://api.github.com/repos/acme/thing/issues/100",
          // no pull_request_url → plain issue → must be ignored
        },
      ],
      [`/repos/acme/thing/pulls/comments?since=${encodeURIComponent(new Date(since).toISOString())}&per_page=100&sort=updated&direction=asc`]: [],
    });
    const summaries = await fetchPrActivity(
      { owner: "acme", repo: "thing", sinceMs: since, token: "fake" },
      fetchImpl,
    );
    expect(summaries).toEqual([]);
  });
});

describe("resolveApiBaseUrl", () => {
  test("github.com → api.github.com", () => {
    expect(resolveApiBaseUrl("github.com")).toBe("https://api.github.com");
    expect(resolveApiBaseUrl("GITHUB.COM")).toBe("https://api.github.com");
    expect(resolveApiBaseUrl(null)).toBe("https://api.github.com");
    expect(resolveApiBaseUrl("")).toBe("https://api.github.com");
  });

  test("GHES hostname → /api/v3", () => {
    expect(resolveApiBaseUrl("github.corp.example.com")).toBe(
      "https://github.corp.example.com/api/v3",
    );
    expect(resolveApiBaseUrl("github.enterprise.io")).toBe(
      "https://github.enterprise.io/api/v3",
    );
  });
});
