import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AGENT_PROVIDERS, isAgentProviderId } from "@/shared/agent-provider";
import { getGitHubRepoFromCwd, type GitHubRepo } from "@/utils/git-remote";
import { loadOdeConfig } from "./ode-store";

// ---------------------------------------------------------------------------
// PR Tracker storage.
//
// A "PR tracker" watches one GitHub repo (derived from a channel's
// workingDirectory) and, when enabled, lets the scheduler periodically poll
// GitHub for new PR activity, aggregate events per PR, and dispatch an
// agent run that posts back to a configured target channel.
//
// Three tables share the same SQLite DB as tasks/cron (`~/.config/ode/inbox.db`):
//
//   pr_trackers          - one row per (source channel, github repo)
//   pr_tracker_events    - per-PR-event audit + dedupe log
//   pr_tracker_settings  - single-row global defaults (id = 1)
// ---------------------------------------------------------------------------

export type PrTrackerPlatform = "slack" | "discord" | "lark";

export type PrTrackerRecord = {
  id: string;
  /** Source channel: where the working directory comes from. */
  sourceWorkspaceId: string;
  sourceWorkspaceName: string | null;
  sourceChannelId: string;
  sourceChannelName: string | null;
  sourcePlatform: PrTrackerPlatform;
  workingDirectory: string;
  repoOwner: string;
  repoName: string;
  repoHost: string;
  enabled: boolean;
  /** Null = use global default. */
  agentProvider: string | null;
  /** Null = use global default. */
  promptTemplate: string | null;
  /** Null = use global default. */
  pollIntervalSec: number | null;
  /** Null = use global default token / gh CLI fallback. */
  githubToken: string | null;
  /** Where the agent result is posted. Required to be set before enable. */
  targetWorkspaceId: string | null;
  targetChannelId: string | null;
  targetChannelName: string | null;
  targetPlatform: PrTrackerPlatform | null;
  /**
   * Cursor: last successful poll completion. The next poll asks GitHub for
   * comments/reviews `since` this timestamp. Set to `now` when the tracker
   * is first enabled (we don't backfill history).
   */
  lastPolledAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /**
   * When non-null, the most recent rescan didn't find this repo at the
   * source channel's working directory anymore (cwd missing or remote
   * changed). UI greys the row out; user can delete it.
   */
  missingSince: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PrTrackerEventStatus = "pending" | "running" | "success" | "failed";

export type PrTrackerEventRecord = {
  id: string;
  trackerId: string;
  prNumber: number;
  /** "comment" | "review" | "review_comment" | "push" | "state_change" | "aggregate" */
  eventType: string;
  /** GitHub object id (comment id / review id / event id). */
  githubEventId: string;
  prUpdatedAt: number | null;
  agentSessionId: string | null;
  agentStatus: PrTrackerEventStatus;
  errorMessage: string | null;
  createdAt: number;
};

export type PrTrackerSettings = {
  defaultPollIntervalSec: number;
  defaultAgentProvider: string;
  defaultPromptTemplate: string;
  /** Optional global GitHub token. Empty string = fall back to `gh auth token`. */
  defaultGithubToken: string;
  updatedAt: number;
};

export const DEFAULT_PR_POLL_INTERVAL_SEC = 30 * 60; // 30 minutes
export const DEFAULT_PR_AGENT_PROVIDER = "opencode";
export const DEFAULT_PR_PROMPT_TEMPLATE = `A pull request in {{repo_full_name}} has new activity:
PR #{{pr_number}}: {{pr_title}} by {{pr_author}}
URL: {{pr_url}}

New events since last check:
{{new_events_summary}}

Please review these updates, decide if action is needed (reply, assign, flag), and take the next step.`;

// ---------------------------------------------------------------------------
// Database boilerplate (mirrors tasks.ts / cron-jobs.ts patterns).
// ---------------------------------------------------------------------------

const existsSync = fs.existsSync;
const mkdirSync = fs.mkdirSync;
const join = typeof path.join === "function" ? path.join : (...parts: string[]) => parts.join("/");
const homedir = typeof os.homedir === "function" ? os.homedir : () => "";

const ODE_CONFIG_DIR = join(homedir(), ".config", "ode");
const DEFAULT_DB_FILE = join(ODE_CONFIG_DIR, "inbox.db");

let cachedDatabase: { path: string; db: Database } | null = null;

function resolveDbFile(): string {
  const override = process.env.ODE_INBOX_DB_FILE?.trim();
  return override && override.length > 0 ? override : DEFAULT_DB_FILE;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function initializeDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_trackers (
      id TEXT PRIMARY KEY,
      source_workspace_id TEXT NOT NULL,
      source_workspace_name TEXT,
      source_channel_id TEXT NOT NULL,
      source_channel_name TEXT,
      source_platform TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_host TEXT NOT NULL DEFAULT 'github.com',
      enabled INTEGER NOT NULL DEFAULT 0,
      agent_provider TEXT,
      prompt_template TEXT,
      poll_interval_sec INTEGER,
      github_token TEXT,
      target_workspace_id TEXT,
      target_channel_id TEXT,
      target_channel_name TEXT,
      target_platform TEXT,
      last_polled_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT,
      missing_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_workspace_id, source_channel_id, repo_host, repo_owner, repo_name)
    );
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pr_trackers_enabled_polled ON pr_trackers(enabled, last_polled_at);"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pr_trackers_source_channel ON pr_trackers(source_workspace_id, source_channel_id);"
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_tracker_events (
      id TEXT PRIMARY KEY,
      tracker_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      github_event_id TEXT NOT NULL,
      pr_updated_at INTEGER,
      agent_session_id TEXT,
      agent_status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(tracker_id, event_type, github_event_id)
    );
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pr_tracker_events_tracker ON pr_tracker_events(tracker_id, created_at DESC);"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_pr_tracker_events_pr ON pr_tracker_events(tracker_id, pr_number, created_at DESC);"
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_tracker_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_poll_interval_sec INTEGER NOT NULL,
      default_agent_provider TEXT NOT NULL,
      default_prompt_template TEXT NOT NULL,
      default_github_token TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);
}

function getDatabase(): Database {
  const filePath = resolveDbFile();
  if (cachedDatabase?.path === filePath) {
    return cachedDatabase.db;
  }

  if (cachedDatabase) {
    try {
      cachedDatabase.db.close();
    } catch {
      // Ignore close errors on path switch.
    }
  }

  ensureParentDir(filePath);
  const db = new Database(filePath);
  initializeDatabase(db);
  cachedDatabase = { path: filePath, db };
  return db;
}

// ---------------------------------------------------------------------------
// Row mappers.
// ---------------------------------------------------------------------------

type PrTrackerRow = {
  id: string;
  source_workspace_id: string;
  source_workspace_name: string | null;
  source_channel_id: string;
  source_channel_name: string | null;
  source_platform: PrTrackerPlatform;
  working_directory: string;
  repo_owner: string;
  repo_name: string;
  repo_host: string;
  enabled: number;
  agent_provider: string | null;
  prompt_template: string | null;
  poll_interval_sec: number | null;
  github_token: string | null;
  target_workspace_id: string | null;
  target_channel_id: string | null;
  target_channel_name: string | null;
  target_platform: PrTrackerPlatform | null;
  last_polled_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  missing_since: number | null;
  created_at: number;
  updated_at: number;
};

function mapTrackerRow(row: PrTrackerRow): PrTrackerRecord {
  return {
    id: row.id,
    sourceWorkspaceId: row.source_workspace_id,
    sourceWorkspaceName: row.source_workspace_name,
    sourceChannelId: row.source_channel_id,
    sourceChannelName: row.source_channel_name,
    sourcePlatform: row.source_platform,
    workingDirectory: row.working_directory,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoHost: row.repo_host,
    enabled: row.enabled === 1,
    agentProvider: row.agent_provider,
    promptTemplate: row.prompt_template,
    pollIntervalSec: row.poll_interval_sec,
    githubToken: row.github_token,
    targetWorkspaceId: row.target_workspace_id,
    targetChannelId: row.target_channel_id,
    targetChannelName: row.target_channel_name,
    targetPlatform: row.target_platform,
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    missingSince: row.missing_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type PrTrackerEventRow = {
  id: string;
  tracker_id: string;
  pr_number: number;
  event_type: string;
  github_event_id: string;
  pr_updated_at: number | null;
  agent_session_id: string | null;
  agent_status: PrTrackerEventStatus;
  error_message: string | null;
  created_at: number;
};

function mapEventRow(row: PrTrackerEventRow): PrTrackerEventRecord {
  return {
    id: row.id,
    trackerId: row.tracker_id,
    prNumber: row.pr_number,
    eventType: row.event_type,
    githubEventId: row.github_event_id,
    prUpdatedAt: row.pr_updated_at,
    agentSessionId: row.agent_session_id,
    agentStatus: row.agent_status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Settings (single row, id=1).
// ---------------------------------------------------------------------------

function ensureSettingsRow(db: Database): void {
  const existing = db.query("SELECT id FROM pr_tracker_settings WHERE id = 1").get();
  if (existing) return;
  const now = Date.now();
  db.query(`
    INSERT INTO pr_tracker_settings (
      id,
      default_poll_interval_sec,
      default_agent_provider,
      default_prompt_template,
      default_github_token,
      updated_at
    ) VALUES (1, ?, ?, ?, '', ?)
  `).run(
    DEFAULT_PR_POLL_INTERVAL_SEC,
    DEFAULT_PR_AGENT_PROVIDER,
    DEFAULT_PR_PROMPT_TEMPLATE,
    now
  );
}

export function getPrTrackerSettings(): PrTrackerSettings {
  const db = getDatabase();
  ensureSettingsRow(db);
  const row = db
    .query(`
      SELECT
        default_poll_interval_sec,
        default_agent_provider,
        default_prompt_template,
        default_github_token,
        updated_at
      FROM pr_tracker_settings
      WHERE id = 1
    `)
    .get() as {
      default_poll_interval_sec: number;
      default_agent_provider: string;
      default_prompt_template: string;
      default_github_token: string;
      updated_at: number;
    };
  return {
    defaultPollIntervalSec: row.default_poll_interval_sec,
    defaultAgentProvider: row.default_agent_provider,
    defaultPromptTemplate: row.default_prompt_template,
    defaultGithubToken: row.default_github_token,
    updatedAt: row.updated_at,
  };
}

export type UpdatePrTrackerSettingsParams = Partial<{
  defaultPollIntervalSec: number;
  defaultAgentProvider: string;
  defaultPromptTemplate: string;
  defaultGithubToken: string;
}>;

export function updatePrTrackerSettings(
  params: UpdatePrTrackerSettingsParams
): PrTrackerSettings {
  const db = getDatabase();
  ensureSettingsRow(db);
  const current = getPrTrackerSettings();

  const pollInterval =
    params.defaultPollIntervalSec !== undefined
      ? normalizePollInterval(params.defaultPollIntervalSec)
      : current.defaultPollIntervalSec;
  const agentProvider =
    params.defaultAgentProvider !== undefined
      ? normalizeRequiredAgent(params.defaultAgentProvider)
      : current.defaultAgentProvider;
  const promptTemplate =
    params.defaultPromptTemplate !== undefined
      ? normalizeRequiredText(params.defaultPromptTemplate, "promptTemplate")
      : current.defaultPromptTemplate;
  const githubToken =
    params.defaultGithubToken !== undefined
      ? params.defaultGithubToken.trim()
      : current.defaultGithubToken;

  const now = Date.now();
  db.query(`
    UPDATE pr_tracker_settings
    SET
      default_poll_interval_sec = ?,
      default_agent_provider = ?,
      default_prompt_template = ?,
      default_github_token = ?,
      updated_at = ?
    WHERE id = 1
  `).run(pollInterval, agentProvider, promptTemplate, githubToken, now);

  return getPrTrackerSettings();
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function normalizePollInterval(value: number): number {
  if (!Number.isFinite(value) || value < 60) {
    throw new Error("Poll interval must be at least 60 seconds");
  }
  return Math.floor(value);
}

function normalizeOptionalAgent(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (!isAgentProviderId(trimmed)) {
    throw new Error(
      `Unsupported agent "${value}". Expected one of: ${AGENT_PROVIDERS.join(", ")}`
    );
  }
  return trimmed;
}

function normalizeRequiredAgent(value: string): string {
  const out = normalizeOptionalAgent(value);
  if (!out) throw new Error("agentProvider is required");
  return out;
}

function normalizeRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} cannot be empty`);
  return trimmed;
}

function resolveConfigChannelId(channelId: string): string {
  const trimmed = channelId.trim();
  if (!trimmed) return trimmed;
  const delimiter = "::";
  const index = trimmed.lastIndexOf(delimiter);
  if (index < 0) return trimmed;
  const raw = trimmed.slice(index + delimiter.length).trim();
  return raw || trimmed;
}

type ChannelSnapshot = {
  platform: PrTrackerPlatform;
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  channelName: string;
  workingDirectory: string;
};

function getChannelSnapshot(channelId: string): ChannelSnapshot {
  const resolved = resolveConfigChannelId(channelId);
  const config = loadOdeConfig();
  for (const workspace of config.workspaces) {
    const channel = workspace.channelDetails.find((item) => item.id === resolved);
    if (!channel) continue;
    return {
      platform: workspace.type,
      workspaceId: workspace.id,
      workspaceName: workspace.name || workspace.id,
      channelId: channel.id,
      channelName: channel.name || channel.id,
      workingDirectory: channel.workingDirectory?.trim() || "",
    };
  }
  throw new Error(`Channel ${channelId} not found in configured workspaces`);
}

function getChannelSnapshotForTarget(channelId: string): {
  platform: PrTrackerPlatform;
  workspaceId: string;
  channelId: string;
  channelName: string;
} {
  const snap = getChannelSnapshot(channelId);
  return {
    platform: snap.platform,
    workspaceId: snap.workspaceId,
    channelId: snap.channelId,
    channelName: snap.channelName,
  };
}

// ---------------------------------------------------------------------------
// Scan: walk every workspace channel, derive (cwd, github repo) pairs, and
// upsert pr_trackers rows so the UI can list them. Existing rows are kept
// (config preserved); rows whose source no longer points at the same repo
// are flagged with `missing_since`.
// ---------------------------------------------------------------------------

export type PrTrackerScanResult = {
  scanned: number;
  inserted: number;
  reactivated: number;
  markedMissing: number;
};

export type PrTrackerScanProbe = (cwd: string) => GitHubRepo | null;

/**
 * Rescan all channels and reconcile pr_trackers with what's currently on disk.
 *
 * Behavior:
 *  - For each channel with a workingDirectory, probe its git remote.
 *  - If we can derive a GitHub repo: upsert a pr_trackers row.
 *      * New row → enabled=0, defaults inherited.
 *      * Existing row that was marked missing → clear `missing_since`.
 *      * Existing row that already matches → only refresh derived metadata
 *        (workingDirectory, channel/workspace names).
 *  - For each existing tracker whose channel/cwd no longer maps to the same
 *    repo (or whose cwd disappeared), mark `missing_since = now`. Rows are
 *    NEVER auto-deleted; users keep the row until they choose to delete.
 *
 * `probe` is injectable for testing; defaults to `getGitHubRepoFromCwd`.
 */
export function scanPrTrackers(probe: PrTrackerScanProbe = getGitHubRepoFromCwd): PrTrackerScanResult {
  const db = getDatabase();
  const config = loadOdeConfig();
  const now = Date.now();

  const result: PrTrackerScanResult = {
    scanned: 0,
    inserted: 0,
    reactivated: 0,
    markedMissing: 0,
  };

  // Build a map of currently-found (workspaceId|channelId|host|owner|repo)
  // so we can detect which existing trackers no longer apply.
  const foundKeys = new Set<string>();

  for (const workspace of config.workspaces) {
    for (const channel of workspace.channelDetails) {
      const cwd = channel.workingDirectory?.trim();
      if (!cwd) continue;
      result.scanned += 1;

      let repo: GitHubRepo | null = null;
      try {
        repo = probe(cwd);
      } catch {
        repo = null;
      }
      if (!repo) continue;

      const key = `${workspace.id}|${channel.id}|${repo.host}|${repo.owner}|${repo.repo}`;
      foundKeys.add(key);

      const existing = db
        .query(`
          SELECT * FROM pr_trackers
          WHERE source_workspace_id = ?
            AND source_channel_id = ?
            AND repo_host = ?
            AND repo_owner = ?
            AND repo_name = ?
        `)
        .get(workspace.id, channel.id, repo.host, repo.owner, repo.repo) as
        | PrTrackerRow
        | null;

      if (!existing) {
        const id = crypto.randomUUID();
        db.query(`
          INSERT INTO pr_trackers (
            id,
            source_workspace_id,
            source_workspace_name,
            source_channel_id,
            source_channel_name,
            source_platform,
            working_directory,
            repo_owner,
            repo_name,
            repo_host,
            enabled,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          id,
          workspace.id,
          workspace.name || workspace.id,
          channel.id,
          channel.name || channel.id,
          workspace.type,
          cwd,
          repo.owner,
          repo.repo,
          repo.host,
          now,
          now
        );
        result.inserted += 1;
      } else {
        const wasMissing = existing.missing_since !== null;
        db.query(`
          UPDATE pr_trackers
          SET
            source_workspace_name = ?,
            source_channel_name = ?,
            source_platform = ?,
            working_directory = ?,
            missing_since = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(
          workspace.name || workspace.id,
          channel.name || channel.id,
          workspace.type,
          cwd,
          now,
          existing.id
        );
        if (wasMissing) result.reactivated += 1;
      }
    }
  }

  // Find trackers that didn't show up in this scan and flag them.
  const allRows = db.query("SELECT * FROM pr_trackers").all() as PrTrackerRow[];
  for (const row of allRows) {
    const key = `${row.source_workspace_id}|${row.source_channel_id}|${row.repo_host}|${row.repo_owner}|${row.repo_name}`;
    if (foundKeys.has(key)) continue;
    if (row.missing_since !== null) continue;
    db.query("UPDATE pr_trackers SET missing_since = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      row.id
    );
    result.markedMissing += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CRUD.
// ---------------------------------------------------------------------------

export function listPrTrackers(): PrTrackerRecord[] {
  const db = getDatabase();
  const rows = db
    .query(`
      SELECT * FROM pr_trackers
      ORDER BY
        missing_since IS NOT NULL,
        source_workspace_name,
        source_channel_name,
        repo_owner,
        repo_name
    `)
    .all() as PrTrackerRow[];
  return rows.map(mapTrackerRow);
}

export function getPrTrackerById(id: string): PrTrackerRecord | null {
  const db = getDatabase();
  const row = db
    .query("SELECT * FROM pr_trackers WHERE id = ?")
    .get(id) as PrTrackerRow | null;
  return row ? mapTrackerRow(row) : null;
}

/**
 * Tracker rows that are due for a poll: enabled, not missing, and either
 * never polled or polled longer ago than their (resolved) interval. The
 * scheduler uses this to drive its tick.
 */
export function listDuePrTrackers(nowMs: number = Date.now()): PrTrackerRecord[] {
  const settings = getPrTrackerSettings();
  const db = getDatabase();
  const rows = db
    .query(`
      SELECT * FROM pr_trackers
      WHERE enabled = 1 AND missing_since IS NULL
    `)
    .all() as PrTrackerRow[];
  const due: PrTrackerRecord[] = [];
  for (const row of rows) {
    const tracker = mapTrackerRow(row);
    const interval = (tracker.pollIntervalSec ?? settings.defaultPollIntervalSec) * 1000;
    const last = tracker.lastPolledAt ?? 0;
    if (last === 0 || nowMs - last >= interval) {
      due.push(tracker);
    }
  }
  return due;
}

export type UpdatePrTrackerParams = Partial<{
  enabled: boolean;
  agentProvider: string | null;
  promptTemplate: string | null;
  pollIntervalSec: number | null;
  githubToken: string | null;
  targetChannelId: string | null;
}>;

export function updatePrTracker(id: string, params: UpdatePrTrackerParams): PrTrackerRecord {
  const existing = getPrTrackerById(id);
  if (!existing) throw new Error("PR tracker not found");
  if (existing.missingSince !== null && params.enabled === true) {
    throw new Error("Cannot enable a tracker whose source repo is missing");
  }

  const db = getDatabase();
  const now = Date.now();

  const enabled = params.enabled !== undefined ? (params.enabled ? 1 : 0) : existing.enabled ? 1 : 0;

  const agentProvider =
    params.agentProvider !== undefined
      ? normalizeOptionalAgent(params.agentProvider)
      : existing.agentProvider;

  const promptTemplate =
    params.promptTemplate !== undefined
      ? params.promptTemplate === null || params.promptTemplate.trim() === ""
        ? null
        : params.promptTemplate.trim()
      : existing.promptTemplate;

  const pollIntervalSec =
    params.pollIntervalSec !== undefined
      ? params.pollIntervalSec === null
        ? null
        : normalizePollInterval(params.pollIntervalSec)
      : existing.pollIntervalSec;

  const githubToken =
    params.githubToken !== undefined
      ? params.githubToken === null || params.githubToken.trim() === ""
        ? null
        : params.githubToken.trim()
      : existing.githubToken;

  let targetWorkspaceId = existing.targetWorkspaceId;
  let targetChannelId = existing.targetChannelId;
  let targetChannelName = existing.targetChannelName;
  let targetPlatform = existing.targetPlatform;

  if (params.targetChannelId !== undefined) {
    if (params.targetChannelId === null || params.targetChannelId.trim() === "") {
      targetWorkspaceId = null;
      targetChannelId = null;
      targetChannelName = null;
      targetPlatform = null;
    } else {
      const snap = getChannelSnapshotForTarget(params.targetChannelId);
      targetWorkspaceId = snap.workspaceId;
      targetChannelId = snap.channelId;
      targetChannelName = snap.channelName;
      targetPlatform = snap.platform;
    }
  }

  // Enforce: enabling requires a target channel.
  if (enabled === 1 && !targetChannelId) {
    throw new Error("Cannot enable a tracker without a target channel");
  }

  // First-enable bookkeeping: when transitioning from disabled→enabled and
  // there's no prior poll cursor, set last_polled_at to "now" so we don't
  // backfill historical events. Re-enabling later keeps the existing cursor.
  let nextLastPolledAt = existing.lastPolledAt;
  if (enabled === 1 && !existing.enabled && existing.lastPolledAt === null) {
    nextLastPolledAt = now;
  }

  db.query(`
    UPDATE pr_trackers
    SET
      enabled = ?,
      agent_provider = ?,
      prompt_template = ?,
      poll_interval_sec = ?,
      github_token = ?,
      target_workspace_id = ?,
      target_channel_id = ?,
      target_channel_name = ?,
      target_platform = ?,
      last_polled_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    enabled,
    agentProvider,
    promptTemplate,
    pollIntervalSec,
    githubToken,
    targetWorkspaceId,
    targetChannelId,
    targetChannelName,
    targetPlatform,
    nextLastPolledAt,
    now,
    id
  );

  return getPrTrackerById(id)!;
}

export function deletePrTracker(id: string): void {
  const db = getDatabase();
  // Cascade: drop event audit rows for the tracker as well.
  db.query("DELETE FROM pr_tracker_events WHERE tracker_id = ?").run(id);
  db.query("DELETE FROM pr_trackers WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Scheduler-side bookkeeping.
// ---------------------------------------------------------------------------

export function markPrTrackerPolled(id: string, options: {
  success: boolean;
  errorMessage?: string | null;
  pollCompletedAt?: number;
}): void {
  const db = getDatabase();
  const ts = options.pollCompletedAt ?? Date.now();
  if (options.success) {
    db.query(`
      UPDATE pr_trackers
      SET last_polled_at = ?,
          last_success_at = ?,
          last_error = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(ts, ts, ts, id);
  } else {
    // IMPORTANT: `last_polled_at` is reused as the GitHub `since` cursor in
    // the scheduler. Advancing it on failure would skip the unprocessed
    // activity window forever, so we only update the error + updated_at
    // timestamps here and leave the cursor untouched. The next tick will
    // retry from the last successful cursor.
    db.query(`
      UPDATE pr_trackers
      SET last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(options.errorMessage ?? "unknown error", ts, id);
  }
}

/**
 * Advance the poll cursor explicitly. Used by the scheduler when it wants to
 * move the cursor to a time earlier than "now" (e.g. when per-poll caps
 * leave some PRs unhandled and we need to keep them in the next `since`
 * window). Safe to call regardless of the current cursor; monotonicity is
 * the caller's concern.
 */
export function setPrTrackerCursor(id: string, cursorMs: number): void {
  const db = getDatabase();
  const now = Date.now();
  db.query(`
    UPDATE pr_trackers
    SET last_polled_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(Math.floor(cursorMs), now, id);
}

// ---------------------------------------------------------------------------
// Event log.
// ---------------------------------------------------------------------------

export type RecordPrTrackerEventParams = {
  trackerId: string;
  prNumber: number;
  eventType: string;
  githubEventId: string;
  prUpdatedAt?: number | null;
  agentSessionId?: string | null;
  agentStatus?: PrTrackerEventStatus;
  errorMessage?: string | null;
};

/**
 * Record a processed event. Returns true if a new row was inserted (the event
 * was novel) and false if the (tracker_id, event_type, github_event_id) tuple
 * already existed (already processed).
 */
export function recordPrTrackerEvent(params: RecordPrTrackerEventParams): boolean {
  const db = getDatabase();
  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    db.query(`
      INSERT INTO pr_tracker_events (
        id,
        tracker_id,
        pr_number,
        event_type,
        github_event_id,
        pr_updated_at,
        agent_session_id,
        agent_status,
        error_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.trackerId,
      params.prNumber,
      params.eventType,
      params.githubEventId,
      params.prUpdatedAt ?? null,
      params.agentSessionId ?? null,
      params.agentStatus ?? "success",
      params.errorMessage ?? null,
      now
    );
    return true;
  } catch (error) {
    const msg = String((error as Error)?.message ?? error);
    if (msg.includes("UNIQUE")) return false;
    throw error;
  }
}

export function listProcessedEventIds(
  trackerId: string,
  eventType: string,
  ids: string[]
): Set<string> {
  if (ids.length === 0) return new Set();
  const db = getDatabase();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT github_event_id FROM pr_tracker_events
        WHERE tracker_id = ? AND event_type = ? AND github_event_id IN (${placeholders})`
    )
    .all(trackerId, eventType, ...ids) as Array<{ github_event_id: string }>;
  return new Set(rows.map((r) => r.github_event_id));
}

export function listPrTrackerEvents(
  trackerId: string,
  limit: number = 50
): PrTrackerEventRecord[] {
  const db = getDatabase();
  const rows = db
    .query(`
      SELECT * FROM pr_tracker_events
      WHERE tracker_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(trackerId, Math.max(1, Math.min(limit, 500))) as PrTrackerEventRow[];
  return rows.map(mapEventRow);
}

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

export function clearPrTrackersForTests(): void {
  const db = getDatabase();
  db.exec("DELETE FROM pr_tracker_events;");
  db.exec("DELETE FROM pr_trackers;");
  db.exec("DELETE FROM pr_tracker_settings;");
}

export function closePrTrackerDatabaseForTests(): void {
  if (!cachedDatabase) return;
  try {
    cachedDatabase.db.close();
  } catch {
    // ignore
  } finally {
    cachedDatabase = null;
  }
}
