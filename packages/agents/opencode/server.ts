import {
  createOpencodeClient,
  type OpencodeClient,
  type EventPermissionAsked,
} from "@opencode-ai/sdk/v2";
import { spawn, type ChildProcess } from "child_process";
import { extractEventSessionId, log } from "@/utils";
import { getOpenCodeModels, setOpenCodeModels } from "@/config";
import { extractOpenCodeModels } from "@/shared/provider-models";

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

class OpenCodeServerRuntimeState {
  readonly sessionInstances = new Map<string, SessionInstance>();
  readonly sessionStartPromises = new Map<string, Promise<SessionInstance>>();
  readonly sessionEnvironments = new Map<string, SessionEnvironment>();
  readonly clientByBaseUrl = new Map<string, OpencodeClient>();
  managedServerProcess: ChildProcess | null = null;
  serverStartPromise: Promise<void> | null = null;
  managedServerUrl: string | null = null;
  cleanupInterval: ReturnType<typeof setInterval> | null = null;
}

const runtimeState = new OpenCodeServerRuntimeState();

const LISTENING_URL_REGEX = /opencode server listening on\s+(https?:\/\/\S+)/i;

function resolveServerUrl(): string {
  return runtimeState.managedServerUrl ?? "http://127.0.0.1:4096";
}

function resolveServerUrlForEnv(env?: SessionEnvironment): string {
  void env;
  return resolveServerUrl();
}

function getClientForBaseUrl(baseUrl: string): OpencodeClient {
  const existing = runtimeState.clientByBaseUrl.get(baseUrl);
  if (existing) return existing;
  const client = createOpencodeClient({ baseUrl });
  runtimeState.clientByBaseUrl.set(baseUrl, client);
  log.debug("Using OpenCode server", { baseUrl });
  return client;
}

function getServerCommand(): { command: string; args: string[] } {
  return {
    command: "opencode",
    args: ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
  };
}

async function waitForServerReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  const endpoint = new URL("/config/providers", baseUrl).toString();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Keep polling while server boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for OpenCode server on ${baseUrl}`);
}

async function syncModelsFromServer(baseUrl: string): Promise<void> {
  try {
    const endpoint = new URL("/config/providers", baseUrl).toString();
    const response = await fetch(endpoint);
    if (!response.ok) {
      log.warn("OpenCode model sync failed", { baseUrl, status: response.status });
      return;
    }
    const payload = await response.json();
    const models = extractOpenCodeModels(payload);
    const existing = getOpenCodeModels();
    if (JSON.stringify(existing) === JSON.stringify(models)) return;
    setOpenCodeModels(models);
    log.debug("OpenCode models synced", { count: models.length });
  } catch (error) {
    log.warn("OpenCode model sync failed", { error: String(error) });
  }
}

async function ensureServerStarted(): Promise<void> {
  if (runtimeState.managedServerProcess && runtimeState.managedServerProcess.exitCode === null) {
    return;
  }
  if (runtimeState.serverStartPromise) {
    await runtimeState.serverStartPromise;
    return;
  }

  const { command, args } = getServerCommand();
  runtimeState.serverStartPromise = (async () => {
    log.debug("Starting managed OpenCode server", { command: [command, ...args].join(" ") });
    const processHandle = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    runtimeState.managedServerProcess = processHandle;

    const discoveredUrl = new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const message = chunk.toString();
        const match = message.match(LISTENING_URL_REGEX);
        if (match?.[1]) {
          resolve(match[1]);
        }
      };
      processHandle.stdout?.on("data", onData);
      processHandle.stderr?.on("data", onData);
      processHandle.once("exit", () => {
        reject(new Error("OpenCode server exited before exposing listening URL"));
      });
    });

    processHandle.stdout?.on("data", (chunk) => {
      log.debug("OpenCode server stdout", { message: chunk.toString().trim() });
    });
    processHandle.stderr?.on("data", (chunk) => {
      log.debug("OpenCode server stderr", { message: chunk.toString().trim() });
    });
    processHandle.on("exit", (code, signal) => {
      log.warn("Managed OpenCode server exited", { code, signal });
      if (runtimeState.managedServerProcess === processHandle) {
        runtimeState.managedServerProcess = null;
      }
    });

    const discoveredBaseUrl = await discoveredUrl;
    runtimeState.managedServerUrl = discoveredBaseUrl;
    await waitForServerReady(discoveredBaseUrl);
    await syncModelsFromServer(discoveredBaseUrl);
    log.debug("Managed OpenCode server ready", { baseUrl: discoveredBaseUrl });
  })();

  try {
    await runtimeState.serverStartPromise;
  } finally {
    runtimeState.serverStartPromise = null;
  }
}

// Cleanup inactive sessions after 10 minutes
const INACTIVE_TIMEOUT_MS = 10 * 60 * 1000;
export type EventHandler = (event: unknown) => void;

// Start cleanup interval
function ensureCleanupInterval(): void {
  if (runtimeState.cleanupInterval) return;

  runtimeState.cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of runtimeState.sessionInstances) {
      if (now - session.lastActive > INACTIVE_TIMEOUT_MS) {
        log.debug("Cleaning up inactive session", { sessionId });
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
  const existing = runtimeState.sessionInstances.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    return existing;
  }

  // Wait for in-flight creation
  const pending = runtimeState.sessionStartPromises.get(sessionId);
  if (pending) {
    return pending;
  }

  const env = envOverrides ?? runtimeState.sessionEnvironments.get(sessionId) ?? {};
  if (envOverrides) {
    runtimeState.sessionEnvironments.set(sessionId, env);
  }

  // Create new instance
  const promise = (async () => {
    try {
      await ensureServerStarted();
      const baseUrl = resolveServerUrlForEnv(env);
      log.debug("Using OpenCode server for session", { sessionId, baseUrl });
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

      runtimeState.sessionInstances.set(sessionId, sessionInstance);
      runtimeState.sessionStartPromises.delete(sessionId);

      // Start event loop for this session
      startSessionEventLoop(sessionId, sessionInstance);

      ensureCleanupInterval();

      return sessionInstance;
    } catch (err) {
      runtimeState.sessionStartPromises.delete(sessionId);
      throw err;
    }
  })();

  runtimeState.sessionStartPromises.set(sessionId, promise);
  return promise;
}

// Stop and cleanup a session instance
function stopSessionInstance(sessionId: string): void {
  const session = runtimeState.sessionInstances.get(sessionId);
  if (!session) return;

  session.eventLoopRunning = false;
  session.handlers.clear();
  runtimeState.sessionInstances.delete(sessionId);
  log.debug("Stopped OpenCode session state", { sessionId });
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
        const eventSessionId = extractEventSessionId(event as Record<string, unknown> | undefined);
        if (eventSessionId && !session.validSessionIds.has(eventSessionId)) {
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
  await ensureServerStarted();
  const baseUrl = resolveServerUrlForEnv(env);
  const client = getClientForBaseUrl(baseUrl);
  log.debug("Using OpenCode server for new session", { baseUrl });

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

      runtimeState.sessionInstances.set(sessionId, sessionInstance);
      runtimeState.sessionEnvironments.set(sessionId, normalizedEnv);
      startSessionEventLoop(sessionId, sessionInstance);
      ensureCleanupInterval();

      log.debug("Registered OpenCode session", { sessionId });
    },
  };
}

// Public API - get client for a session
export async function getSessionClient(sessionId: string): Promise<OpencodeClient> {
  const session = await getOrCreateSessionInstance(sessionId);
  return session.client;
}

export function getSessionEnvironment(sessionId: string): SessionEnvironment | null {
  return runtimeState.sessionEnvironments.get(sessionId) ?? null;
}

export function getSessionServerUrl(sessionId: string): string | null {
  const session = runtimeState.sessionInstances.get(sessionId);
  return session?.baseUrl ?? null;
}

// Subscribe to events for a session (sync if instance exists, else queues)
export function subscribeToSession(
  sessionId: string,
  handler: EventHandler
): () => void {
  let attachedSession: SessionInstance | null = null;

  // If instance already exists, add handler synchronously
  const existing = runtimeState.sessionInstances.get(sessionId);
  if (existing) {
    existing.handlers.add(handler);
    attachedSession = existing;
    log.debug("Subscribed to session events (sync)", { sessionId, handlerCount: existing.handlers.size });
  } else {
    // Instance doesn't exist yet - this shouldn't happen if ensureSession was called first
    log.warn("subscribeToSession called before instance exists", { sessionId });
    void getOrCreateSessionInstance(sessionId).then((session) => {
      session.handlers.add(handler);
      attachedSession = session;
      log.debug("Subscribed to session events (async)", { sessionId, handlerCount: session.handlers.size });
    });
  }

  return () => {
    attachedSession?.handlers.delete(handler);
    if (!attachedSession) return;
    log.debug("Unsubscribed from session events", { sessionId, handlerCount: attachedSession.handlers.size });
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
  log.debug("Creating new session for server", { oldSessionId: sessionId });

  const result = await session.client.session.create({
    directory: workingPath,
  });

  if (!result.data?.id) {
    throw new Error("Failed to create session in server");
  }

  const newSessionId = result.data.id;
  session.validSessionIds.add(newSessionId);

  // Update the instance mapping to use the new sessionId
  runtimeState.sessionInstances.delete(sessionId);
  runtimeState.sessionInstances.set(newSessionId, session);

  log.debug("Created new session on server", { oldSessionId: sessionId, newSessionId });

  return newSessionId;
}

// Stop all instances (for shutdown)
export function stopAllSessions(): void {
  if (runtimeState.cleanupInterval) {
    clearInterval(runtimeState.cleanupInterval);
    runtimeState.cleanupInterval = null;
  }

  // Stop tracked instances
  for (const sessionId of runtimeState.sessionInstances.keys()) {
    stopSessionInstance(sessionId);
  }

  runtimeState.clientByBaseUrl.clear();

  log.debug("All OpenCode sessions stopped");
}

// Get URL from any available instance
export async function getAnyServerUrl(): Promise<string> {
  return resolveServerUrl();
}

export async function startServer(): Promise<void> {
  await ensureServerStarted();
}

export async function stopServer(): Promise<void> {
  stopAllSessions();
  if (runtimeState.managedServerProcess && runtimeState.managedServerProcess.exitCode === null) {
    runtimeState.managedServerProcess.kill("SIGTERM");
  }
  runtimeState.managedServerProcess = null;
  runtimeState.serverStartPromise = null;
  runtimeState.managedServerUrl = null;
}

export function isServerReady(): boolean {
  return Boolean(runtimeState.managedServerProcess && runtimeState.managedServerProcess.exitCode === null);
}
