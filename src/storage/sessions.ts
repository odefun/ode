import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../logger";

const XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const SESSIONS_DIR = join(XDG_STATE_HOME, "ode", "sessions");

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
  threadId: string;
  statusMessageTs: string;
  prompt: string;
  startedAt: number;
  lastUpdatedAt: number;
  currentStatus: string;
  currentStep?: string;
  currentText: string;
  tools: TrackedTool[];
  todos: TrackedTodo[];
  state: "processing" | "completed" | "failed";
  finalResponseTs?: string;
  error?: string;
}

export interface SessionPlan {
  status: "planning" | "awaiting_input" | "ready" | "building" | "complete";
  todos: TrackedTodo[];
  messageTs?: string;
  text?: string;
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
  workingDirectory: string;
  threadOwnerUserId?: string;
  createdAt: number;
  lastActivityAt: number;
  activeRequest?: ActiveRequest;
  plan?: SessionPlan;
  pendingQuestion?: PendingQuestion;
}

// In-memory cache
const activeSessions = new Map<string, PersistedSession>();
const processedMessages = new Set<string>();

function ensureSessionsDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getSessionKey(channelId: string, threadId: string): string {
  return `${channelId}-${threadId}`;
}

function getSessionFilePath(sessionKey: string): string {
  // Sanitize key for filename
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9-]/g, "_");
  return join(SESSIONS_DIR, `${safeKey}.json`);
}

export function loadSession(channelId: string, threadId: string): PersistedSession | null {
  const sessionKey = getSessionKey(channelId, threadId);

  // Check cache first
  if (activeSessions.has(sessionKey)) {
    return activeSessions.get(sessionKey)!;
  }

  const filePath = getSessionFilePath(sessionKey);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const data = readFileSync(filePath, "utf-8");
    const session = JSON.parse(data) as PersistedSession;
    activeSessions.set(sessionKey, session);
    return session;
  } catch (err) {
    log.warn("Failed to load session", { sessionKey, error: String(err) });
    return null;
  }
}

export function saveSession(session: PersistedSession): void {
  ensureSessionsDir();
  const sessionKey = getSessionKey(session.channelId, session.threadId);
  session.lastActivityAt = Date.now();
  activeSessions.set(sessionKey, session);

  const filePath = getSessionFilePath(sessionKey);
  try {
    writeFileSync(filePath, JSON.stringify(session, null, 2));
  } catch (err) {
    log.error("Failed to save session", { sessionKey, error: String(err) });
  }
}

export function deleteSession(channelId: string, threadId: string): void {
  const sessionKey = getSessionKey(channelId, threadId);
  activeSessions.delete(sessionKey);

  const filePath = getSessionFilePath(sessionKey);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore delete errors
    }
  }
}

export function createActiveRequest(
  sessionId: string,
  channelId: string,
  threadId: string,
  statusMessageTs: string,
  prompt: string
): ActiveRequest {
  return {
    sessionId,
    channelId,
    threadId,
    statusMessageTs,
    prompt,
    startedAt: Date.now(),
    lastUpdatedAt: Date.now(),
    currentStatus: "Starting",
    currentText: "",
    tools: [],
    todos: [],
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

  Object.assign(session.activeRequest, updates, { lastUpdatedAt: Date.now() });
  saveSession(session);
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
  ensureSessionsDir();
  const sessions: PersistedSession[] = [];

  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const filePath = join(SESSIONS_DIR, file);
      try {
        const data = readFileSync(filePath, "utf-8");
        const session = JSON.parse(data) as PersistedSession;
        sessions.push(session);
        const sessionKey = getSessionKey(session.channelId, session.threadId);
        activeSessions.set(sessionKey, session);
      } catch {
        // Skip invalid session files
      }
    }
  } catch {
    // Sessions dir doesn't exist yet
  }

  return sessions;
}

export function getSessionsWithPendingRequests(): PersistedSession[] {
  return loadAllSessions().filter(
    s => s.activeRequest && s.activeRequest.state === "processing"
  );
}

// Deduplication
export function isMessageProcessed(messageTs: string): boolean {
  return processedMessages.has(messageTs);
}

export function markMessageProcessed(messageTs: string): void {
  processedMessages.add(messageTs);

  // Keep only last 1000 messages
  if (processedMessages.size > 1000) {
    const entries = Array.from(processedMessages);
    for (let i = 0; i < 500; i++) {
      const entry = entries[i];
      if (entry) processedMessages.delete(entry);
    }
  }
}
