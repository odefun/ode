import { DEFAULT_CODEX_MODEL, getCodexModels, setCodexModels } from "@/config";
import { setThreadSessionId } from "@/config/local/sessions";
import { BoundedSet, log } from "@/utils";
import { buildPromptParts, buildPromptText, buildSystemPrompt, buildSystemWrappedPrompt } from "../shared";
import {
  CliAgentRuntime,
  formatShellCommand,
  runCliJsonCommand,
  type SessionEnvironment as RuntimeSessionEnvironment,
} from "../runtime/base";
import { createCliThreadSessionManager } from "../runtime/cli-session";
import {
  CodexAppServerConnection,
  CodexAppServerUnavailableError,
  replyToCodexAppServerQuestion,
} from "./app-server";
import {
  createCodexAppEventState,
  getCodexAppNotificationContext,
  isKnownCodexAppNotificationMethod,
  normalizeCodexAppNotification,
  type CodexAppEventState,
  type CodexAppSessionEvent,
} from "./app-events";
import type {
  AgentInput,
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
} from "../types";

const runtime = new CliAgentRuntime("Codex");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
type CodexAppConnectionEntry = {
  connection: CodexAppServerConnection;
  aliases: Set<string>;
  threadId?: string;
  eventState: CodexAppEventState;
  unknownMethods: Set<string>;
};
const appConnections = new Map<string, CodexAppConnectionEntry>();
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "codex",
  providerName: "Codex",
  runtime,
  newSessions,
});

export type SessionEnvironment = RuntimeSessionEnvironment;

type CodexJsonEvent = {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  error?: {
    message?: string;
  };
};

function getCodexModel(options?: OpenCodeOptions): string | undefined {
  const configured = options?.model?.modelID?.trim();
  if (configured) return configured;
  return undefined;
}

type CodexModelCatalog = {
  models?: Array<{ slug?: string }>;
};

function extractCodexModels(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const catalog = payload as CodexModelCatalog;
  if (!Array.isArray(catalog.models)) return [];
  return catalog.models
    .map((entry) => (typeof entry?.slug === "string" ? entry.slug.trim() : ""))
    .filter(Boolean);
}

async function syncCodexModelsFromCache(): Promise<void> {
  const home = process.env.HOME?.trim();
  if (!home) return;
  const cacheFile = Bun.file(`${home}/.codex/models_cache.json`);
  if (!(await cacheFile.exists())) return;

  try {
    const payload = JSON.parse(await cacheFile.text());
    const models = Array.from(new Set([...extractCodexModels(payload), DEFAULT_CODEX_MODEL])).sort();
    if (models.length === 0) return;
    const existing = getCodexModels();
    if (JSON.stringify(existing) === JSON.stringify(models)) return;
    setCodexModels(models);
    log.info("Codex models synced", { count: models.length });
  } catch (error) {
    log.warn("Codex model sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function buildCodexCommandArgs(params: {
  sessionId: string;
  prompt: string;
  model?: string;
  planMode?: boolean;
  isNewSession?: boolean;
}): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check"];
  if (params.planMode) {
    args.push("--sandbox", "read-only");
  } else {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.isNewSession) {
    args.push(params.prompt);
  } else {
    args.push("resume", params.sessionId, params.prompt);
  }
  return args;
}

export function buildCodexCommand(args: string[]): string {
  return formatShellCommand(["codex", ...args]);
}

function publishCodexEvent(sessionId: string, event: CodexJsonEvent): void {
  const rawType = typeof event.type === "string" && event.type.trim()
    ? event.type.trim()
    : "unknown";
  runtime.publishSessionEvent(sessionId, {
    type: `codex.raw.${rawType}`,
    properties: {
      event,
      eventType: rawType,
    },
  });
}

function publishCodexAppEvent(entry: CodexAppConnectionEntry, notification: Record<string, any>): void {
  const method = typeof notification.method === "string" ? notification.method : "unknown";
  const context = getCodexAppNotificationContext(entry.eventState, notification);
  const normalizedEvents = normalizeCodexAppNotification(entry.eventState, notification);
  const publish = (sessionId: string, event: Record<string, unknown>): void => {
    runtime.publishSessionEvent(sessionId, event);
  };

  if (!isKnownCodexAppNotificationMethod(method) && !entry.unknownMethods.has(method)) {
    entry.unknownMethods.add(method);
    log.warn("Unknown Codex app-server notification", {
      method,
      rootThreadId: entry.threadId,
      sourceThreadId: context.sourceThreadId,
    });
  }

  for (const sessionId of entry.aliases) {
    publish(sessionId, {
      type: `codex.app.${method.replaceAll("/", ".")}`,
      properties: {
        notification,
        odeContext: context,
        protocolKnown: isKnownCodexAppNotificationMethod(method),
      },
    });
    for (const event of normalizedEvents) {
      publish(sessionId, scopeCodexAppEvent(event, sessionId));
    }
  }
}

function scopeCodexAppEvent(event: CodexAppSessionEvent, sessionId: string): CodexAppSessionEvent {
  if (event.type === "question.asked") {
    return { ...event, properties: { ...event.properties, sessionID: sessionId } };
  }
  if (event.type !== "message.part.updated") return event;
  const part = event.properties.part;
  if (!part || typeof part !== "object" || Array.isArray(part)) return event;
  return {
    ...event,
    properties: {
      ...event.properties,
      part: { ...part, sessionID: sessionId },
    },
  };
}

function getOrCreateCodexAppConnection(params: {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
}): CodexAppConnectionEntry {
  const existing = appConnections.get(params.sessionId);
  if (existing) return existing;
  const entry = {} as CodexAppConnectionEntry;
  entry.aliases = new Set([params.sessionId]);
  entry.eventState = createCodexAppEventState();
  entry.unknownMethods = new Set();
  entry.connection = new CodexAppServerConnection(params.cwd, params.env, (notification) => {
    publishCodexAppEvent(entry, notification);
  });
  appConnections.set(params.sessionId, entry);
  return entry;
}

function parseCodexResponse(output: string): {
  text: string;
  threadId?: string;
} {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const messages: string[] = [];
  let threadId: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as CodexJsonEvent;
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string" && event.item.text.trim()) {
          messages.push(event.item.text);
        }
      }
      if (event.type === "error") {
        errorMessage = event.error?.message || "Codex returned an error";
      }
    } catch {
      // ignore non-json lines
    }
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const text = messages.join("\n\n").trim();
  if (!text) {
    throw new Error("Codex returned empty response");
  }

  return { text, threadId };
}

async function sendMessageViaCli(
  channelId: string,
  sessionId: string,
  input: AgentInput,
  workingPath: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): Promise<OpenCodeMessage[]> {
  const sessionKey = `${channelId}:${sessionId}`;
  const entry = runtime.beginRequest(sessionKey);

  try {
    await syncCodexModelsFromCache();
    return await runtime.withSessionLock(sessionKey, async () => {
      const agent = options?.agent;
      const planMode = agent?.trim().toLowerCase() === "plan";
      const parts = buildPromptParts(channelId, input, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const codexPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);
      const model = getCodexModel(options);
      const isNewSession = newSessions.has(sessionId);

      const args = buildCodexCommandArgs({
        sessionId,
        prompt: codexPrompt,
        model,
        planMode,
        isNewSession,
      });

      const command = buildCodexCommand(args);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      log.info("Running Codex CLI", {
        cwd: workingPath,
        command,
        model,
      });

      let latestSessionId = sessionId;
      const output = await runCliJsonCommand<CodexJsonEvent>({
        providerName: "Codex",
        binary: "codex",
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (event) => {
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          latestSessionId = event.thread_id;
        }
        publishCodexEvent(sessionId, event);
        if (latestSessionId !== sessionId) {
          publishCodexEvent(latestSessionId, event);
        }
        },
      });

      const parsed = parseCodexResponse(output);
      const responseSessionId = parsed.threadId || latestSessionId;
      if (responseSessionId && responseSessionId !== sessionId && context?.slack?.threadId) {
        runtime.setSessionEnvironment(responseSessionId, envOverrides);
        setThreadSessionId(channelId, context.slack.threadId, responseSessionId);
      }
      newSessions.delete(sessionId);
      if (responseSessionId) {
        newSessions.delete(responseSessionId);
      }

      return [{ text: parsed.text, messageType: "assistant" }];
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

function buildCodexAppInput(parts: ReturnType<typeof buildPromptParts>, systemPrompt: string): Record<string, unknown>[] {
  const text = buildSystemWrappedPrompt(systemPrompt, buildPromptText(parts));
  const result: Record<string, unknown>[] = [{ type: "text", text, text_elements: [] }];
  for (const part of parts) {
    if (part.type === "image") {
      result.push({ type: "localImage", path: part.path });
    }
  }
  return result;
}

async function sendMessageViaAppServer(
  channelId: string,
  sessionId: string,
  input: AgentInput,
  workingPath: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): Promise<OpenCodeMessage[]> {
  const sessionKey = `${channelId}:${sessionId}`;
  runtime.beginRequest(sessionKey);
  try {
    return await runtime.withSessionLock(sessionKey, async () => {
      await syncCodexModelsFromCache();
      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const entry = getOrCreateCodexAppConnection({ sessionId, cwd: workingPath, env: envOverrides });
      await entry.connection.initialize();

      const agent = options?.agent;
      const planMode = agent?.trim().toLowerCase() === "plan";
      const model = getCodexModel(options);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const isNewSession = newSessions.has(sessionId);
      let nativeThreadId: string;
      if (entry.threadId) {
        nativeThreadId = entry.threadId;
      } else if (isNewSession) {
        nativeThreadId = await entry.connection.startThread({
          cwd: workingPath,
          model,
          systemPrompt,
          planMode,
        });
      } else {
        nativeThreadId = await entry.connection.resumeThread({
          threadId: sessionId,
          cwd: workingPath,
          model,
          systemPrompt,
          planMode,
        });
      }
      entry.threadId = nativeThreadId;
      entry.eventState.rootThreadId = nativeThreadId;
      entry.aliases.add(nativeThreadId);
      appConnections.set(nativeThreadId, entry);
      runtime.setSessionEnvironment(nativeThreadId, envOverrides);

      if (nativeThreadId !== sessionId && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, nativeThreadId);
      }
      newSessions.delete(sessionId);
      newSessions.delete(nativeThreadId);

      const parts = buildPromptParts(channelId, input, { ...options, agent }, context);
      const turn = await entry.connection.runTurn({
        threadId: nativeThreadId,
        input: buildCodexAppInput(parts, ""),
        cwd: workingPath,
        model,
        effort: options?.reasoningEffort,
        planMode,
      });
      const messages = Array.isArray(turn.items)
        ? turn.items
          .filter((item: Record<string, unknown>) => item?.type === "agentMessage" && typeof item.text === "string")
          .map((item: Record<string, unknown>) => String(item.text).trim())
          .filter(Boolean)
        : [];
      const text = messages.join("\n\n").trim();
      if (!text) throw new Error("Codex app-server returned no assistant message");
      return [{ text, messageType: "assistant" }];
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

export async function sendMessage(
  channelId: string,
  sessionId: string,
  input: AgentInput,
  workingPath: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): Promise<OpenCodeMessage[]> {
  try {
    return await sendMessageViaAppServer(
      channelId,
      sessionId,
      input,
      workingPath,
      options,
      context
    );
  } catch (error) {
    if (!(error instanceof CodexAppServerUnavailableError)) throw error;
    log.warn("Codex app-server unavailable; falling back to codex exec", {
      sessionId,
      error: error.message,
    });
    return sendMessageViaCli(channelId, sessionId, input, workingPath, options, context);
  }
}

export const ensureSession = runtime.ensureSession.bind(runtime);

export function publishSessionEvent(sessionId: string, event: unknown): void {
  runtime.publishSessionEvent(sessionId, event);
}

export const subscribeToSession = runtime.subscribeToSession.bind(runtime);

export async function abortSession(sessionId: string): Promise<void> {
  await appConnections.get(sessionId)?.connection.interrupt();
  await runtime.abortSession(sessionId);
}

export async function cancelActiveRequest(
  channelId: string,
  sessionId: string,
  directory?: string
): Promise<boolean> {
  const app = appConnections.get(sessionId);
  if (app) {
    await app.connection.interrupt();
    return true;
  }
  return runtime.cancelActiveRequest(channelId, sessionId);
}

export async function stopServer(): Promise<void> {
  const connections = new Set(Array.from(appConnections.values()).map((entry) => entry.connection));
  for (const connection of connections) connection.close();
  appConnections.clear();
  await runtime.stopServer();
}

export const startServer = syncCodexModelsFromCache;

export async function replyToQuestion(params: {
  requestId: string;
  answers: Array<Array<string>>;
}): Promise<void> {
  if (!replyToCodexAppServerQuestion(params.requestId, params.answers)) {
    throw new Error(`Unknown Codex question request: ${params.requestId}`);
  }
}
