import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadOdeConfig } from "./ode-store";

// ---------------------------------------------------------------------------
// Schema
//
// The inbox is now modeled as two tables:
//   - `message_thread`  — one row per (platform, channel, thread), carrying
//                         the shared context (workspace, session, provider,
//                         working directory, branch, cron metadata, etc.).
//   - `message_detail`  — one row per atomic event inside a thread. Each
//                         detail has its own start/end timestamps, status,
//                         and optionally links back to a question detail so
//                         user replies can be correlated.
//
// We keep at most `MAX_THREADS` threads; pruning cascades to their details.
// ---------------------------------------------------------------------------

export type PlatformId = "slack" | "discord" | "lark";

export type MessageDetailKind =
  | "user_prompt"
  | "agent_result"
  | "agent_question"
  | "question_reply";

export type MessageDetailStatus = "pending" | "completed" | "failed";

export type MessageThreadSourceKind = "user" | "cron_job" | "task";

export interface MessageThreadSummary {
  id: string;
  platform: PlatformId;
  workspaceId: string | null;
  workspaceName: string | null;
  channelId: string;
  channelName: string | null;
  rawChannelId: string | null;
  threadId: string;
  replyThreadId: string;
  sessionId: string | null;
  providerId: string | null;
  model: string | null;
  workingDirectory: string | null;
  threadOwnerUserId: string | null;
  branchName: string | null;
  sourceKind: MessageThreadSourceKind;
  cronJobId: string | null;
  cronJobTitle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  detailCount: number;
  firstMessageAt: number;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
  latestPromptPreview: string | null;
  latestResultPreview: string | null;
  pendingDetailCount: number;
}

export interface MessageDetail {
  id: string;
  threadId: string;
  seq: number;
  kind: MessageDetailKind;
  status: MessageDetailStatus;
  isQuestion: boolean;
  questionSourceId: string | null;
  questionPayload: unknown;
  userId: string | null;
  messageId: string | null;
  promptText: string | null;
  resultText: string | null;
  errorText: string | null;
  providerId: string | null;
  model: string | null;
  workingDirectory: string | null;
  startTime: number;
  endTime: number | null;
  context: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageThreadDetail extends MessageThreadSummary {
  context: Record<string, unknown> | null;
  details: MessageDetail[];
}

export interface MessageDetailPage {
  items: MessageDetail[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface MessageThreadPage {
  items: MessageThreadSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface EnsureMessageThreadParams {
  platform: PlatformId;
  channelId: string;
  rawChannelId?: string | null;
  threadId: string;
  replyThreadId: string;
  sessionId?: string | null;
  providerId?: string | null;
  model?: string | null;
  workingDirectory?: string | null;
  threadOwnerUserId?: string | null;
  branchName?: string | null;
  sourceKind?: MessageThreadSourceKind;
  cronJobId?: string | null;
  cronJobTitle?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  context?: Record<string, unknown> | null;
}

export interface RecordUserPromptParams {
  threadKey: string;
  messageId: string;
  userId?: string | null;
  promptText: string;
  startTime?: number;
  context?: Record<string, unknown> | null;
}

export interface StartAgentResultParams {
  threadKey: string;
  requestMessageId: string;
  providerId?: string | null;
  model?: string | null;
  workingDirectory?: string | null;
  startTime?: number;
  context?: Record<string, unknown> | null;
}

export interface CompleteAgentResultParams {
  detailId: string;
  resultText: string;
  endTime?: number;
  providerId?: string | null;
  model?: string | null;
  workingDirectory?: string | null;
}

export interface FailAgentResultParams {
  detailId: string;
  errorText: string;
  resultText?: string | null;
  endTime?: number;
  providerId?: string | null;
  model?: string | null;
  workingDirectory?: string | null;
}

export interface RecordAgentQuestionParams {
  threadKey: string;
  requestMessageId: string;
  questionRequestId: string;
  questions: unknown;
  startTime?: number;
  providerId?: string | null;
  model?: string | null;
  workingDirectory?: string | null;
  context?: Record<string, unknown> | null;
}

export interface RecordQuestionReplyParams {
  threadKey: string;
  questionDetailId: string;
  messageId: string;
  userId?: string | null;
  answerText: string;
  startTime?: number;
  endTime?: number;
  context?: Record<string, unknown> | null;
}

export interface CompleteAgentQuestionParams {
  detailId: string;
  endTime?: number;
}

type ThreadRow = {
  id: string;
  platform: PlatformId;
  workspace_id: string | null;
  workspace_name: string | null;
  channel_id: string;
  channel_name: string | null;
  raw_channel_id: string | null;
  thread_id: string;
  reply_thread_id: string;
  session_id: string | null;
  provider_id: string | null;
  model: string | null;
  working_directory: string | null;
  thread_owner_user_id: string | null;
  branch_name: string | null;
  source_kind: MessageThreadSourceKind;
  cron_job_id: string | null;
  cron_job_title: string | null;
  task_id: string | null;
  task_title: string | null;
  context_json: string | null;
  detail_count: number;
  first_message_at: number;
  last_message_at: number;
  created_at: number;
  updated_at: number;
};

type DetailRow = {
  id: string;
  thread_id: string;
  seq: number;
  kind: MessageDetailKind;
  status: MessageDetailStatus;
  is_question: number;
  question_source_id: string | null;
  question_payload_json: string | null;
  user_id: string | null;
  message_id: string | null;
  prompt_text: string | null;
  result_text: string | null;
  error_text: string | null;
  provider_id: string | null;
  model: string | null;
  working_directory: string | null;
  start_time: number;
  end_time: number | null;
  context_json: string | null;
  created_at: number;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const existsSync = fs.existsSync;
const mkdirSync = fs.mkdirSync;
const join = typeof path.join === "function" ? path.join : (...parts: string[]) => parts.join("/");
const homedir = typeof os.homedir === "function" ? os.homedir : () => "";

const ODE_CONFIG_DIR = join(homedir(), ".config", "ode");
const DEFAULT_DB_FILE = join(ODE_CONFIG_DIR, "inbox.db");
const DEFAULT_SUMMARY_LENGTH = 240;
const MAX_THREADS = 100;

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
  db.exec("PRAGMA foreign_keys = ON;");
  // The legacy single-table layout is obsolete; drop it so old data does
  // not confuse callers that now expect the thread/detail pair.
  db.exec("DROP TABLE IF EXISTS inbox_records;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_thread (
      id                    TEXT PRIMARY KEY,
      platform              TEXT NOT NULL,
      workspace_id          TEXT,
      workspace_name        TEXT,
      channel_id            TEXT NOT NULL,
      channel_name          TEXT,
      raw_channel_id        TEXT,
      thread_id             TEXT NOT NULL,
      reply_thread_id       TEXT NOT NULL,
      session_id            TEXT,
      provider_id           TEXT,
      model                 TEXT,
      working_directory     TEXT,
      thread_owner_user_id  TEXT,
      branch_name           TEXT,
      source_kind           TEXT NOT NULL DEFAULT 'user',
      cron_job_id           TEXT,
      cron_job_title        TEXT,
      task_id               TEXT,
      task_title            TEXT,
      context_json          TEXT,
      detail_count          INTEGER NOT NULL DEFAULT 0,
      first_message_at      INTEGER NOT NULL,
      last_message_at       INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_detail (
      id                     TEXT PRIMARY KEY,
      thread_id              TEXT NOT NULL REFERENCES message_thread(id) ON DELETE CASCADE,
      seq                    INTEGER NOT NULL,
      kind                   TEXT NOT NULL,
      status                 TEXT NOT NULL,
      is_question            INTEGER NOT NULL DEFAULT 0,
      question_source_id     TEXT,
      question_payload_json  TEXT,
      user_id                TEXT,
      message_id             TEXT,
      prompt_text            TEXT,
      result_text            TEXT,
      error_text             TEXT,
      provider_id            TEXT,
      model                  TEXT,
      working_directory      TEXT,
      start_time             INTEGER NOT NULL,
      end_time               INTEGER,
      context_json           TEXT,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_message_thread_last_at ON message_thread(last_message_at DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_message_thread_source ON message_thread(source_kind, last_message_at DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_message_detail_thread_seq ON message_detail(thread_id, seq);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_message_detail_question ON message_detail(question_source_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_message_detail_status ON message_detail(status);");

  // Lightweight migrations for DBs created before the columns existed.
  // sqlite's `ALTER TABLE ... ADD COLUMN` is idempotent-friendly if we first
  // check PRAGMA table_info, which avoids throwing on repeated startup.
  ensureThreadColumn(db, "task_id", "TEXT");
  ensureThreadColumn(db, "task_title", "TEXT");
}

function ensureThreadColumn(db: Database, column: string, type: string): void {
  const rows = db.query(`PRAGMA table_info(message_thread)`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE message_thread ADD COLUMN ${column} ${type};`);
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
// Helpers
// ---------------------------------------------------------------------------

function normalizeSummaryText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function createSummary(text: string | null | undefined, maxLength = DEFAULT_SUMMARY_LENGTH): string | null {
  if (!text) return null;
  const normalized = normalizeSummaryText(text);
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function safeJsonParse<T = unknown>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
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

function getWorkspaceChannelSnapshot(channelId: string): {
  workspaceId: string | null;
  workspaceName: string | null;
  channelName: string | null;
} {
  const resolvedChannelId = resolveConfigChannelId(channelId);
  const config = loadOdeConfig();
  for (const workspace of config.workspaces) {
    const channel = workspace.channelDetails.find((item) => item.id === resolvedChannelId);
    if (!channel) continue;
    return {
      workspaceId: workspace.id || null,
      workspaceName: workspace.name || null,
      channelName: channel.name || null,
    };
  }
  return {
    workspaceId: null,
    workspaceName: null,
    channelName: null,
  };
}

export function buildThreadKey(channelId: string, threadId: string): string {
  return `${channelId}:${threadId}`;
}

export function buildDetailId(threadKey: string, kind: MessageDetailKind, discriminator: string): string {
  return `${threadKey}::${kind}::${discriminator}`;
}

function mapDetailRow(row: DetailRow): MessageDetail {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    kind: row.kind,
    status: row.status,
    isQuestion: row.is_question !== 0,
    questionSourceId: row.question_source_id,
    questionPayload: safeJsonParse(row.question_payload_json),
    userId: row.user_id,
    messageId: row.message_id,
    promptText: row.prompt_text,
    resultText: row.result_text,
    errorText: row.error_text,
    providerId: row.provider_id,
    model: row.model,
    workingDirectory: row.working_directory,
    startTime: row.start_time,
    endTime: row.end_time,
    context: safeJsonParse<Record<string, unknown>>(row.context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThreadSummaryRow(
  db: Database,
  row: ThreadRow,
): MessageThreadSummary {
  const latestPromptRow = db
    .query(
      `SELECT prompt_text FROM message_detail
       WHERE thread_id = ? AND kind = 'user_prompt' AND prompt_text IS NOT NULL
       ORDER BY seq DESC LIMIT 1`
    )
    .get(row.id) as { prompt_text: string | null } | null;
  const latestResultRow = db
    .query(
      `SELECT result_text FROM message_detail
       WHERE thread_id = ? AND kind = 'agent_result' AND status = 'completed'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(row.id) as { result_text: string | null } | null;
  const pendingRow = db
    .query(
      `SELECT COUNT(*) AS c FROM message_detail
       WHERE thread_id = ? AND status = 'pending'`
    )
    .get(row.id) as { c: number } | null;

  return {
    id: row.id,
    platform: row.platform,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    rawChannelId: row.raw_channel_id,
    threadId: row.thread_id,
    replyThreadId: row.reply_thread_id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    model: row.model,
    workingDirectory: row.working_directory,
    threadOwnerUserId: row.thread_owner_user_id,
    branchName: row.branch_name,
    sourceKind: row.source_kind,
    cronJobId: row.cron_job_id,
    cronJobTitle: row.cron_job_title,
    taskId: row.task_id,
    taskTitle: row.task_title,
    detailCount: row.detail_count,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestPromptPreview: createSummary(latestPromptRow?.prompt_text),
    latestResultPreview: createSummary(latestResultRow?.result_text),
    pendingDetailCount: pendingRow?.c ?? 0,
  };
}

function nextSeq(db: Database, threadKey: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message_detail WHERE thread_id = ?")
    .get(threadKey) as { next: number } | null;
  return row?.next ?? 1;
}

function bumpThreadActivity(db: Database, threadKey: string, at: number): void {
  db.query(
    `UPDATE message_thread
     SET last_message_at = MAX(last_message_at, ?),
         updated_at = ?
     WHERE id = ?`
  ).run(at, at, threadKey);
}

function incrementDetailCount(db: Database, threadKey: string, delta: number): void {
  db.query(
    `UPDATE message_thread
     SET detail_count = detail_count + ?
     WHERE id = ?`
  ).run(delta, threadKey);
}

function pruneOldThreads(db: Database, max: number = MAX_THREADS): void {
  const overflow = db
    .query("SELECT COUNT(*) AS c FROM message_thread")
    .get() as { c: number } | null;
  const total = overflow?.c ?? 0;
  if (total <= max) return;

  const toDelete = total - max;
  const victims = db
    .query(
      `SELECT id FROM message_thread
       ORDER BY last_message_at ASC, rowid ASC
       LIMIT ?`
    )
    .all(toDelete) as Array<{ id: string }>;
  if (victims.length === 0) return;

  const placeholders = victims.map(() => "?").join(",");
  db.query(`DELETE FROM message_thread WHERE id IN (${placeholders})`).run(...victims.map((v) => v.id));
}

// ---------------------------------------------------------------------------
// Thread / detail writers
// ---------------------------------------------------------------------------

export function ensureMessageThread(params: EnsureMessageThreadParams): string {
  const db = getDatabase();
  const now = Date.now();
  const threadKey = buildThreadKey(params.channelId, params.threadId);
  const workspace = getWorkspaceChannelSnapshot(params.rawChannelId ?? params.channelId);
  const sourceKind = params.sourceKind ?? "user";

  db.query(
    `INSERT INTO message_thread (
       id, platform,
       workspace_id, workspace_name,
       channel_id, channel_name,
       raw_channel_id, thread_id, reply_thread_id,
       session_id, provider_id, model, working_directory,
       thread_owner_user_id, branch_name,
       source_kind, cron_job_id, cron_job_title,
       task_id, task_title,
       context_json,
       detail_count,
       first_message_at, last_message_at,
       created_at, updated_at
     ) VALUES (
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?,
       ?, ?, ?,
       ?, ?,
       ?,
       0,
       ?, ?,
       ?, ?
     )
     ON CONFLICT(id) DO UPDATE SET
       platform             = excluded.platform,
       workspace_id         = excluded.workspace_id,
       workspace_name       = excluded.workspace_name,
       channel_id           = excluded.channel_id,
       channel_name         = excluded.channel_name,
       raw_channel_id       = excluded.raw_channel_id,
       thread_id            = excluded.thread_id,
       reply_thread_id      = excluded.reply_thread_id,
       session_id           = COALESCE(excluded.session_id, message_thread.session_id),
       provider_id          = COALESCE(excluded.provider_id, message_thread.provider_id),
       model                = COALESCE(excluded.model, message_thread.model),
       working_directory    = COALESCE(excluded.working_directory, message_thread.working_directory),
       thread_owner_user_id = COALESCE(excluded.thread_owner_user_id, message_thread.thread_owner_user_id),
       branch_name          = COALESCE(excluded.branch_name, message_thread.branch_name),
       source_kind          = excluded.source_kind,
       cron_job_id          = COALESCE(excluded.cron_job_id, message_thread.cron_job_id),
       cron_job_title       = COALESCE(excluded.cron_job_title, message_thread.cron_job_title),
       task_id              = COALESCE(excluded.task_id, message_thread.task_id),
       task_title           = COALESCE(excluded.task_title, message_thread.task_title),
       context_json         = COALESCE(excluded.context_json, message_thread.context_json),
       updated_at           = excluded.updated_at
    `
  ).run(
    threadKey,
    params.platform,
    workspace.workspaceId,
    workspace.workspaceName,
    params.channelId,
    workspace.channelName,
    params.rawChannelId ?? null,
    params.threadId,
    params.replyThreadId,
    params.sessionId ?? null,
    params.providerId ?? null,
    params.model ?? null,
    params.workingDirectory ?? null,
    params.threadOwnerUserId ?? null,
    params.branchName ?? null,
    sourceKind,
    params.cronJobId ?? null,
    params.cronJobTitle ?? null,
    params.taskId ?? null,
    params.taskTitle ?? null,
    toJsonText(params.context ?? null),
    now,
    now,
    now,
    now,
  );

  pruneOldThreads(db);
  return threadKey;
}

function insertDetail(
  db: Database,
  detail: {
    id: string;
    threadKey: string;
    kind: MessageDetailKind;
    status: MessageDetailStatus;
    isQuestion?: boolean;
    questionSourceId?: string | null;
    questionPayload?: unknown;
    userId?: string | null;
    messageId?: string | null;
    promptText?: string | null;
    resultText?: string | null;
    errorText?: string | null;
    providerId?: string | null;
    model?: string | null;
    workingDirectory?: string | null;
    startTime?: number;
    endTime?: number | null;
    context?: Record<string, unknown> | null;
  }
): MessageDetail {
  const now = Date.now();
  const startTime = detail.startTime ?? now;
  const seq = nextSeq(db, detail.threadKey);
  db.query(
    `INSERT INTO message_detail (
       id, thread_id, seq, kind, status,
       is_question, question_source_id, question_payload_json,
       user_id, message_id,
       prompt_text, result_text, error_text,
       provider_id, model, working_directory,
       start_time, end_time,
       context_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    detail.id,
    detail.threadKey,
    seq,
    detail.kind,
    detail.status,
    detail.isQuestion ? 1 : 0,
    detail.questionSourceId ?? null,
    toJsonText(detail.questionPayload ?? null),
    detail.userId ?? null,
    detail.messageId ?? null,
    detail.promptText ?? null,
    detail.resultText ?? null,
    detail.errorText ?? null,
    detail.providerId ?? null,
    detail.model ?? null,
    detail.workingDirectory ?? null,
    startTime,
    detail.endTime ?? null,
    toJsonText(detail.context ?? null),
    now,
    now,
  );
  incrementDetailCount(db, detail.threadKey, 1);
  bumpThreadActivity(db, detail.threadKey, startTime);

  const row = db.query("SELECT * FROM message_detail WHERE id = ?").get(detail.id) as DetailRow | null;
  if (!row) {
    throw new Error(`Failed to insert message detail ${detail.id}`);
  }
  return mapDetailRow(row);
}

export function recordUserPrompt(params: RecordUserPromptParams): MessageDetail {
  const db = getDatabase();
  const startTime = params.startTime ?? Date.now();
  const detailId = buildDetailId(params.threadKey, "user_prompt", params.messageId);
  return insertDetail(db, {
    id: detailId,
    threadKey: params.threadKey,
    kind: "user_prompt",
    status: "completed",
    userId: params.userId ?? null,
    messageId: params.messageId,
    promptText: params.promptText,
    startTime,
    endTime: startTime,
    context: params.context ?? null,
  });
}

export function startAgentResult(params: StartAgentResultParams): MessageDetail {
  const db = getDatabase();
  const startTime = params.startTime ?? Date.now();
  const detailId = buildDetailId(params.threadKey, "agent_result", params.requestMessageId);
  const inserted = insertDetail(db, {
    id: detailId,
    threadKey: params.threadKey,
    kind: "agent_result",
    status: "pending",
    messageId: params.requestMessageId,
    providerId: params.providerId ?? null,
    model: params.model ?? null,
    workingDirectory: params.workingDirectory ?? null,
    startTime,
    context: params.context ?? null,
  });
  // Reflect the latest provider / model on the thread so we don't have to
  // look it up from the most recent detail every time we show the thread.
  db.query(
    `UPDATE message_thread
     SET provider_id = COALESCE(?, provider_id),
         model = COALESCE(?, model),
         working_directory = COALESCE(?, working_directory)
     WHERE id = ?`
  ).run(
    params.providerId ?? null,
    params.model ?? null,
    params.workingDirectory ?? null,
    params.threadKey,
  );
  return inserted;
}

export function completeAgentResult(params: CompleteAgentResultParams): void {
  const db = getDatabase();
  const endTime = params.endTime ?? Date.now();
  db.query(
    `UPDATE message_detail
     SET status = 'completed',
         result_text = ?,
         error_text = NULL,
         provider_id = COALESCE(?, provider_id),
         model = COALESCE(?, model),
         working_directory = COALESCE(?, working_directory),
         end_time = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    params.resultText,
    params.providerId ?? null,
    params.model ?? null,
    params.workingDirectory ?? null,
    endTime,
    endTime,
    params.detailId,
  );
  const row = db.query("SELECT thread_id FROM message_detail WHERE id = ?").get(params.detailId) as
    | { thread_id: string }
    | null;
  if (row) bumpThreadActivity(db, row.thread_id, endTime);
}

export function failAgentResult(params: FailAgentResultParams): void {
  const db = getDatabase();
  const endTime = params.endTime ?? Date.now();
  db.query(
    `UPDATE message_detail
     SET status = 'failed',
         result_text = COALESCE(?, result_text),
         error_text = ?,
         provider_id = COALESCE(?, provider_id),
         model = COALESCE(?, model),
         working_directory = COALESCE(?, working_directory),
         end_time = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(
    params.resultText ?? null,
    params.errorText,
    params.providerId ?? null,
    params.model ?? null,
    params.workingDirectory ?? null,
    endTime,
    endTime,
    params.detailId,
  );
  const row = db.query("SELECT thread_id FROM message_detail WHERE id = ?").get(params.detailId) as
    | { thread_id: string }
    | null;
  if (row) bumpThreadActivity(db, row.thread_id, endTime);
}

export function recordAgentQuestion(params: RecordAgentQuestionParams): MessageDetail {
  const db = getDatabase();
  const startTime = params.startTime ?? Date.now();
  const detailId = buildDetailId(params.threadKey, "agent_question", params.questionRequestId);
  return insertDetail(db, {
    id: detailId,
    threadKey: params.threadKey,
    kind: "agent_question",
    status: "pending",
    isQuestion: true,
    questionSourceId: params.questionRequestId,
    questionPayload: params.questions ?? null,
    messageId: params.requestMessageId,
    providerId: params.providerId ?? null,
    model: params.model ?? null,
    workingDirectory: params.workingDirectory ?? null,
    startTime,
    context: params.context ?? null,
  });
}

export function completeAgentQuestion(params: CompleteAgentQuestionParams): void {
  const db = getDatabase();
  const endTime = params.endTime ?? Date.now();
  db.query(
    `UPDATE message_detail
     SET status = 'completed',
         end_time = ?,
         updated_at = ?
     WHERE id = ? AND kind = 'agent_question'`
  ).run(endTime, endTime, params.detailId);
  const row = db.query("SELECT thread_id FROM message_detail WHERE id = ?").get(params.detailId) as
    | { thread_id: string }
    | null;
  if (row) bumpThreadActivity(db, row.thread_id, endTime);
}

export function recordQuestionReply(params: RecordQuestionReplyParams): MessageDetail {
  const db = getDatabase();
  const startTime = params.startTime ?? Date.now();
  const detailId = buildDetailId(params.threadKey, "question_reply", `${params.questionDetailId}:${params.messageId}`);
  return insertDetail(db, {
    id: detailId,
    threadKey: params.threadKey,
    kind: "question_reply",
    status: "completed",
    questionSourceId: params.questionDetailId,
    userId: params.userId ?? null,
    messageId: params.messageId,
    promptText: params.answerText,
    startTime,
    endTime: params.endTime ?? startTime,
    context: params.context ?? null,
  });
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export function getMessageThreadPage(params?: {
  page?: number;
  pageSize?: number;
}): MessageThreadPage {
  const db = getDatabase();
  const pageSize = Math.max(1, Math.min(100, Math.floor(params?.pageSize ?? 20)));
  const page = Math.max(1, Math.floor(params?.page ?? 1));
  const offset = (page - 1) * pageSize;
  const totalRow = db.query("SELECT COUNT(*) AS count FROM message_thread").get() as
    | { count: number }
    | null;
  const total = totalRow?.count ?? 0;
  const rows = db
    .query(
      `SELECT * FROM message_thread
       ORDER BY last_message_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(pageSize, offset) as ThreadRow[];

  return {
    items: rows.map((row) => mapThreadSummaryRow(db, row)),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function getMessageThreadById(threadKey: string): MessageThreadDetail | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM message_thread WHERE id = ?").get(threadKey) as ThreadRow | null;
  if (!row) return null;
  const summary = mapThreadSummaryRow(db, row);
  const detailRows = db
    .query(
      `SELECT * FROM message_detail
       WHERE thread_id = ?
       ORDER BY seq ASC`
    )
    .all(threadKey) as DetailRow[];
  return {
    ...summary,
    context: safeJsonParse<Record<string, unknown>>(row.context_json),
    details: detailRows.map(mapDetailRow),
  };
}

export function getMessageThreadDetailPage(
  threadKey: string,
  params?: { page?: number; pageSize?: number }
): MessageDetailPage | null {
  const db = getDatabase();
  const row = db.query("SELECT 1 FROM message_thread WHERE id = ?").get(threadKey) as
    | { 1: number }
    | null;
  if (!row) return null;
  const pageSize = Math.max(1, Math.min(100, Math.floor(params?.pageSize ?? 10)));
  const page = Math.max(1, Math.floor(params?.page ?? 1));
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .query("SELECT COUNT(*) AS count FROM message_detail WHERE thread_id = ?")
    .get(threadKey) as { count: number } | null;
  const total = totalRow?.count ?? 0;

  const detailRows = db
    .query(
      `SELECT * FROM message_detail
       WHERE thread_id = ?
       ORDER BY seq ASC
       LIMIT ? OFFSET ?`
    )
    .all(threadKey, pageSize, offset) as DetailRow[];

  return {
    items: detailRows.map(mapDetailRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function getMessageThreadSummaryById(threadKey: string): (MessageThreadSummary & {
  context: Record<string, unknown> | null;
}) | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM message_thread WHERE id = ?").get(threadKey) as ThreadRow | null;
  if (!row) return null;
  const summary = mapThreadSummaryRow(db, row);
  return {
    ...summary,
    context: safeJsonParse<Record<string, unknown>>(row.context_json),
  };
}

export function getMessageDetailById(detailId: string): MessageDetail | null {
  const db = getDatabase();
  const row = db.query("SELECT * FROM message_detail WHERE id = ?").get(detailId) as DetailRow | null;
  return row ? mapDetailRow(row) : null;
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

export function clearMessageStoreForTests(): void {
  const db = getDatabase();
  db.exec("DELETE FROM message_detail; DELETE FROM message_thread;");
}

export function closeMessageDatabaseForTests(): void {
  if (!cachedDatabase) return;
  try {
    cachedDatabase.db.close();
  } catch {
    // Ignore close errors in tests.
  } finally {
    cachedDatabase = null;
  }
}
