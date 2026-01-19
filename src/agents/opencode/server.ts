import {
  createOpencodeClient,
  type OpencodeClient,
  type EventPermissionAsked,
} from "@opencode-ai/sdk/v2";
import { log } from "../../logger";
import { loadEnv } from "../../config";

// Per-session OpenCode instances
export type SessionEnvironment = Record<string, string>;

interface SessionInstance {
  client: OpencodeClient;
  handlers: Set<EventHandler>;
  lastActive: number;
  eventLoopRunning: boolean;
  validSessionIds: Set<string>; // Sessions created in this instance
  env: SessionEnvironment;
  baseUrl: string;
}

const sessionInstances = new Map<string, SessionInstance>();
const sessionStartPromises = new Map<string, Promise<SessionInstance>>();
const sessionEnvironments = new Map<string, SessionEnvironment>();
const clientByBaseUrl = new Map<string, OpencodeClient>();

function resolveServerUrl(): string {
  return loadEnv().OPENCODE_SERVER_URL;
}

function resolveServerUrlForEnv(env?: SessionEnvironment): string {
  const override = env?.OPENCODE_SERVER_URL;
  if (override && override.trim().length > 0) return override;
  return resolveServerUrl();
}

function getClientForBaseUrl(baseUrl: string): OpencodeClient {
  const existing = clientByBaseUrl.get(baseUrl);
  if (existing) return existing;
  const client = createOpencodeClient({ baseUrl });
  clientByBaseUrl.set(baseUrl, client);
  log.info("Using OpenCode server", { baseUrl });
  return client;
}

// Cleanup inactive sessions after 10 minutes
const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export type EventHandler = (event: unknown) => void;

// Start cleanup interval
function ensureCleanupInterval(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessionInstances) {
      if (now - session.lastActive > INACTIVE_TIMEOUT_MS) {
        log.info("Cleaning up inactive session", { sessionId });
        stopSessionInstance(sessionId);
      }
    }
  }, 60_000); // Check every minute
}

// Get or create OpenCode instance for a session
async function getOrCreateSessionInstance(
  sessionId: string,
  envOverrides?: SessionEnvironment
): Promise<SessionInstance> {
  // Return existing instance
  const existing = sessionInstances.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    return existing;
  }

  // Wait for in-flight creation
  const pending = sessionStartPromises.get(sessionId);
  if (pending) {
    return pending;
  }

  const env = envOverrides ?? sessionEnvironments.get(sessionId) ?? {};
  if (envOverrides) {
    sessionEnvironments.set(sessionId, env);
  }

  const baseUrl = resolveServerUrlForEnv(env);

  // Create new instance
  const promise = (async () => {
    log.info("Using OpenCode server for session", { sessionId, baseUrl });

    try {
      const client = getClientForBaseUrl(baseUrl);
      const sessionInstance: SessionInstance = {
        client,
        handlers: new Set(),
        lastActive: Date.now(),
        eventLoopRunning: false,
        validSessionIds: new Set(),
        env,
        baseUrl,
      };

      sessionInstances.set(sessionId, sessionInstance);
      sessionStartPromises.delete(sessionId);

      // Start event loop for this session
      startSessionEventLoop(sessionId, sessionInstance);

      ensureCleanupInterval();

      return sessionInstance;
    } catch (err) {
      sessionStartPromises.delete(sessionId);
      throw err;
    }
  })();

  sessionStartPromises.set(sessionId, promise);
  return promise;
}

// Stop and cleanup a session instance
function stopSessionInstance(sessionId: string): void {
  const session = sessionInstances.get(sessionId);
  if (!session) return;

  session.eventLoopRunning = false;
  session.handlers.clear();
  sessionInstances.delete(sessionId);
  log.info("Stopped OpenCode instance", { sessionId });
}

// Event loop for a specific session
function startSessionEventLoop(sessionId: string, session: SessionInstance): void {
  if (session.eventLoopRunning) return;

  session.eventLoopRunning = true;

  void (async () => {
    try {
      const events = await session.client.global.event();

      for await (const globalEvent of events.stream) {
        if (!session.eventLoopRunning) break;

        const event = (globalEvent as any).payload ?? globalEvent;
        const directory = (globalEvent as any).directory;
        const eventSessionId = event?.properties?.sessionID ?? event?.properties?.part?.sessionID;
        if (eventSessionId && eventSessionId !== sessionId) {
          continue;
        }

        session.lastActive = Date.now();

        // Handle permissions
        if (event.type === "permission.asked") {
          const permEvent = event as EventPermissionAsked;
          const requestId = permEvent.properties?.id;
          if (requestId) {
            log.debug("Auto-approving permission", { sessionId, requestId });
            try {
              await session.client.permission.reply({
                requestID: requestId,
                reply: "always",
                directory,
              });
            } catch (err) {
              log.warn("Failed to approve permission", {
                sessionId,
                requestId,
                error: String(err),
              });
            }
          }
        }

        // Dispatch to all handlers for this session
        for (const handler of session.handlers) {
          try {
            handler(globalEvent);
          } catch (err) {
            log.debug("Session event handler error", {
              sessionId,
              error: String(err),
            });
          }
        }
      }
    } catch (err) {
      if (session.eventLoopRunning) {
        log.warn("Session event loop error", { sessionId, error: String(err) });
      }
    }
  })();
}

// Create a new session instance and return client + cleanup
export async function createSessionInstance(envOverrides?: SessionEnvironment): Promise<{
  client: OpencodeClient;
  register: (sessionId: string, env?: SessionEnvironment) => void;
}> {
  const env = envOverrides ?? {};
  const baseUrl = resolveServerUrlForEnv(env);
  const client = getClientForBaseUrl(baseUrl);
  log.info("Using OpenCode server for new session", { baseUrl });

  return {
    client,
    register: (sessionId: string, sessionEnv: SessionEnvironment = env) => {
      const normalizedEnv = sessionEnv ?? {};
      const normalizedBaseUrl = resolveServerUrlForEnv(normalizedEnv);
      const sessionInstance: SessionInstance = {
        client: getClientForBaseUrl(normalizedBaseUrl),
        handlers: new Set(),
        lastActive: Date.now(),
        eventLoopRunning: false,
        validSessionIds: new Set([sessionId]), // This session is valid in this instance
        env: normalizedEnv,
        baseUrl: normalizedBaseUrl,
      };

      sessionInstances.set(sessionId, sessionInstance);
      sessionEnvironments.set(sessionId, normalizedEnv);
      startSessionEventLoop(sessionId, sessionInstance);
      ensureCleanupInterval();

      log.info("Registered OpenCode session", { sessionId });
    },
  };
}

// Public API - get client for a session
export async function getSessionClient(sessionId: string): Promise<OpencodeClient> {
  const session = await getOrCreateSessionInstance(sessionId);
  return session.client;
}

export function getSessionEnvironment(sessionId: string): SessionEnvironment | null {
  return sessionEnvironments.get(sessionId) ?? null;
}

export function getSessionServerUrl(sessionId: string): string | null {
  const session = sessionInstances.get(sessionId);
  return session?.baseUrl ?? null;
}

// Subscribe to events for a session (sync if instance exists, else queues)
export function subscribeToSession(
  sessionId: string,
  handler: EventHandler
): () => void {
  // If instance already exists, add handler synchronously
  const existing = sessionInstances.get(sessionId);
  if (existing) {
    existing.handlers.add(handler);
    log.debug("Subscribed to session events (sync)", { sessionId, handlerCount: existing.handlers.size });
  } else {
    // Instance doesn't exist yet - this shouldn't happen if ensureSession was called first
    log.warn("subscribeToSession called before instance exists", { sessionId });
    void getOrCreateSessionInstance(sessionId).then((session) => {
      session.handlers.add(handler);
      log.debug("Subscribed to session events (async)", { sessionId, handlerCount: session.handlers.size });
    });
  }

  return () => {
    const session = sessionInstances.get(sessionId);
    if (session) {
      session.handlers.delete(handler);
      log.debug("Unsubscribed from session events", { sessionId, handlerCount: session.handlers.size });
    }
  };
}

// Ensure session instance exists (call before sending messages)
export async function ensureSession(sessionId: string): Promise<void> {
  await getOrCreateSessionInstance(sessionId);
}

// Ensure a valid OpenCode session exists within the instance
// Returns the valid sessionId (may be different if session was recreated)
export async function ensureValidSession(
  sessionId: string,
  workingPath: string
): Promise<string> {
  const session = await getOrCreateSessionInstance(sessionId);

  // If this session was created in this instance, it's valid
  if (session.validSessionIds.has(sessionId)) {
    return sessionId;
  }

  // Session doesn't exist in this instance - create a new one
  log.info("Creating new session for server", { oldSessionId: sessionId });

  const result = await session.client.session.create({
    directory: workingPath,
  });

  if (!result.data?.id) {
    throw new Error("Failed to create session in server");
  }

  const newSessionId = result.data.id;
  session.validSessionIds.add(newSessionId);

  // Update the instance mapping to use the new sessionId
  sessionInstances.delete(sessionId);
  sessionInstances.set(newSessionId, session);

  log.info("Created new session on server", { oldSessionId: sessionId, newSessionId });

  return newSessionId;
}

// Mark session as active (resets cleanup timer)
export function touchSession(sessionId: string): void {
  const session = sessionInstances.get(sessionId);
  if (session) {
    session.lastActive = Date.now();
  }
}

// Stop all instances (for shutdown)
export function stopAllSessions(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  // Stop tracked instances
  for (const sessionId of sessionInstances.keys()) {
    stopSessionInstance(sessionId);
  }

  clientByBaseUrl.clear();

  log.info("All OpenCode sessions stopped");
}

// Get any available client (for operations that don't need a specific session)
export async function getAnyClient(): Promise<OpencodeClient> {
  return getClientForBaseUrl(resolveServerUrl());
}

// Get URL from any available instance
export async function getAnyServerUrl(): Promise<string> {
  return resolveServerUrl();
}

// Legacy compatibility
export function getClient(): OpencodeClient {
  throw new Error("getClient() is deprecated - use getSessionClient(sessionId) or getAnyClient()");
}

export function getServerUrl(): string {
  throw new Error("getServerUrl() is deprecated - use getAnyServerUrl() instead");
}

export async function startServer(): Promise<void> {
  log.debug("startServer() called - using external OpenCode server");
}

export async function stopServer(): Promise<void> {
  stopAllSessions();
}

export function isServerReady(): boolean {
  return true;
}
