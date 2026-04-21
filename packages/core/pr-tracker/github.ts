import { spawnSync } from "child_process";
import { log } from "@/utils/logger";

// ---------------------------------------------------------------------------
// Minimal GitHub REST client tailored for the PR Tracker scheduler.
//
// Responsibilities:
//  - Resolve an auth token from (per-tracker override → global setting → `gh auth token`).
//  - Fetch recent PR activity since a cursor timestamp: issue comments,
//    review comments, and PRs whose `updated_at` moved, plus per-PR reviews.
//  - Aggregate those pieces into a per-PR event bundle the scheduler can
//    turn into a single agent run.
//
// We deliberately keep this client narrow: just enough surface to power the
// tracker. Heavier GitHub orchestration should live elsewhere.
// ---------------------------------------------------------------------------

const USER_AGENT = "ode-pr-tracker";
const DEFAULT_BASE = "https://api.github.com";

export type PrEventKind = "comment" | "review_comment" | "review" | "pr_updated";

export type PrEvent = {
  kind: PrEventKind;
  /** Stable GitHub id for dedupe (comment id / review id / pr node). */
  githubEventId: string;
  /** Event timestamp (ms since epoch). */
  timestamp: number;
  /** Commenting / reviewing user (falls back to "unknown"). */
  author: string;
  /** Short preview body used when rendering the prompt summary. */
  body: string;
  /** Extra metadata we expose to the prompt (review state, etc.). */
  meta?: Record<string, string>;
};

export type PrSummary = {
  prNumber: number;
  title: string;
  url: string;
  author: string;
  state: string;
  headRef: string | null;
  baseRef: string | null;
  updatedAt: number;
  /** All new events seen in this poll, oldest first. */
  events: PrEvent[];
};

export type FetchActivityOptions = {
  owner: string;
  repo: string;
  /** Cursor: fetch activity with updated_at strictly after this ms timestamp. */
  sinceMs: number;
  /** Optional explicit token. If omitted, resolved via {@link resolveGitHubToken}. */
  token?: string | null;
  /**
   * Override the REST base URL (useful for tests / GHES). Takes precedence
   * over `host` when both are set.
   */
  baseUrl?: string;
  /**
   * GitHub hostname (e.g. "github.com" or "github.corp.example.com"). When
   * provided and `baseUrl` is not, we resolve the REST endpoint per host:
   *   - github.com          → https://api.github.com
   *   - anything else       → https://<host>/api/v3 (GHES convention)
   */
  host?: string | null;
};

/**
 * Map a GitHub hostname to its REST API base URL.
 *
 * github.com uses the public `api.github.com` subdomain; GitHub Enterprise
 * Server (GHES) instances expose the REST API under `/api/v3` on the same
 * hostname. This helper encapsulates that convention so callers don't have
 * to care.
 */
export function resolveApiBaseUrl(host: string | null | undefined): string {
  const trimmed = (host ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "github.com" || trimmed === "api.github.com") {
    return DEFAULT_BASE;
  }
  return `https://${trimmed}/api/v3`;
}

// ---------------------------------------------------------------------------
// Token resolution.
// ---------------------------------------------------------------------------

export type TokenResolutionInput = {
  /** Tracker-level override. */
  trackerToken?: string | null;
  /** Global PR Tracker setting. */
  globalToken?: string | null;
};

/**
 * Resolve a GitHub token using the documented fallback chain:
 *   1. Tracker-specific token (if non-empty).
 *   2. Global PR Tracker default (if non-empty).
 *   3. `gh auth token` from the local GitHub CLI (if installed and logged in).
 *
 * Returns null if no token is available.
 */
export function resolveGitHubToken(input: TokenResolutionInput): string | null {
  const tracker = input.trackerToken?.trim();
  if (tracker) return tracker;
  const global = input.globalToken?.trim();
  if (global) return global;

  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out || null;
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper.
// ---------------------------------------------------------------------------

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type RequestContext = {
  baseUrl: string;
  token: string | null;
  fetchImpl: FetchFn;
};

function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubGet<T>(ctx: RequestContext, pathAndQuery: string): Promise<T> {
  const url = pathAndQuery.startsWith("http")
    ? pathAndQuery
    : `${ctx.baseUrl}${pathAndQuery}`;
  const response = await ctx.fetchImpl(url, { headers: buildHeaders(ctx.token) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GitHub request failed: ${response.status} ${response.statusText} — ${truncate(text, 300)}`,
    );
  }
  return (await response.json()) as T;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

// ---------------------------------------------------------------------------
// GitHub response shapes (narrow subset we actually use).
// ---------------------------------------------------------------------------

type GhUser = { login?: string | null } | null | undefined;

type GhIssueComment = {
  id: number;
  html_url: string;
  body: string | null;
  user: GhUser;
  created_at: string;
  updated_at: string;
  issue_url: string;
  /**
   * Set by GitHub when the comment is on a pull request (REST returns
   * `issues/{n}` for both PRs and plain issues; `pull_request_url` is the
   * disambiguator). Absent on plain issue comments. We rely on this to
   * filter `/issues/comments` results down to PR-only.
   */
  pull_request_url?: string | null;
};

type GhReviewComment = {
  id: number;
  html_url: string;
  body: string | null;
  user: GhUser;
  created_at: string;
  updated_at: string;
  pull_request_url: string;
};

type GhReview = {
  id: number;
  user: GhUser;
  state: string;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
};

type GhPullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  user: GhUser;
  head: { ref?: string | null } | null;
  base: { ref?: string | null } | null;
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function toMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function prNumberFromIssueUrl(issueUrl: string): number | null {
  const m = issueUrl.match(/\/issues\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function prNumberFromPullUrl(pullUrl: string): number | null {
  const m = pullUrl.match(/\/pulls\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function loginOf(user: GhUser): string {
  return user?.login?.trim() || "unknown";
}

/**
 * Unwrap a `Promise.allSettled` result: return the fulfilled array, or log +
 * record the failure and fall back to an empty list. Lets callers collect
 * partial results with a single trip through the list of settled results.
 */
function extractSettled<T>(
  settled: PromiseSettledResult<T[]>,
  label: string,
  failures: Error[],
): T[] {
  if (settled.status === "fulfilled") return settled.value;
  const err = settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason));
  failures.push(new Error(`${label}: ${err.message}`));
  log.warn(`pr-tracker: ${label} failed`, { err: String(err) });
  return [];
}

// ---------------------------------------------------------------------------
// Fetchers — one per GitHub endpoint we care about.
//
// Each returns the full page contents, filtered to the caller's `sinceMs`
// cursor where the GitHub API's `since` param isn't exact (reviews lack a
// server-side cursor, so we fetch and filter).
// ---------------------------------------------------------------------------

async function fetchIssueComments(
  ctx: RequestContext,
  owner: string,
  repo: string,
  sinceIso: string,
): Promise<GhIssueComment[]> {
  return githubGet<GhIssueComment[]>(
    ctx,
    `/repos/${owner}/${repo}/issues/comments?since=${encodeURIComponent(sinceIso)}&per_page=100&sort=updated&direction=asc`,
  );
}

async function fetchReviewComments(
  ctx: RequestContext,
  owner: string,
  repo: string,
  sinceIso: string,
): Promise<GhReviewComment[]> {
  return githubGet<GhReviewComment[]>(
    ctx,
    `/repos/${owner}/${repo}/pulls/comments?since=${encodeURIComponent(sinceIso)}&per_page=100&sort=updated&direction=asc`,
  );
}

async function fetchRecentlyUpdatedPulls(
  ctx: RequestContext,
  owner: string,
  repo: string,
  sinceMs: number,
): Promise<GhPullRequest[]> {
  // GitHub's pulls endpoint doesn't support `since`, but sorted by updated
  // descending lets us stop at the first PR older than our cursor. We cap
  // pagination to avoid runaway loops on large repos.
  const pageSize = 50;
  const maxPages = 4;
  const collected: GhPullRequest[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await githubGet<GhPullRequest[]>(
      ctx,
      `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    let reachedCursor = false;
    for (const pr of batch) {
      if (toMs(pr.updated_at) <= sinceMs) {
        reachedCursor = true;
        break;
      }
      collected.push(pr);
    }
    if (reachedCursor || batch.length < pageSize) break;
  }
  return collected;
}

async function fetchReviewsForPr(
  ctx: RequestContext,
  owner: string,
  repo: string,
  prNumber: number,
  sinceMs: number,
): Promise<GhReview[]> {
  const reviews = await githubGet<GhReview[]>(
    ctx,
    `/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
  );
  return reviews.filter((r) => toMs(r.submitted_at) > sinceMs);
}

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

function toPrEventFromIssueComment(c: GhIssueComment): PrEvent | null {
  // `/issues/comments` mixes PR-thread comments with comments on plain
  // issues. GitHub populates `pull_request_url` only on PR-thread comments,
  // so we use its presence as the disambiguator. If it's absent we drop
  // the event entirely — otherwise the tracker would fabricate a PR bucket
  // for a regular issue number and dispatch a bogus "PR update" agent run.
  const prUrl = c.pull_request_url?.trim();
  if (!prUrl) return null;
  const prNumber = prNumberFromPullUrl(prUrl) ?? prNumberFromIssueUrl(c.issue_url);
  if (!prNumber) return null;
  return {
    kind: "comment",
    githubEventId: String(c.id),
    timestamp: toMs(c.updated_at || c.created_at),
    author: loginOf(c.user),
    body: (c.body ?? "").trim(),
    meta: { url: c.html_url, prNumber: String(prNumber) },
  };
}

function toPrEventFromReviewComment(c: GhReviewComment): PrEvent {
  return {
    kind: "review_comment",
    githubEventId: String(c.id),
    timestamp: toMs(c.updated_at || c.created_at),
    author: loginOf(c.user),
    body: (c.body ?? "").trim(),
    meta: { url: c.html_url },
  };
}

function toPrEventFromReview(r: GhReview): PrEvent {
  return {
    kind: "review",
    githubEventId: String(r.id),
    timestamp: toMs(r.submitted_at),
    author: loginOf(r.user),
    body: (r.body ?? "").trim(),
    meta: { url: r.html_url, state: r.state },
  };
}

function toPrEventFromPr(pr: GhPullRequest): PrEvent {
  return {
    kind: "pr_updated",
    // pr_updated_at isn't a stable "event id", so we synthesize one keyed on
    // the updated_at timestamp; the scheduler's dedupe key is
    // (tracker, kind, id) so this stays idempotent within a single cursor
    // window without flooding the events table on every poll.
    githubEventId: `pr-${pr.number}-${toMs(pr.updated_at)}`,
    timestamp: toMs(pr.updated_at),
    author: loginOf(pr.user),
    body: pr.title ?? "",
    meta: { url: pr.html_url, state: pr.state },
  };
}

/**
 * Fetch PR activity for a repo since `sinceMs`, bucketed by PR number.
 *
 * Strategy:
 *   1. Pull recently-updated PRs (to capture state changes / syncs and to
 *      discover which PRs to look up reviews for). Results are capped to a
 *      handful of pages so a huge active repo doesn't blow up.
 *   2. Pull issue + review comments updated since the cursor.
 *   3. For every PR we touched in steps 1 & 2, pull its reviews and filter
 *      to ones submitted after the cursor.
 *   4. Group everything by PR number and build a PrSummary per PR. PRs with
 *      zero qualifying events are omitted.
 *
 * The cursor is exclusive on the server side (`since` semantics in GitHub
 * are "updated_at >= since", but we additionally filter `timestamp > sinceMs`
 * on our side so a stale cursor doesn't double-fire an event).
 */
/**
 * Thrown by {@link fetchPrActivity} when none of the core GitHub queries
 * succeed. Lets the scheduler distinguish "repo is quiet" (empty result)
 * from "we have no idea what's going on" (broken auth, 5xx, rate limit),
 * so the caller can choose not to advance the poll cursor.
 */
export class GitHubActivityFetchError extends Error {
  readonly causes: Error[];
  constructor(message: string, causes: Error[]) {
    super(message);
    this.name = "GitHubActivityFetchError";
    this.causes = causes;
  }
}

export async function fetchPrActivity(
  options: FetchActivityOptions,
  fetchImpl: FetchFn = fetch,
): Promise<PrSummary[]> {
  const token = options.token !== undefined
    ? options.token
    : resolveGitHubToken({});
  const resolvedBase = options.baseUrl?.trim()
    ? options.baseUrl.replace(/\/$/, "")
    : resolveApiBaseUrl(options.host);
  const ctx: RequestContext = {
    baseUrl: resolvedBase,
    token,
    fetchImpl,
  };

  const sinceMs = Math.max(0, Math.floor(options.sinceMs));
  const sinceIso = new Date(sinceMs || 0).toISOString();

  // Run the three high-level queries in parallel — they hit different
  // endpoints and don't share pagination state. We use `allSettled` so that
  // a single endpoint failure degrades to partial results, while a total
  // failure (every endpoint rejected) is surfaced to the scheduler — in
  // that case we MUST NOT let the caller treat the empty list as "no
  // activity" and advance the poll cursor.
  const [pullsResult, issueCommentsResult, reviewCommentsResult] = await Promise.allSettled([
    fetchRecentlyUpdatedPulls(ctx, options.owner, options.repo, sinceMs),
    fetchIssueComments(ctx, options.owner, options.repo, sinceIso),
    fetchReviewComments(ctx, options.owner, options.repo, sinceIso),
  ]);

  const failures: Error[] = [];
  const pulls = extractSettled(pullsResult, "pulls list", failures);
  const issueComments = extractSettled(issueCommentsResult, "issue comments", failures);
  const reviewComments = extractSettled(reviewCommentsResult, "review comments", failures);

  if (failures.length >= 3) {
    throw new GitHubActivityFetchError(
      `All GitHub endpoints failed while fetching activity for ${options.owner}/${options.repo}: ${failures[0]!.message}`,
      failures,
    );
  }

  // Index PRs we've already seen (mix: recent updates + PRs referenced by
  // comments). A single pass keeps bucket construction cheap.
  const bucketByPr = new Map<number, PrSummary>();
  const ensureBucket = (prNumber: number, prMeta?: GhPullRequest): PrSummary => {
    let bucket = bucketByPr.get(prNumber);
    if (!bucket) {
      bucket = {
        prNumber,
        title: prMeta?.title ?? `#${prNumber}`,
        url: prMeta?.html_url ?? "",
        author: loginOf(prMeta?.user),
        state: prMeta?.state ?? "unknown",
        headRef: prMeta?.head?.ref ?? null,
        baseRef: prMeta?.base?.ref ?? null,
        updatedAt: toMs(prMeta?.updated_at),
        events: [],
      };
      bucketByPr.set(prNumber, bucket);
    } else if (prMeta) {
      // Upgrade the bucket with richer metadata if we see the full PR after
      // an initial stub.
      bucket.title = prMeta.title || bucket.title;
      bucket.url = prMeta.html_url || bucket.url;
      bucket.author = loginOf(prMeta.user) || bucket.author;
      bucket.state = prMeta.state || bucket.state;
      bucket.headRef = prMeta.head?.ref ?? bucket.headRef;
      bucket.baseRef = prMeta.base?.ref ?? bucket.baseRef;
      bucket.updatedAt = Math.max(bucket.updatedAt, toMs(prMeta.updated_at));
    }
    return bucket;
  };

  for (const pr of pulls) {
    const bucket = ensureBucket(pr.number, pr);
    bucket.events.push(toPrEventFromPr(pr));
  }

  for (const c of issueComments) {
    if (toMs(c.updated_at || c.created_at) <= sinceMs) continue;
    const ev = toPrEventFromIssueComment(c);
    if (!ev) continue; // skip non-PR issue comments
    const prNumberFromMeta = Number(ev.meta?.prNumber);
    if (!Number.isFinite(prNumberFromMeta)) continue;
    const bucket = ensureBucket(prNumberFromMeta);
    bucket.events.push(ev);
  }

  for (const c of reviewComments) {
    if (toMs(c.updated_at || c.created_at) <= sinceMs) continue;
    const prNumber = prNumberFromPullUrl(c.pull_request_url);
    if (!prNumber) continue;
    const bucket = ensureBucket(prNumber);
    bucket.events.push(toPrEventFromReviewComment(c));
  }

  // Pull reviews for every bucket we now have. Done sequentially per-PR to
  // keep the request fan-out bounded; most polls touch ≤ a handful of PRs.
  for (const bucket of bucketByPr.values()) {
    try {
      const reviews = await fetchReviewsForPr(
        ctx,
        options.owner,
        options.repo,
        bucket.prNumber,
        sinceMs,
      );
      for (const r of reviews) bucket.events.push(toPrEventFromReview(r));
    } catch (err) {
      log.warn("pr-tracker: reviews fetch failed", {
        owner: options.owner,
        repo: options.repo,
        prNumber: bucket.prNumber,
        err: String(err),
      });
    }
  }

  // Drop buckets with zero qualifying events (e.g. a PR that only rolled
  // over its `updated_at` before our cursor due to clock skew).
  const summaries: PrSummary[] = [];
  for (const bucket of bucketByPr.values()) {
    if (bucket.events.length === 0) continue;
    bucket.events.sort((a, b) => a.timestamp - b.timestamp);
    summaries.push(bucket);
  }
  // Stable deterministic ordering: oldest updated first so downstream
  // processing preserves causal ordering in output.
  summaries.sort((a, b) => a.updatedAt - b.updatedAt);
  return summaries;
}

// ---------------------------------------------------------------------------
// Prompt rendering helpers (used by scheduler, factored here to keep the
// templating next to the GitHub response shapes).
// ---------------------------------------------------------------------------

const MAX_EVENTS_IN_SUMMARY = 20;
const MAX_EVENT_BODY_CHARS = 400;

export function renderEventsSummary(events: PrEvent[]): string {
  if (events.length === 0) return "(no new events)";
  const capped = events.slice(-MAX_EVENTS_IN_SUMMARY);
  const hidden = events.length - capped.length;
  const lines = capped.map((ev) => {
    const kindLabel =
      ev.kind === "comment"
        ? "Comment"
        : ev.kind === "review_comment"
          ? "Review comment"
          : ev.kind === "review"
            ? `Review (${ev.meta?.state ?? "commented"})`
            : "PR update";
    const body = ev.body ? ` — ${truncate(ev.body.replace(/\s+/g, " "), MAX_EVENT_BODY_CHARS)}` : "";
    return `- [${kindLabel}] @${ev.author}${body}`;
  });
  if (hidden > 0) {
    lines.unshift(`...and ${hidden} older event(s) omitted`);
  }
  return lines.join("\n");
}

export function renderPrompt(
  template: string,
  context: {
    repoFullName: string;
    prNumber: number;
    prTitle: string;
    prUrl: string;
    prAuthor: string;
    prState: string;
    headRef: string | null;
    baseRef: string | null;
    events: PrEvent[];
  },
): string {
  const summary = renderEventsSummary(context.events);
  const replacements: Record<string, string> = {
    "{{repo_full_name}}": context.repoFullName,
    "{{pr_number}}": String(context.prNumber),
    "{{pr_title}}": context.prTitle,
    "{{pr_url}}": context.prUrl,
    "{{pr_author}}": context.prAuthor,
    "{{pr_state}}": context.prState,
    "{{pr_head_ref}}": context.headRef ?? "",
    "{{pr_base_ref}}": context.baseRef ?? "",
    "{{new_events_summary}}": summary,
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}
