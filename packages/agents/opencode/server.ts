import {
  createOpencodeClient,
  type OpencodeClient,
  type EventPermissionAsked,
} from "@opencode-ai/sdk/v2";
import { spawn, type ChildProcess } from "child_process";
import { BoundedSet, extractEventSessionId, log } from "@/utils";
import { getOpenCodeModels, setOpenCodeModels } from "@/config";
import {
  extractOpenCodeChildSession,
  getOpenCodeEventFingerprint,
  isMeaningfulOpenCodeEvent,
  normalizeOpenCodeGlobalEvent,
  normalizeOpenCodePermissionQuestion,
  parseOpenCodePermissionReply,
} from "./events";

// Per-session OpenCode instances
export type SessionEnvironment = Record<string, string>;

interface SessionInstance {
  client: OpencodeClient;
  handlers: Set<EventHandler>;
  lastActive: number;
  lastMeaningfulEventAt: number;
  eventLoopRunning: boolean;
  rootSessionId: string;
  validSessionIds: Set<string>; // Sessions created in this instance
  childTitles: Map<string, string>;
  awaitingInteractionSessionIds: Set<string>;
  seenEventFingerprints: BoundedSet<string>;
  env: SessionEnvironment;
  baseUrl: string;
}

export type OpenCodeSessionRuntimeSnapshot = {
  rootSessionId: string;
  relatedSessionIds: string[];
  lastMeaningfulEventAt: number;
  awaitingInteraction: boolean;
};

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

type PendingOpenCodePermission = {
  session: SessionInstance;
  subscriptionSessionId: string;
  interactionSessionId: string;
  directory?: string;
};

const pendingOpenCodePermissions = new Map<string, PendingOpenCodePermission>();

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

function extractProviderModelIds(providerId: string, models: unknown): string[] {
  if (Array.isArray(models)) {
    return models
      .map((entry) => {
        if (typeof entry === "string") return `${providerId}/${entry}`;
        if (!entry || typeof entry !== "object") return "";
        const model = entry as Record<string, unknown>;
        const modelId =
          (typeof model.id === "string" && model.id)
          || (typeof model.modelID === "string" && model.modelID)
          || (typeof model.modelId === "string" && model.modelId)
          || "";
        return modelId ? `${providerId}/${modelId}` : "";
      })
      .filter(Boolean);
  }

  if (models && typeof models === "object") {
    const record = models as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return extractProviderModelIds(providerId, record.items);
    }
    return Object.entries(record)
      .map(([key, value]) => {
        if (typeof value === "string") return `${providerId}/${value}`;
        if (value && typeof value === "object") {
          const model = value as Record<string, unknown>;
          const modelId =
            (typeof model.id === "string" && model.id)
            || (typeof model.modelID === "string" && model.modelID)
            || (typeof model.modelId === "string" && model.modelId)
            || key;
          return modelId ? `${providerId}/${modelId}` : "";
        }
        return key ? `${providerId}/${key}` : "";
      })
      .filter(Boolean);
  }

  return [];
}

function extractOpenCodeModels(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  const providersRaw = Object.prototype.hasOwnProperty.call(data, "providers") ? data.providers : data;
  const models = new Set<string>();

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object") continue;
      const provider = entry as Record<string, unknown>;
      const providerId =
        (typeof provider.id === "string" && provider.id)
        || (typeof provider.providerID === "string" && provider.providerID)
        || (typeof provider.providerId === "string" && provider.providerId)
        || "";
      if (!providerId) continue;
      for (const model of extractProviderModelIds(providerId, provider.models)) {
        models.add(model);
      }
    }
  } else if (providersRaw && typeof providersRaw === "object") {
    for (const [providerId, providerValue] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (!providerValue || typeof providerValue !== "object") continue;
      const provider = providerValue as Record<string, unknown>;
      for (const model of extractProviderModelIds(providerId, provider.models)) {
        models.add(model);
      }
    }
  }

  return Array.from(models).sort();
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
      if (
        session.awaitingInteractionSessionIds.size === 0
        && now - session.lastActive > INACTIVE_TIMEOUT_MS
      ) {
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
        lastMeaningfulEventAt: Date.now(),
        eventLoopRunning: false,
        rootSessionId: sessionId,
        validSessionIds: new Set(),
        childTitles: new Map(),
        awaitingInteractionSessionIds: new Set(),
        seenEventFingerprints: new BoundedSet(5_000),
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
  for (const [requestId, pending] of pendingOpenCodePermissions) {
    if (pending.session === session) pendingOpenCodePermissions.delete(requestId);
  }
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

        const normalizedGlobalEvent = normalizeOpenCodeGlobalEvent(globalEvent, {
          rootSessionId: session.rootSessionId,
          childTitle: (childSessionId) => session.childTitles.get(childSessionId),
        });
        if (!normalizedGlobalEvent) continue;
        const event = normalizedGlobalEvent.payload;
        const directory = normalizedGlobalEvent.directory;

        const child = extractOpenCodeChildSession(event);
        if (
          child
          && (!child.parentSessionId || session.validSessionIds.has(child.parentSessionId))
        ) {
          session.validSessionIds.add(child.sessionId);
          if (child.title) session.childTitles.set(child.sessionId, child.title);
        }

        const eventSessionId = extractEventSessionId(event as Record<string, unknown> | undefined);
        if (eventSessionId && !session.validSessionIds.has(eventSessionId)) {
          continue;
        }
        if (!eventSessionId && !isMeaningfulOpenCodeEvent(event)) {
          continue;
        }

        const fingerprint = getOpenCodeEventFingerprint(event);
        if (fingerprint && session.seenEventFingerprints.has(fingerprint)) {
          continue;
        }
        if (fingerprint) session.seenEventFingerprints.add(fingerprint);

        session.lastActive = Date.now();
        if (isMeaningfulOpenCodeEvent(event)) {
          session.lastMeaningfulEventAt = session.lastActive;
        }

        const interactionSessionId = eventSessionId ?? session.rootSessionId;
        if (event.type === "question.asked") {
          session.awaitingInteractionSessionIds.add(interactionSessionId);
        } else if (
          event.type === "question.replied"
          || event.type === "question.rejected"
          || event.type === "permission.replied"
        ) {
          session.awaitingInteractionSessionIds.delete(interactionSessionId);
          if (event.type === "permission.replied") {
            const properties = event.properties as { requestID?: unknown } | undefined;
            if (typeof properties?.requestID === "string") {
              pendingOpenCodePermissions.delete(properties.requestID);
            }
          }
        }

        const eventsToDispatch = [normalizedGlobalEvent];
        if (event.type === "permission.asked") {
          const permEvent = event as EventPermissionAsked;
          const requestId = permEvent.properties?.id;
          const permissionQuestion = normalizeOpenCodePermissionQuestion(event);
          if (requestId && permissionQuestion) {
            pendingOpenCodePermissions.set(requestId, {
              session,
              subscriptionSessionId: sessionId,
              interactionSessionId,
              directory,
            });
            session.awaitingInteractionSessionIds.add(interactionSessionId);
            eventsToDispatch.push({ directory, payload: permissionQuestion });
          }
        }

        for (const eventToDispatch of eventsToDispatch) {
          for (const handler of session.handlers) {
            try {
              handler(eventToDispatch);
            } catch (err) {
              log.debug("Session event handler error", {
                sessionId,
                error: String(err),
              });
            }
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
        lastMeaningfulEventAt: Date.now(),
        eventLoopRunning: false,
        rootSessionId: sessionId,
        validSessionIds: new Set([sessionId]), // This session is valid in this instance
        childTitles: new Map(),
        awaitingInteractionSessionIds: new Set(),
        seenEventFingerprints: new BoundedSet(5_000),
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

export async function replyToOpenCodePermission(params: {
  sessionId: string;
  requestId: string;
  answers: Array<Array<string>>;
}): Promise<boolean> {
  const pending = pendingOpenCodePermissions.get(params.requestId);
  if (!pending) return false;
  const validSession = params.sessionId === pending.subscriptionSessionId
    || params.sessionId === pending.interactionSessionId
    || pending.session.validSessionIds.has(params.sessionId);
  if (!validSession) {
    throw new Error(`OpenCode permission request does not belong to session: ${params.sessionId}`);
  }
  const response = await pending.session.client.permission.reply({
    requestID: params.requestId,
    reply: parseOpenCodePermissionReply(params.answers),
    directory: pending.directory,
  });
  if (response.error) {
    throw new Error(`OpenCode permission reply error: ${response.error}`);
  }
  pendingOpenCodePermissions.delete(params.requestId);
  pending.session.awaitingInteractionSessionIds.delete(pending.interactionSessionId);
  return true;
}

export function getSessionEnvironment(sessionId: string): SessionEnvironment | null {
  return runtimeState.sessionEnvironments.get(sessionId) ?? null;
}

export function getSessionServerUrl(sessionId: string): string | null {
  const session = runtimeState.sessionInstances.get(sessionId);
  return session?.baseUrl ?? null;
}

export function getSessionRuntimeSnapshot(
  sessionId: string
): OpenCodeSessionRuntimeSnapshot | null {
  const session = runtimeState.sessionInstances.get(sessionId);
  if (!session) return null;
  return {
    rootSessionId: session.rootSessionId,
    relatedSessionIds: [...session.validSessionIds],
    lastMeaningfulEventAt: session.lastMeaningfulEventAt,
    awaitingInteraction: session.awaitingInteractionSessionIds.size > 0,
  };
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
  session.rootSessionId = newSessionId;
  session.lastMeaningfulEventAt = Date.now();

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
