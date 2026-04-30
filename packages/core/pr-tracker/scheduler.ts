import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import {
  getChannelAgentProvider,
  getChannelBaseBranch,
  getChannelSystemMessage,
  getUserGeneralSettings,
  resolveChannelCwd,
} from "@/config";
import {
  DEFAULT_PR_PROMPT_TEMPLATE,
  getPrTrackerById,
  getPrTrackerSettings,
  listDuePrTrackers,
  listProcessedEventIds,
  markPrTrackerPolled,
  recordPrTrackerEvent,
  setPrTrackerCursor,
  type PrTrackerRecord,
} from "@/config/local/pr-trackers";
import { saveSession, type PersistedSession } from "@/config/local/sessions";
import { buildMessageOptions } from "@/core/runtime/message-options";
import {
  buildFinalResponseText,
  categorizeRuntimeError,
} from "@/core/runtime/helpers";
import { buildSessionEnvironment, prepareSessionWorkspace } from "@/core/session";
import { sendChannelMessage as sendDiscordChannelMessage } from "@/ims/discord/client";
import { sendChannelMessage as sendLarkChannelMessage } from "@/ims/lark/client";
import { sendChannelMessage as sendSlackChannelMessage } from "@/ims/slack/client";
import {
  type AgentProviderId,
} from "@/shared/agent-provider";
import { log } from "@/utils";
import {
  fetchPrActivity,
  renderPrompt,
  resolveGitHubToken,
  type PrEvent,
  type PrSummary,
} from "./github";

// ---------------------------------------------------------------------------
// PR Tracker scheduler.
//
// A polling loop that, every N seconds, looks at enabled pr_trackers whose
// resolved interval has elapsed, queries GitHub for new PR activity, and
// dispatches one agent run per PR with new events. The agent's final
// response is posted to the tracker's target channel.
//
// Structurally mirrors packages/core/tasks/scheduler.ts:
//   - Polls SQLite for due rows every PR_POLL_TICK_MS.
//   - Uses an in-memory `runningTrackerIds` guard to avoid overlapping ticks
//     for the same tracker.
//   - Wraps network and agent phases in per-step timeouts so a stuck poll
//     can't deadlock the tick loop.
// ---------------------------------------------------------------------------

const PR_POLL_TICK_MS = 60_000; // loop every 60s; per-tracker cadence is enforced in listDuePrTrackers

const PR_GITHUB_FETCH_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.ODE_PR_TRACKER_FETCH_TIMEOUT_MS,
  60_000,
);

const PR_AGENT_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.ODE_PR_TRACKER_AGENT_TIMEOUT_MS,
  30 * 60_000,
);

/**
 * Safety cap on the number of PRs handled in a single poll for a single
 * tracker. If a repo has been quiet for hours and then a storm of activity
 * arrives, we don't want to fan out dozens of agent runs at once. Excess
 * PRs are recorded as dedupe rows (so the next poll won't re-dispatch
 * them) and surfaced via `markPrTrackerPolled` as a non-fatal warning.
 */
const PR_MAX_PRS_PER_POLL = parsePositiveIntEnv(
  process.env.ODE_PR_TRACKER_MAX_PRS_PER_POLL,
  5,
);

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

class PrStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`${step} timed out after ${timeoutMs}ms`);
    this.name = "PrStepTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrStepTimeoutError(step, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let prTrackerTimer: ReturnType<typeof setInterval> | null = null;
const runningTrackerIds = new Set<string>();

function resolveAgentProvider(tracker: PrTrackerRecord): AgentProviderId {
  // Tracker poll runs use the source channel's configured default agent.
  // No tracker-level override; per-channel agent already lives in the channel
  // settings.
  return getChannelAgentProvider(tracker.sourceChannelId);
}

function resolvePromptTemplate(tracker: PrTrackerRecord): string {
  const override = tracker.promptTemplate?.trim();
  if (override) return override;
  const global = getPrTrackerSettings().defaultPromptTemplate?.trim();
  return global && global.length > 0 ? global : DEFAULT_PR_PROMPT_TEMPLATE;
}

function resolveToken(tracker: PrTrackerRecord): string | null {
  const global = getPrTrackerSettings().defaultGithubToken;
  return resolveGitHubToken({
    trackerToken: tracker.githubToken,
    globalToken: global,
  });
}

async function sendToSourceChannel(
  tracker: PrTrackerRecord,
  text: string,
): Promise<string | undefined> {
  const platform = tracker.sourcePlatform;
  if (platform === "slack") {
    // Per spec: post as a top-level channel message, not threaded.
    return await sendSlackChannelMessage(tracker.sourceChannelId, text);
  }
  if (platform === "discord") {
    return await sendDiscordChannelMessage(tracker.sourceChannelId, text);
  }
  return await sendLarkChannelMessage(tracker.sourceChannelId, text);
}

function syntheticThreadIdForPr(trackerId: string, prNumber: number, ts: number): string {
  return `pr-tracker:${trackerId}:${prNumber}:${ts}`;
}

function buildAgentContext(tracker: PrTrackerRecord, threadId: string): OpenCodeMessageContext {
  return {
    slack: {
      platform: tracker.sourcePlatform,
      channelId: tracker.sourceChannelId,
      threadId,
      userId: `pr-tracker:${tracker.id}`,
      hasGitHubToken: false,
      channelSystemMessage:
        getChannelSystemMessage(tracker.sourceChannelId) ?? undefined,
    },
  };
}

async function prepareAgentSession(
  tracker: PrTrackerRecord,
  prNumber: number,
): Promise<{
  session: PersistedSession;
  sessionId: string;
  cwd: string;
  threadId: string;
  providerId: AgentProviderId;
}> {
  const provider = resolveAgentProvider(tracker);
  const agent = createAgentAdapter({ providerOverride: provider });
  const threadId = syntheticThreadIdForPr(tracker.id, prNumber, Date.now());
  const userId = `pr-tracker:${tracker.id}`;

  let cwd = resolveChannelCwd(tracker.sourceChannelId).cwd;

  const { env: sessionEnv, gitIdentity } = buildSessionEnvironment({
    threadOwnerUserId: userId,
  });

  const { sessionId } = await agent.getOrCreateSession(
    tracker.sourceChannelId,
    threadId,
    cwd,
    sessionEnv,
  );

  if (getUserGeneralSettings().gitStrategy === "worktree") {
    const baseBranch = getChannelBaseBranch(tracker.sourceChannelId);
    const prepared = await prepareSessionWorkspace({
      channelId: tracker.sourceChannelId,
      threadId,
      cwd,
      worktreeId: `ode_pr_${tracker.id.replace(/[^a-zA-Z0-9_-]/g, "_")}_${prNumber}`,
      baseBranch,
      sessionEnv,
      gitIdentity,
    });
    cwd = prepared.cwd;
  }

  const providerId = agent.getProviderForSession(sessionId);
  const session: PersistedSession = {
    sessionId,
    providerId,
    platform: tracker.sourcePlatform,
    channelId: tracker.sourceChannelId,
    threadId,
    workingDirectory: cwd,
    threadOwnerUserId: userId,
    participantBotIds: ["pr-tracker"],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastActivityBotId: "pr-tracker",
  };
  saveSession(session);

  return { session, sessionId, cwd, threadId, providerId };
}

/**
 * Run a single PR's aggregated events through the agent and post the result
 * to the tracker's target channel. Records an `aggregate` event row on
 * success so the next poll won't re-dispatch.
 *
 * Individual per-event dedupe rows are written separately (before dispatch)
 * so that even a partially-failed run leaves a breadcrumb and avoids
 * re-running on the same events the moment the scheduler recovers.
 */
async function runForPr(tracker: PrTrackerRecord, summary: PrSummary): Promise<void> {
  const template = resolvePromptTemplate(tracker);
  const repoFullName = `${tracker.repoOwner}/${tracker.repoName}`;
  const prompt = renderPrompt(template, {
    repoFullName,
    prNumber: summary.prNumber,
    prTitle: summary.title,
    prUrl: summary.url,
    prAuthor: summary.author,
    prState: summary.state,
    headRef: summary.headRef,
    baseRef: summary.baseRef,
    events: summary.events,
  });

  const aggregateEventId = `${summary.prNumber}:${summary.events
    .map((e) => `${e.kind}:${e.githubEventId}`)
    .sort()
    .join("|")}`;

  let agentSessionId: string | null = null;
  try {
    const { sessionId, cwd, threadId, providerId } = await prepareAgentSession(
      tracker,
      summary.prNumber,
    );
    agentSessionId = sessionId;

    const options = buildMessageOptions({
      text: prompt,
      channelId: tracker.sourceChannelId,
      providerId,
    });
    const agent = createAgentAdapter({ providerOverride: providerId });

    const responses = await withTimeout(
      agent.sendMessage(
        tracker.sourceChannelId,
        sessionId,
        prompt,
        cwd,
        options,
        buildAgentContext(tracker, threadId),
      ),
      PR_AGENT_TIMEOUT_MS,
      "PR tracker agent turn",
    );
    const finalText =
      buildFinalResponseText(responses) ?? "_(PR tracker: agent produced no output)_";

    const header = `PR update: <${summary.url}|#${summary.prNumber} ${escapeSlackText(
      summary.title,
    )}> in ${repoFullName}`;
    // Slack-only mrkdwn link; Discord/Lark receive the URL inline.
    const bodyHeader =
      tracker.sourcePlatform === "slack"
        ? header
        : `PR update: #${summary.prNumber} ${summary.title} (${summary.url}) in ${repoFullName}`;
    await sendToSourceChannel(tracker, `${bodyHeader}\n\n${finalText}`);

    // Record per-event dedupe rows + an aggregate row.
    for (const event of summary.events) {
      recordPrTrackerEvent({
        trackerId: tracker.id,
        prNumber: summary.prNumber,
        eventType: event.kind,
        githubEventId: event.githubEventId,
        prUpdatedAt: event.timestamp,
        agentSessionId: sessionId,
        agentStatus: "success",
      });
    }
    recordPrTrackerEvent({
      trackerId: tracker.id,
      prNumber: summary.prNumber,
      eventType: "aggregate",
      githubEventId: aggregateEventId,
      prUpdatedAt: summary.updatedAt,
      agentSessionId: sessionId,
      agentStatus: "success",
    });
  } catch (error) {
    const { message } = categorizeRuntimeError(error);
    log.warn("PR tracker agent run failed", {
      trackerId: tracker.id,
      prNumber: summary.prNumber,
      error: String(error),
    });
    // Record a failed aggregate so operators can inspect the event log.
    recordPrTrackerEvent({
      trackerId: tracker.id,
      prNumber: summary.prNumber,
      eventType: "aggregate",
      githubEventId: aggregateEventId,
      prUpdatedAt: summary.updatedAt,
      agentSessionId,
      agentStatus: "failed",
      errorMessage: message,
    });
    throw error;
  }
}

function escapeSlackText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Filter out events we've already processed in a previous poll, keyed on
 * (tracker, kind, github_event_id).
 */
function dropAlreadyProcessedEvents(
  trackerId: string,
  summaries: PrSummary[],
): PrSummary[] {
  if (summaries.length === 0) return summaries;
  const byKind = new Map<string, string[]>();
  for (const s of summaries) {
    for (const ev of s.events) {
      const list = byKind.get(ev.kind) ?? [];
      list.push(ev.githubEventId);
      byKind.set(ev.kind, list);
    }
  }
  const seenByKind = new Map<string, Set<string>>();
  for (const [kind, ids] of byKind.entries()) {
    seenByKind.set(kind, listProcessedEventIds(trackerId, kind, ids));
  }
  const filtered: PrSummary[] = [];
  for (const s of summaries) {
    const fresh: PrEvent[] = s.events.filter((ev) => {
      const seen = seenByKind.get(ev.kind);
      return !seen || !seen.has(ev.githubEventId);
    });
    if (fresh.length === 0) continue;
    filtered.push({ ...s, events: fresh });
  }
  return filtered;
}

export type PrPollOutcome = {
  trackerId: string;
  prsScanned: number;
  prsHandled: number;
  prsSkipped: number;
  error?: string;
};

/**
 * Run a single tick for one tracker: fetch activity, filter, dispatch.
 * Exported for tests and manual triggers (ode pr-tracker run).
 */
export async function pollTracker(trackerId: string): Promise<PrPollOutcome> {
  const tracker = getPrTrackerById(trackerId);
  if (!tracker) {
    return {
      trackerId,
      prsScanned: 0,
      prsHandled: 0,
      prsSkipped: 0,
      error: "tracker not found",
    };
  }
  if (!tracker.enabled) {
    return {
      trackerId,
      prsScanned: 0,
      prsHandled: 0,
      prsSkipped: 0,
      error: "tracker disabled",
    };
  }

  const token = resolveToken(tracker);
  const since = tracker.lastPolledAt ?? Date.now() - 24 * 60 * 60_000;

  try {
    const summaries = await withTimeout(
      fetchPrActivity({
        owner: tracker.repoOwner,
        repo: tracker.repoName,
        // Route per-tracker host into the REST base URL so Enterprise
        // trackers stop hitting api.github.com.
        host: tracker.repoHost,
        sinceMs: since,
        token,
      }),
      PR_GITHUB_FETCH_TIMEOUT_MS,
      "PR tracker GitHub fetch",
    );

    const fresh = dropAlreadyProcessedEvents(tracker.id, summaries);

    if (fresh.length === 0) {
      markPrTrackerPolled(tracker.id, { success: true });
      return { trackerId, prsScanned: summaries.length, prsHandled: 0, prsSkipped: 0 };
    }

    // Process PRs oldest-updated first so that if we get capped below, the
    // skipped PRs are the most-recently-updated ones (their cursor-based
    // rewind is the cleanest: they'll still show up in the next poll).
    const ordered = [...fresh].sort((a, b) => a.updatedAt - b.updatedAt);
    const handled: PrSummary[] = ordered.slice(0, PR_MAX_PRS_PER_POLL);
    const skippedPrs: PrSummary[] = ordered.slice(PR_MAX_PRS_PER_POLL);

    let hadFailure = false;
    for (const summary of handled) {
      try {
        await runForPr(tracker, summary);
      } catch {
        hadFailure = true;
        // Continue with the next PR — one bad PR shouldn't block the others.
      }
    }

    if (skippedPrs.length > 0) {
      log.info("PR tracker capped PRs in a single poll", {
        trackerId: tracker.id,
        totalPrs: fresh.length,
        handled: handled.length,
        skipped: skippedPrs.length,
      });
    }

    if (hadFailure) {
      // One or more PR dispatches failed. Treat the whole poll as failed so
      // the cursor stays pinned; the next tick will retry.
      markPrTrackerPolled(tracker.id, {
        success: false,
        errorMessage: "one or more PR dispatches failed",
      });
    } else if (skippedPrs.length > 0) {
      // Success from the caller's perspective, but we still have work left.
      // Move the cursor forward only to JUST BEFORE the oldest skipped PR's
      // earliest new event, so the next `since` window keeps the skipped
      // PRs discoverable. This is the trick that keeps capped-out polls
      // lossless across ticks.
      const earliestSkippedTimestamp = earliestEventTimestamp(skippedPrs);
      // Subtract 1ms so `updated_at > since` in the GitHub API still matches
      // the skipped events on the next poll.
      const nextCursor = Math.max(since, earliestSkippedTimestamp - 1);
      setPrTrackerCursor(tracker.id, nextCursor);
      // Also clear any prior `last_error` and refresh last_success_at.
      markPrTrackerPolled(tracker.id, {
        success: true,
        pollCompletedAt: nextCursor,
      });
    } else {
      markPrTrackerPolled(tracker.id, { success: true });
    }

    return {
      trackerId,
      prsScanned: summaries.length,
      prsHandled: handled.length,
      prsSkipped: skippedPrs.length,
      error: hadFailure ? "partial failure" : undefined,
    };
  } catch (error) {
    const { message } = categorizeRuntimeError(error);
    // Failure branch leaves last_polled_at untouched (see
    // markPrTrackerPolled) so the next tick retries the same window.
    markPrTrackerPolled(tracker.id, { success: false, errorMessage: message });
    log.warn("PR tracker poll failed", {
      trackerId: tracker.id,
      repo: `${tracker.repoOwner}/${tracker.repoName}`,
      error: String(error),
    });
    return {
      trackerId,
      prsScanned: 0,
      prsHandled: 0,
      prsSkipped: 0,
      error: message,
    };
  }
}

function earliestEventTimestamp(summaries: PrSummary[]): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const s of summaries) {
    for (const ev of s.events) {
      if (ev.timestamp > 0 && ev.timestamp < earliest) earliest = ev.timestamp;
    }
    // Fall back to the PR's updated_at if for some reason no event has a
    // timestamp (defensive — shouldn't happen with our current event shapes).
    if (s.updatedAt > 0 && s.updatedAt < earliest) earliest = s.updatedAt;
  }
  return Number.isFinite(earliest) ? earliest : Date.now();
}

async function tick(): Promise<void> {
  // Transient SQLite I/O failures during the tick (reading
  // `pr_tracker_settings` / `pr_trackers`) used to surface as unhandled
  // promise rejections in Sentry because the synchronous throw from
  // `listDuePrTrackers` had no catcher inside this async entrypoint.
  // Swallow the error and retry on the next interval.
  let due: ReturnType<typeof listDuePrTrackers>;
  try {
    due = listDuePrTrackers();
  } catch (error) {
    log.warn("PR tracker scheduler tick failed to read due trackers", {
      error: String(error),
    });
    return;
  }
  for (const tracker of due) {
    if (runningTrackerIds.has(tracker.id)) continue;
    runningTrackerIds.add(tracker.id);
    void pollTracker(tracker.id).finally(() => {
      runningTrackerIds.delete(tracker.id);
    });
  }
}

export function startPrTrackerScheduler(): void {
  if (prTrackerTimer) return;
  // Prime a tick so newly-enabled trackers run sooner than the first interval.
  void tick();
  prTrackerTimer = setInterval(() => {
    void tick();
  }, PR_POLL_TICK_MS);
  log.debug("PR tracker scheduler started", { intervalMs: PR_POLL_TICK_MS });
}

export function stopPrTrackerScheduler(): void {
  if (!prTrackerTimer) return;
  clearInterval(prTrackerTimer);
  prTrackerTimer = null;
  runningTrackerIds.clear();
  log.debug("PR tracker scheduler stopped");
}

/**
 * Manual trigger: poll a single tracker immediately. Used by
 * `ode pr-tracker run` and the HTTP run endpoint.
 */
export async function triggerPrTrackerNow(trackerId: string): Promise<PrPollOutcome> {
  if (runningTrackerIds.has(trackerId)) {
    return {
      trackerId,
      prsScanned: 0,
      prsHandled: 0,
      prsSkipped: 0,
      error: "already running",
    };
  }
  runningTrackerIds.add(trackerId);
  try {
    return await pollTracker(trackerId);
  } finally {
    runningTrackerIds.delete(trackerId);
  }
}
