import {
  createOpencode,
  type OpencodeClient,
  type EventPermissionAsked,
} from "@opencode-ai/sdk/v2";
import { execSync } from "child_process";
import { log } from "../../logger";

// Per-session OpenCode instances
export type SessionEnvironment = Record<string, string>;

interface SessionInstance {
  instance: Awaited<ReturnType<typeof createOpencode>>;
  client: OpencodeClient;
  handlers: Set<EventHandler>;
  lastActive: number;
  eventLoopRunning: boolean;
  validSessionIds: Set<string>; // Sessions created in this instance
  env: SessionEnvironment;
}

const sessionInstances = new Map<string, SessionInstance>();
const sessionStartPromises = new Map<string, Promise<SessionInstance>>();
const sessionEnvironments = new Map<string, SessionEnvironment>();
let envQueue: Promise<unknown> = Promise.resolve();

async function withEnvOverrides<T>(
  overrides: SessionEnvironment | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return fn();
  }

  const run = async () => {
    const previous: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(overrides)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  };

  const result = envQueue.then(run, run);
  envQueue = result.then(() => undefined, () => undefined);
  return result;
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

  // Create new instance
  const promise = (async () => {
    log.info("Creating OpenCode instance for session", { sessionId });

    try {
      const instance = await withEnvOverrides(env, () => createOpencode({ port: 0 }));
      log.info("OpenCode instance ready", { sessionId, url: instance.server.url });

      const sessionInstance: SessionInstance = {
        instance,
        client: instance.client,
        handlers: new Set(),
        lastActive: Date.now(),
        eventLoopRunning: false,
        validSessionIds: new Set(),
        env,
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
  session.instance.server.close();
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

        session.lastActive = Date.now();
        const event = (globalEvent as any).payload ?? globalEvent;
        const directory = (globalEvent as any).directory;

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
  const instance = await withEnvOverrides(env, () => createOpencode({ port: 0 }));
  log.info("Created new OpenCode instance", { url: instance.server.url });

  return {
    client: instance.client,
    register: (sessionId: string, sessionEnv: SessionEnvironment = env) => {
      const normalizedEnv = sessionEnv ?? {};
      const sessionInstance: SessionInstance = {
        instance,
        client: instance.client,
        handlers: new Set(),
        lastActive: Date.now(),
        eventLoopRunning: false,
        validSessionIds: new Set([sessionId]), // This session is valid in this instance
        env: normalizedEnv,
      };

      sessionInstances.set(sessionId, sessionInstance);
      sessionEnvironments.set(sessionId, normalizedEnv);
      startSessionEventLoop(sessionId, sessionInstance);
      ensureCleanupInterval();

      log.info("Registered OpenCode instance for session", { sessionId });
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
  return sessionInstances.get(sessionId)?.instance.server.url ?? null;
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
  log.info("Creating new session in existing instance (stale sessionId)", { oldSessionId: sessionId });

  const result = await session.client.session.create({
    directory: workingPath,
  });

  if (!result.data?.id) {
    throw new Error("Failed to create session in instance");
  }

  const newSessionId = result.data.id;
  session.validSessionIds.add(newSessionId);

  // Update the instance mapping to use the new sessionId
  sessionInstances.delete(sessionId);
  sessionInstances.set(newSessionId, session);

  log.info("Created new session in instance", { oldSessionId: sessionId, newSessionId });

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

  // Fallback: kill any orphaned opencode serve processes
  try {
    execSync('pkill -f "opencode serve" 2>/dev/null || true', { stdio: 'ignore' });
  } catch {
    // Ignore errors - pkill returns non-zero if no processes found
  }

  log.info("All OpenCode instances stopped");
}

// Get any available client (for operations that don't need a specific session)
export async function getAnyClient(): Promise<OpencodeClient> {
  // Use existing session if available
  const firstSession = sessionInstances.values().next().value;
  if (firstSession) {
    firstSession.lastActive = Date.now();
    return firstSession.client;
  }

  // Create a temporary instance
  const instance = await createOpencode({ port: 0 });
  log.debug("Created temporary OpenCode instance for query");
  return instance.client;
}

// Get URL from any available instance
export async function getAnyServerUrl(): Promise<string> {
  // Use existing session if available
  const firstSession = sessionInstances.values().next().value;
  if (firstSession) {
    firstSession.lastActive = Date.now();
    return firstSession.instance.server.url;
  }

  // Create a temporary instance
  const instance = await createOpencode({ port: 0 });
  log.debug("Created temporary OpenCode instance for URL");
  return instance.server.url;
}

// Legacy compatibility
export function getClient(): OpencodeClient {
  throw new Error("getClient() is deprecated - use getSessionClient(sessionId) or getAnyClient()");
}

export function getServerUrl(): string {
  throw new Error("getServerUrl() is deprecated - use getAnyServerUrl() instead");
}

export async function startServer(): Promise<void> {
  // No-op for compatibility - instances are created on-demand
  log.debug("startServer() called - instances are now per-session");
}

export async function stopServer(): Promise<void> {
  stopAllSessions();
}

export function isServerReady(): boolean {
  return true; // Always "ready" since instances are created on-demand
}
