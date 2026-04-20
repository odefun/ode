import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadOdeConfig } from "./ode-store";
import { validateCronExpression } from "@/core/cron/expression";

export type CronJobPlatform = "slack" | "discord" | "lark";
export type CronJobRunStatus = "idle" | "running" | "success" | "failed";

export type CronJobRecord = {
  id: string;
  title: string;
  cronExpression: string;
  platform: CronJobPlatform;
  workspaceId: string | null;
  workspaceName: string | null;
  channelId: string;
  channelName: string | null;
  messageText: string;
  enabled: boolean;
  lastTriggeredAt: number | null;
  lastCompletedAt: number | null;
  lastRunStatus: CronJobRunStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CronJobChannelOption = {
  value: string;
  platform: CronJobPlatform;
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  channelName: string;
  label: string;
};

export type CreateCronJobParams = {
  title: string;
  cronExpression: string;
  channelId: string;
  messageText: string;
  enabled?: boolean;
};

export type PatchCronJobParams = {
  title?: string;
  cronExpression?: string;
  channelId?: string;
  messageText?: string;
  enabled?: boolean;
};

type CronJobRow = {
  id: string;
  title: string;
  cron_expression: string;
  platform: CronJobPlatform;
  workspace_id: string | null;
  workspace_name: string | null;
  channel_id: string;
  channel_name: string | null;
  message_text: string;
  enabled: number;
  last_triggered_at: number | null;
  last_completed_at: number | null;
  last_run_status: CronJobRunStatus;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

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
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      platform TEXT NOT NULL,
      workspace_id TEXT,
      workspace_name TEXT,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      message_text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered_at INTEGER,
      last_completed_at INTEGER,
      last_run_status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled, updated_at DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cron_jobs_channel_id ON cron_jobs(channel_id, updated_at DESC);");
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

function mapRow(row: CronJobRow): CronJobRecord {
  return {
    id: row.id,
    title: row.title,
    cronExpression: row.cron_expression,
    platform: row.platform,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    messageText: row.message_text,
    enabled: row.enabled === 1,
    lastTriggeredAt: row.last_triggered_at,
    lastCompletedAt: row.last_completed_at,
    lastRunStatus: row.last_run_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function getChannelSnapshot(channelId: string): {
  platform: CronJobPlatform;
  workspaceId: string;
  workspaceName: string;
  channelId: string;
  channelName: string;
} {
  const resolvedChannelId = resolveConfigChannelId(channelId);
  const config = loadOdeConfig();
  for (const workspace of config.workspaces) {
    const channel = workspace.channelDetails.find((item) => item.id === resolvedChannelId);
    if (!channel) continue;
    return {
      platform: workspace.type,
      workspaceId: workspace.id,
      workspaceName: workspace.name || workspace.id,
      channelId: channel.id,
      channelName: channel.name || channel.id,
    };
  }
  throw new Error("Channel not found in configured workspaces");
}

function normalizeTitle(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron job title is required");
  }
  return normalized;
}

function normalizeCronExpression(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron expression is required");
  }
  validateCronExpression(normalized);
  return normalized;
}

function normalizeMessageText(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Cron job message is required");
  }
  return normalized;
}

function normalizeEnabled(value: boolean | undefined): boolean {
  return value !== false;
}

export function listCronJobChannelOptions(): CronJobChannelOption[] {
  const config = loadOdeConfig();
  return config.workspaces.flatMap((workspace) =>
    workspace.channelDetails.map((channel) => ({
      value: `${workspace.id}::${channel.id}`,
      platform: workspace.type,
      workspaceId: workspace.id,
      workspaceName: workspace.name || workspace.id,
      channelId: channel.id,
      channelName: channel.name || channel.id,
      label: `${workspace.name || workspace.id} / ${channel.name || channel.id}`,
    }))
  );
}

export function listCronJobs(): CronJobRecord[] {
  const db = getDatabase();
  const rows = db.query(`
    SELECT *
    FROM cron_jobs
    ORDER BY created_at DESC
  `).all() as CronJobRow[];
  return rows.map(mapRow);
}

export function listEnabledCronJobs(): CronJobRecord[] {
  const db = getDatabase();
  const rows = db.query(`
    SELECT *
    FROM cron_jobs
    WHERE enabled = 1
    ORDER BY created_at ASC
  `).all() as CronJobRow[];
  return rows.map(mapRow);
}

export function getCronJobById(id: string): CronJobRecord | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM cron_jobs WHERE id = ?").get(id) as CronJobRow | null;
  return row ? mapRow(row) : null;
}

export function createCronJob(params: CreateCronJobParams): CronJobRecord {
  const db = getDatabase();
  const channel = getChannelSnapshot(params.channelId);
  const now = Date.now();
  const id = crypto.randomUUID();
  const title = normalizeTitle(params.title);
  const cronExpression = normalizeCronExpression(params.cronExpression);
  const messageText = normalizeMessageText(params.messageText);
  const enabled = normalizeEnabled(params.enabled);

  db.query(`
    INSERT INTO cron_jobs (
      id,
      title,
      cron_expression,
      platform,
      workspace_id,
      workspace_name,
      channel_id,
      channel_name,
      message_text,
      enabled,
      last_run_status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `).run(
    id,
    title,
    cronExpression,
    channel.platform,
    channel.workspaceId,
    channel.workspaceName,
    channel.channelId,
    channel.channelName,
    messageText,
    enabled ? 1 : 0,
    now,
    now
  );

  return getCronJobById(id)!;
}

export function updateCronJob(id: string, params: CreateCronJobParams): CronJobRecord {
  const existing = getCronJobById(id);
  if (!existing) {
    throw new Error("Cron job not found");
  }

  const db = getDatabase();
  const channel = getChannelSnapshot(params.channelId);
  const title = normalizeTitle(params.title);
  const cronExpression = normalizeCronExpression(params.cronExpression);
  const messageText = normalizeMessageText(params.messageText);
  const enabled = normalizeEnabled(params.enabled);
  const now = Date.now();

  db.query(`
    UPDATE cron_jobs
    SET
      title = ?,
      cron_expression = ?,
      platform = ?,
      workspace_id = ?,
      workspace_name = ?,
      channel_id = ?,
      channel_name = ?,
      message_text = ?,
      enabled = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    title,
    cronExpression,
    channel.platform,
    channel.workspaceId,
    channel.workspaceName,
    channel.channelId,
    channel.channelName,
    messageText,
    enabled ? 1 : 0,
    now,
    id
  );

  return getCronJobById(id)!;
}

export function deleteCronJob(id: string): void {
  const db = getDatabase();
  db.query("DELETE FROM cron_jobs WHERE id = ?").run(id);
}

/**
 * Apply a partial update to an existing cron job. Only the provided fields
 * are changed; omitting a key preserves the current value. This powers the
 * `ode cron update` / `ode cron enable` / `ode cron disable` CLI flows where
 * callers typically want to flip a single attribute without re-specifying the
 * whole record.
 */
export function patchCronJob(id: string, params: PatchCronJobParams): CronJobRecord {
  const existing = getCronJobById(id);
  if (!existing) {
    throw new Error("Cron job not found");
  }

  const merged: CreateCronJobParams = {
    title: params.title ?? existing.title,
    cronExpression: params.cronExpression ?? existing.cronExpression,
    channelId: params.channelId ?? existing.channelId,
    messageText: params.messageText ?? existing.messageText,
    enabled: params.enabled ?? existing.enabled,
  };
  return updateCronJob(id, merged);
}

export function markCronJobTriggered(id: string, minuteStartMs: number): boolean {
  const db = getDatabase();
  const result = db.query(`
    UPDATE cron_jobs
    SET
      last_triggered_at = ?,
      last_run_status = 'running',
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
      AND enabled = 1
      AND (last_triggered_at IS NULL OR last_triggered_at < ?)
  `).run(minuteStartMs, Date.now(), id, minuteStartMs);
  return result.changes > 0;
}

/**
 * Flag a cron job as actively running for manual/immediate invocations that
 * bypass the minute-level idempotency guard in `markCronJobTriggered`.
 *
 * Scheduler polls rely on the `last_triggered_at < ?` guard to dedupe runs
 * within the same minute, but a user clicking "Run now" should not be blocked
 * by that guard. We still want the row's `last_run_status` to reflect the
 * in-flight run so the UI and any recovery logic can observe it truthfully,
 * hence this unconditional update.
 */
export function markCronJobRunning(id: string, triggeredAtMs: number): void {
  const db = getDatabase();
  db.query(`
    UPDATE cron_jobs
    SET
      last_triggered_at = ?,
      last_run_status = 'running',
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(triggeredAtMs, Date.now(), id);
}

export function markCronJobCompleted(id: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.query(`
    UPDATE cron_jobs
    SET
      last_completed_at = ?,
      last_run_status = 'success',
      last_error = NULL,
      updated_at = ?
    WHERE id = ?
  `).run(now, now, id);
}

export function markCronJobFailed(id: string, errorMessage: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.query(`
    UPDATE cron_jobs
    SET
      last_run_status = 'failed',
      last_error = ?,
      updated_at = ?
    WHERE id = ?
  `).run(errorMessage, now, id);
}

export function clearCronJobsForTests(): void {
  const db = getDatabase();
  db.exec("DELETE FROM cron_jobs;");
}

export function closeCronJobDatabaseForTests(): void {
  if (!cachedDatabase) return;
  try {
    cachedDatabase.db.close();
  } catch {
    // Ignore close errors in tests.
  } finally {
    cachedDatabase = null;
  }
}
