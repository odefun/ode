import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { log } from "@/utils";

const readFileSync = fs.readFileSync;
const readdirSync = fs.readdirSync;
const mkdirSync = fs.mkdirSync;
const unlinkSync = fs.unlinkSync;
const join = typeof path.join === "function" ? path.join : (...parts: string[]) => parts.join("/");
const homedir = typeof os.homedir === "function" ? os.homedir : () => "";

const ODE_CONFIG_DIR = join(homedir(), ".config", "ode");
const SESSIONS_DIR = join(ODE_CONFIG_DIR, "sessions");
const SESSION_SAVE_DEBOUNCE_MS = 5000;
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TrackedTool {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  title?: string;
  output?: string;
  error?: string;
}

export interface TrackedTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ActiveRequest {
  sessionId: string;
  channelId: string;
  replyThreadId: string;
  threadId: string;
  statusMessageTs: string;
  statusMessageBotId?: string;
  prompt: string;
  startedAt: number;
  lastUpdatedAt: number;
  currentText: string;
  tools?: TrackedTool[];
  todos: TrackedTodo[];
  statusFrozen?: boolean;
  state: "processing" | "completed" | "failed";
  finalResponseTs?: string;
  error?: string;
}

export interface PendingQuestion {
  requestId: string;
  sessionId: string;
  askedAt: number;
  questions: Array<{
    question: string;
    options?: string[];
    multiple?: boolean;
    custom?: boolean;
  }>;
  messageTs?: string;
}

export interface PersistedSession {
  sessionId: string;
  channelId: string;
  threadId: string;
  providerId?: "opencode" | "claudecode" | "codex" | "kimi" | "kiro" | "kilo" | "qwen" | "goose" | "gemini";
  platform?: "slack" | "discord" | "lark";
  workingDirectory: string;
  threadOwnerUserId?: string;
  participantBotIds?: string[];
  branchName?: string;
  threadNameSyncedWithBranch?: string;
  createdAt: number;
  lastActivityAt: number;
  activeRequest?: ActiveRequest;
  pendingQuestion?: PendingQuestion;
}

// In-memory cache
const activeSessions = new Map<string, PersistedSession>();
const processedMessages = new Set<string>();
const pendingWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingWriteSnapshots = new Map<string, PersistedSession>();
const writeChains = new Map<string, Promise<void>>();
const deletedSessionKeys = new Set<string>();
let sessionsHydrated = false;
let sessionsHydrationPromise: Promise<void> | null = null;

function ensureSessionsDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

async function ensureSessionsDirAsync(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function getSessionKey(channelId: string, threadId: string): string {
  return `${channelId}-${threadId}`;
}

function getSessionFilePath(sessionKey: string): string {
  // Sanitize key for filename
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9-]/g, "_");
  return join(SESSIONS_DIR, `${safeKey}.json`);
}

function getSessionLastActiveAt(session: PersistedSession): number {
  if (Number.isFinite(session.lastActivityAt)) {
    return session.lastActivityAt;
  }
  if (Number.isFinite(session.createdAt)) {
    return session.createdAt;
  }
  return 0;
}

function isSessionExpired(session: PersistedSession, now = Date.now()): boolean {
  const lastActiveAt = getSessionLastActiveAt(session);
  return now - lastActiveAt >= SESSION_RETENTION_MS;
}

function sanitizeSessionForStorage(session: PersistedSession): PersistedSession {
  const snapshot = structuredClone(session);
  if (snapshot.activeRequest) {
    delete (snapshot.activeRequest as Partial<ActiveRequest>).tools;
  }
  return snapshot;
}

function normalizeLoadedSession(session: PersistedSession): PersistedSession {
  if (!session.activeRequest) return session;
  const active = session.activeRequest as ActiveRequest & {
    settingsChannelId?: string;
    replyChannelId?: string;
  };
  active.channelId = active.settingsChannelId || active.channelId || session.channelId;
  active.replyThreadId = active.replyThreadId || active.replyChannelId || session.threadId;
  active.tools = Array.isArray(active.tools) ? active.tools : [];
  return session;
}

async function hydrateSessionsFromDisk(): Promise<void> {
  await ensureSessionsDirAsync();
  const files = await readdir(SESSIONS_DIR);
  const now = Date.now();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(SESSIONS_DIR, file);
    try {
      const data = await readFile(filePath, "utf-8");
      const session = normalizeLoadedSession(JSON.parse(data) as PersistedSession);
      if (isSessionExpired(session, now)) {
        const sessionKey = getSessionKey(session.channelId, session.threadId);
        activeSessions.delete(sessionKey);
        deletedSessionKeys.add(sessionKey);
        try {
          await unlink(filePath);
        } catch {
          // Ignore delete errors
        }
        continue;
      }

      const sessionKey = getSessionKey(session.channelId, session.threadId);
      if (!activeSessions.has(sessionKey)) {
        activeSessions.set(sessionKey, session);
      }
    } catch {
      // Skip invalid session files
    }
  }
}

function hydrateSessionsFromDiskSync(): void {
  ensureSessionsDir();
  const files = readdirSync(SESSIONS_DIR);
  const now = Date.now();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(SESSIONS_DIR, file);
    try {
      const data = readFileSync(filePath, "utf-8");
      const session = normalizeLoadedSession(JSON.parse(data) as PersistedSession);
      if (isSessionExpired(session, now)) {
        const sessionKey = getSessionKey(session.channelId, session.threadId);
        activeSessions.delete(sessionKey);
        deletedSessionKeys.add(sessionKey);
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore delete errors
        }
        continue;
      }

      const sessionKey = getSessionKey(session.channelId, session.threadId);
      if (!activeSessions.has(sessionKey)) {
        activeSessions.set(sessionKey, session);
      }
    } catch {
      // Skip invalid session files
    }
  }

  sessionsHydrated = true;
}

function scheduleSessionsHydration(): void {
  if (sessionsHydrated || sessionsHydrationPromise) return;
  sessionsHydrationPromise = hydrateSessionsFromDisk()
    .then(() => {
      sessionsHydrated = true;
    })
    .catch((err) => {
      log.warn("Failed to hydrate sessions from disk", { error: String(err) });
    })
    .finally(() => {
      sessionsHydrationPromise = null;
    });
}

async function ensureSessionsHydrated(): Promise<void> {
  if (sessionsHydrated) return;
  scheduleSessionsHydration();
  if (sessionsHydrationPromise) {
    await sessionsHydrationPromise;
  }
}

function enqueueSessionWrite(sessionKey: string, immediate = false): void {
  const existingTimer = pendingWriteTimers.get(sessionKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingWriteTimers.delete(sessionKey);
  }

  const flush = () => {
    pendingWriteTimers.delete(sessionKey);
    if (deletedSessionKeys.has(sessionKey)) {
      pendingWriteSnapshots.delete(sessionKey);
      return;
    }
    const snapshot = pendingWriteSnapshots.get(sessionKey);
    if (!snapshot) return;
    pendingWriteSnapshots.delete(sessionKey);
    const filePath = getSessionFilePath(sessionKey);
    const payload = JSON.stringify(snapshot, null, 2);
    const previous = writeChains.get(sessionKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await writeFile(filePath, payload, "utf-8");
      })
      .catch((err) => {
        log.error("Failed to save session", { sessionKey, error: String(err) });
      })
      .finally(() => {
        if (writeChains.get(sessionKey) === next) {
          writeChains.delete(sessionKey);
        }
      });
    writeChains.set(sessionKey, next);
  };

  if (immediate) {
    flush();
    return;
  }

  const timer = setTimeout(flush, SESSION_SAVE_DEBOUNCE_MS);
  pendingWriteTimers.set(sessionKey, timer);
}

export function loadSession(channelId: string, threadId: string): PersistedSession | null {
  const sessionKey = getSessionKey(channelId, threadId);

  // Check cache first
  if (activeSessions.has(sessionKey)) {
    const cached = activeSessions.get(sessionKey)!;
    if (isSessionExpired(cached)) {
      deleteSession(channelId, threadId);
      return null;
    }
    return cached;
  }

  const filePath = getSessionFilePath(sessionKey);

  try {
    const data = readFileSync(filePath, "utf-8");
    const session = normalizeLoadedSession(JSON.parse(data) as PersistedSession);
    if (isSessionExpired(session)) {
      deleteSession(channelId, threadId);
      return null;
    }
    activeSessions.set(sessionKey, session);
    return session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    log.warn("Failed to load session", { sessionKey, error: String(err) });
    return null;
  }
}

export function saveSession(session: PersistedSession, options?: { immediate?: boolean }): void {
  ensureSessionsDir();
  const sessionKey = getSessionKey(session.channelId, session.threadId);
  deletedSessionKeys.delete(sessionKey);
  session.lastActivityAt = Date.now();
  activeSessions.set(sessionKey, session);

  pendingWriteSnapshots.set(sessionKey, sanitizeSessionForStorage(session));
  enqueueSessionWrite(sessionKey, options?.immediate ?? false);
}

export function deleteSession(channelId: string, threadId: string): void {
  const sessionKey = getSessionKey(channelId, threadId);
  activeSessions.delete(sessionKey);
  deletedSessionKeys.add(sessionKey);

  const timer = pendingWriteTimers.get(sessionKey);
  if (timer) {
    clearTimeout(timer);
    pendingWriteTimers.delete(sessionKey);
  }
  pendingWriteSnapshots.delete(sessionKey);
  const inFlight = writeChains.get(sessionKey);
  if (inFlight) {
    void inFlight.finally(() => {
      if (!deletedSessionKeys.has(sessionKey)) return;
      const pathAfterWrite = getSessionFilePath(sessionKey);
      try {
        unlinkSync(pathAfterWrite);
      } catch {
        // Ignore delete errors
      }
    });
  }

  const filePath = getSessionFilePath(sessionKey);
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore delete errors
  }
}

export function createActiveRequest(
  sessionId: string,
  channelId: string,
  replyThreadId: string,
  threadId: string,
  statusMessageTs: string,
  prompt: string,
  statusMessageBotId?: string
): ActiveRequest {
  return {
    sessionId,
    channelId,
    replyThreadId,
    threadId,
    statusMessageTs,
    ...(statusMessageBotId ? { statusMessageBotId } : {}),
    prompt,
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    currentText: "",
    tools: [],
    todos: [],
    statusFrozen: false,
    state: "processing",
  };
}

export function updateActiveRequest(
  channelId: string,
  threadId: string,
  updates: Partial<ActiveRequest>
): void {
  const session = loadSession(channelId, threadId);
  if (!session?.activeRequest) return;

  const sanitized = { ...updates } as Partial<ActiveRequest>;
  delete sanitized.tools;
  Object.assign(session.activeRequest, sanitized, { lastUpdatedAt: Date.now() });
  saveSession(session, { immediate: false });
}

export function completeActiveRequest(
  channelId: string,
  threadId: string,
  finalResponseTs?: string
): void {
  const session = loadSession(channelId, threadId);
  if (!session?.activeRequest) return;

  session.activeRequest.state = "completed";
  session.activeRequest.finalResponseTs = finalResponseTs;
  session.activeRequest.lastUpdatedAt = Date.now();
  saveSession(session);
}

export function failActiveRequest(
  channelId: string,
  threadId: string,
  error: string
): void {
  const session = loadSession(channelId, threadId);
  if (!session?.activeRequest) return;

  session.activeRequest.state = "failed";
  session.activeRequest.error = error;
  session.activeRequest.lastUpdatedAt = Date.now();
  saveSession(session);
}

export function clearActiveRequest(channelId: string, threadId: string): void {
  const session = loadSession(channelId, threadId);
  if (!session) return;

  delete session.activeRequest;
  saveSession(session);
}

export function getPendingQuestion(channelId: string, threadId: string): PendingQuestion | null {
  const session = loadSession(channelId, threadId);
  return session?.pendingQuestion ?? null;
}

export function setPendingQuestion(
  channelId: string,
  threadId: string,
  pendingQuestion: PendingQuestion
): void {
  const session = loadSession(channelId, threadId);
  if (!session) return;
  session.pendingQuestion = pendingQuestion;
  saveSession(session);
}

export function clearPendingQuestion(channelId: string, threadId: string): void {
  const session = loadSession(channelId, threadId);
  if (!session?.pendingQuestion) return;
  delete session.pendingQuestion;
  saveSession(session);
}

export function getActiveRequest(channelId: string, threadId: string): ActiveRequest | null {
  const session = loadSession(channelId, threadId);
  return session?.activeRequest || null;
}

export function loadAllSessions(): PersistedSession[] {
  if (!sessionsHydrated) {
    hydrateSessionsFromDiskSync();
  }
  const sessionsByKey = new Map<string, PersistedSession>();

  for (const [sessionKey, session] of Array.from(activeSessions.entries())) {
    if (isSessionExpired(session)) {
      deleteSession(session.channelId, session.threadId);
      continue;
    }
    sessionsByKey.set(sessionKey, session);
  }

  return Array.from(sessionsByKey.values());
}

export async function loadAllSessionsAsync(): Promise<PersistedSession[]> {
  await ensureSessionsHydrated();
  return loadAllSessions();
}

export async function getSessionsWithPendingRequests(
  platform?: "slack" | "discord" | "lark"
): Promise<PersistedSession[]> {
  const sessions = await loadAllSessionsAsync();
  return sessions.filter((s) => {
    if (!s.activeRequest || s.activeRequest.state !== "processing") return false;
    if (!platform) return true;
    return s.platform === platform;
  });
}

export function setThreadSessionId(channelId: string, threadId: string, sessionId: string): void {
  const session = loadSession(channelId, threadId);
  if (!session) return;
  if (session.sessionId === sessionId) return;
  session.sessionId = sessionId;
  saveSession(session);
}

export function getThreadSessionId(
  channelId: string,
  threadId: string,
  providerId?: "opencode" | "claudecode" | "codex" | "kimi" | "kiro" | "kilo" | "qwen" | "goose" | "gemini"
): string | null {
  const session = loadSession(channelId, threadId);
  if (!session?.sessionId) return null;
  if (providerId && session.providerId !== providerId) {
    return null;
  }
  return session.sessionId;
}

export function findReplyThreadIdByStatusMessageTs(messageTs: string): string | null {
  for (const session of activeSessions.values()) {
    const activeRequest = session.activeRequest;
    if (!activeRequest) continue;
    if (activeRequest.statusMessageTs === messageTs) {
      return activeRequest.replyThreadId || null;
    }
  }

  if (!sessionsHydrated) {
    const foundFromDisk = findReplyThreadIdByStatusMessageTsFromDisk(messageTs);
    if (foundFromDisk) {
      return foundFromDisk;
    }
    scheduleSessionsHydration();
  }

  return null;
}

export function findStatusMessageBotIdByStatusMessageTs(messageTs: string): string | null {
  for (const session of activeSessions.values()) {
    const activeRequest = session.activeRequest;
    if (!activeRequest) continue;
    if (activeRequest.statusMessageTs === messageTs) {
      return activeRequest.statusMessageBotId || null;
    }
  }

  if (!sessionsHydrated) {
    const foundFromDisk = findStatusMessageBotIdByStatusMessageTsFromDisk(messageTs);
    if (foundFromDisk) {
      return foundFromDisk;
    }
    scheduleSessionsHydration();
  }

  return null;
}

function findReplyThreadIdByStatusMessageTsFromDisk(messageTs: string): string | null {
  try {
    ensureSessionsDir();
    const files = readdirSync(SESSIONS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(SESSIONS_DIR, file);
      try {
        const data = readFileSync(filePath, "utf-8");
        const session = normalizeLoadedSession(JSON.parse(data) as PersistedSession);
        if (isSessionExpired(session, now)) {
          continue;
        }

        const sessionKey = getSessionKey(session.channelId, session.threadId);
        if (!activeSessions.has(sessionKey)) {
          activeSessions.set(sessionKey, session);
        }

        const activeRequest = session.activeRequest;
        if (!activeRequest) continue;
        if (activeRequest.statusMessageTs === messageTs) {
          return activeRequest.replyThreadId || null;
        }
      } catch {
        // Skip invalid session files
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return null;
}

function findStatusMessageBotIdByStatusMessageTsFromDisk(messageTs: string): string | null {
  try {
    ensureSessionsDir();
    const files = readdirSync(SESSIONS_DIR);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = join(SESSIONS_DIR, file);
      try {
        const data = readFileSync(filePath, "utf-8");
        const session = normalizeLoadedSession(JSON.parse(data) as PersistedSession);
        if (isSessionExpired(session, now)) {
          continue;
        }

        const sessionKey = getSessionKey(session.channelId, session.threadId);
        if (!activeSessions.has(sessionKey)) {
          activeSessions.set(sessionKey, session);
        }

        const activeRequest = session.activeRequest;
        if (!activeRequest) continue;
        if (activeRequest.statusMessageTs === messageTs) {
          return activeRequest.statusMessageBotId || null;
        }
      } catch {
        // Skip invalid session files
      }
    }
  } catch {
    // Ignore directory read errors
  }

  return null;
}

export interface ActiveThreadInfo {
  channelId: string;
  threadId: string;
  lastActiveAt: number;
}

export function markThreadActive(channelId: string, threadId: string): void {
  const session = loadSession(channelId, threadId);
  if (!session) return;
  session.lastActivityAt = Date.now();
  saveSession(session, { immediate: false });
}

export function isThreadActive(channelId: string, threadId: string): boolean {
  const session = loadSession(channelId, threadId);
  if (!session) return false;
  return Date.now() - getSessionLastActiveAt(session) < ACTIVE_THREAD_WINDOW_MS;
}

export function getActiveThreads(): ActiveThreadInfo[] {
  const now = Date.now();
  return loadAllSessions()
    .filter((session) => now - getSessionLastActiveAt(session) < ACTIVE_THREAD_WINDOW_MS)
    .map((session) => ({
      channelId: session.channelId,
      threadId: session.threadId,
      lastActiveAt: getSessionLastActiveAt(session),
    }));
}

export function getThreadParticipantBotIds(channelId: string, threadId: string): string[] {
  const session = loadSession(channelId, threadId);
  if (!session?.participantBotIds || session.participantBotIds.length === 0) {
    return [];
  }
  return session.participantBotIds;
}

export function clearThreadSessions(channelId: string): void {
  const sessions = loadAllSessions().filter((session) => session.channelId === channelId);
  for (const session of sessions) {
    deleteSession(session.channelId, session.threadId);
  }
}

// Deduplication
function buildMessageDedupKey(channelId: string, threadId: string, messageTs: string): string {
  return `${channelId}:${threadId}:${messageTs}`;
}

export function isMessageProcessed(channelId: string, threadId: string, messageTs: string): boolean {
  return processedMessages.has(buildMessageDedupKey(channelId, threadId, messageTs));
}

export function markMessageProcessed(channelId: string, threadId: string, messageTs: string): void {
  processedMessages.add(buildMessageDedupKey(channelId, threadId, messageTs));

  // Keep only last 1000 messages
  if (processedMessages.size > 1000) {
    const entries = Array.from(processedMessages);
    for (let i = 0; i < 500; i++) {
      const entry = entries[i];
      if (entry) processedMessages.delete(entry);
    }
  }
}
