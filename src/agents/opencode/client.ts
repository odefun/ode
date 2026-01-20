import {
  createSessionInstance,
  getSessionClient,
  ensureValidSession,
  getSessionEnvironment,
  getSessionServerUrl,
  type SessionEnvironment,
} from "./server";
import {
  getOpenCodeSession,
  setOpenCodeSession,
  getChannelSettings,
} from "../../storage/settings";
import { log } from "../../logger";
import { buildPromptParts, buildSlackSystemPrompt } from "../shared";
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeProgressHandler,
  OpenCodeSessionInfo,
} from "../types";

const activeRequests = new Map<string, AbortController>();
const sessionLocks = new Map<string, Promise<unknown>>();

function formatShellCommand(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0) return "''";
      if (/[^\w@%+=:,./-]/.test(arg)) {
        const escaped = arg.replace(/'/g, `"'"'"`);
        return `'${escaped}'`;
      }
      return arg;
    })
    .join(" ");
}

export function buildOpenCodeCommand(
  url: string,
  sessionId: string,
  payload: Record<string, unknown>
): string {
  const args = [
    "curl",
    "-s",
    "-X",
    "POST",
    `${url}/session/${sessionId}/prompt`,
    "-H",
    "Content-Type: application/json",
    "--data-raw",
    JSON.stringify(payload),
  ];
  return formatShellCommand(args);
}

async function withSessionLock<T>(
  sessionKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const existing = sessionLocks.get(sessionKey);
  if (existing) {
    await existing.catch(() => { });
  }

  const promise = fn();
  sessionLocks.set(sessionKey, promise);

  try {
    return await promise;
  } finally {
    sessionLocks.delete(sessionKey);
  }
}

export async function createSession(
  workingPath: string,
  env?: SessionEnvironment
): Promise<string> {
  // Create a new OpenCode instance for this session
  const { client, register } = await createSessionInstance(env);

  const result = await client.session.create({
    directory: workingPath,
  });

  if (!result.data?.id) {
    log.error("Session creation failed", {
      hasData: !!result.data,
      data: result.data,
      error: (result as any).error,
    });
    throw new Error("Failed to create session: no ID returned");
  }

  const sessionId = result.data.id;

  // Register the instance with this sessionId for future use
  register(sessionId, env ?? {});

  return sessionId;
}

function normalizeSessionEnvironment(env?: SessionEnvironment | null): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join("\n");
}

export async function getOrCreateSession(
  channelId: string,
  threadId: string,
  workingPath: string,
  env: SessionEnvironment = {}
): Promise<OpenCodeSessionInfo> {
  const existingSession = getOpenCodeSession(channelId, threadId);
  if (existingSession) {
    const existingEnv = normalizeSessionEnvironment(getSessionEnvironment(existingSession));
    const desiredEnv = normalizeSessionEnvironment(env);
    if (existingEnv !== desiredEnv) {
      log.info("Session environment changed; creating new session", { channelId, threadId, workingPath });
      const sessionId = await createSession(workingPath, env);
      setOpenCodeSession(channelId, threadId, sessionId);
      return { sessionId, created: true };
    }
    return { sessionId: existingSession, created: false };
  }

  log.info("Creating new session for thread", { channelId, threadId, workingPath });
  const sessionId = await createSession(workingPath, env);
  setOpenCodeSession(channelId, threadId, sessionId);
  return { sessionId, created: true };
}


export async function sendMessage(
  channelId: string,
  sessionId: string,
  message: string,
  workingPath: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): Promise<OpenCodeMessage[]> {
  // Ensure we have a valid session in the OpenCode instance
  const validSessionId = await ensureValidSession(sessionId, workingPath);

  // If sessionId changed, update storage
  if (validSessionId !== sessionId && context?.slack?.threadId) {
    log.info("Updating stored sessionId", {
      channelId,
      threadId: context.slack.threadId,
      oldSessionId: sessionId,
      newSessionId: validSessionId,
    });
    setOpenCodeSession(channelId, context.slack.threadId, validSessionId);
  }

  const activeSessionId = validSessionId;
  const sessionKey = `${channelId}:${activeSessionId}`;

  const existingController = activeRequests.get(sessionKey);
  if (existingController) {
    existingController.abort();
  }

  const controller = new AbortController();
  activeRequests.set(sessionKey, controller);

  try {
    return await withSessionLock(sessionKey, async () => {
      const client = await getSessionClient(activeSessionId);

      // Get channel overrides
      const channelSettings = getChannelSettings(channelId);
      const overrides = channelSettings.agentOverrides;

      // Determine agent and model
      const agent = overrides?.agent || options?.agent;
      const model =
        overrides?.provider && overrides?.model
          ? { providerID: overrides.provider, modelID: overrides.model }
          : { providerID: 'openai', modelID: 'gpt-5.2-codex' };

      // Build message parts
      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);

      // Build system prompt with Slack context
      const system = buildSlackSystemPrompt(context?.slack);
      const payload = { directory: workingPath, parts, agent, model, system };
      // const payload = { directory: workingPath, parts, agent, model };
      const serverUrl = getSessionServerUrl(activeSessionId);
      const command = serverUrl
        ? buildOpenCodeCommand(serverUrl, activeSessionId, payload)
        : null;

      log.info("Sending message via SDK", { sessionId: activeSessionId, agent, model, command });

      const result = await client.session.prompt({
        sessionID: activeSessionId,
        ...payload,
      });

      log.info("OpenCode SDK response received", {
        hasData: !!result.data,
        dataKeys: result.data ? Object.keys(result.data) : [],
        error: result.error,
      });

      if (result.error) {
        throw new Error(`OpenCode error: ${result.error}`);
      }

      if (!result.data) {
        throw new Error("OpenCode returned empty response");
      }

      // Extract text from response parts
      const messages: OpenCodeMessage[] = [];
      const responseParts = result.data.parts || [];

      for (const part of responseParts) {
        if (part.type === "text" && part.text) {
          messages.push({
            text: part.text,
            messageType: "assistant",
          });
        }
      }

      log.info("OpenCode completed", { messageCount: messages.length });
      return messages;
    });
  } finally {
    activeRequests.delete(sessionKey);
  }
}

export interface ProgressEvent {
  directory?: string;
  payload?: {
    type?: string;
    properties?: Record<string, unknown>;
  };
}

function formatProgressStatus(status: string): string {
  return status;
}

export function statusFromSessionStatus(status: unknown): string {
  if (!status || typeof status !== "object") return "Working";
  const data = status as {
    type?: string;
    attempt?: number;
    message?: string;
    next?: number;
  };
  switch (data.type) {
    case "busy":
      return "Working";
    case "retry": {
      const base = data.message ? `Retrying: ${data.message}` : "Retrying";
      const seconds =
        typeof data.next === "number"
          ? Math.max(0, Math.ceil((data.next - Date.now()) / 1000))
          : undefined;
      return seconds !== undefined ? `${base} in ${seconds}s` : base;
    }
    case "idle":
      return "Waiting";
    default:
      return "Working";
  }
}

function formatToolDetail(part: Record<string, unknown>): string | null {
  const tool = typeof part.tool === "string" ? part.tool : undefined;
  const state = part.state as { input?: Record<string, unknown> } | undefined;
  const input = state?.input ?? {};

  const path = typeof input.path === "string" ? input.path : undefined;
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const url = typeof (input as { url?: unknown }).url === "string"
    ? (input as { url?: string }).url
    : undefined;

  switch (tool) {
    case "glob":
      return pattern
        ? `Glob "${pattern}"${path ? ` in ${path}` : ""}`
        : "Glob";
    case "grep":
      return pattern
        ? `Grep "${pattern}"${path ? ` in ${path}` : ""}`
        : "Grep";
    case "read":
      return filePath ? `Read ${filePath}` : "Read";
    case "list":
      return path ? `List ${path}` : "List";
    case "webfetch":
      return url ? `WebFetch ${url}` : "WebFetch";
    case "bash":
    case "shell":
    case "command":
      return command ? `$ ${command}` : "Shell";
    case "write":
      return filePath ? `Write ${filePath}` : "Write";
    case "edit":
      return filePath ? `Edit ${filePath}` : "Edit";
    default:
      return null;
  }
}

export function statusFromPart(part: Record<string, unknown>): string | null {
  const type = part.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "reasoning":
      return "Thinking";
    case "text":
      return "Drafting response";
    case "step-start":
      return "Starting step";
    case "step-finish":
      return "Finishing step";
    case "compaction":
      return "Compacting context";
    case "snapshot":
      return "Capturing snapshot";
    case "patch":
      return "Applying changes";
    case "retry":
      return "Retrying";
    case "agent": {
      const name = typeof part.name === "string" ? part.name : undefined;
      return name ? `Switching agent: ${name}` : "Switching agent";
    }
    case "subtask": {
      const detail =
        typeof part.description === "string"
          ? part.description
          : typeof part.prompt === "string"
            ? part.prompt
            : undefined;
      return detail ? `Running subtask: ${detail}` : "Running subtask";
    }
    case "tool": {
      const state = part.state as
        | { status?: string; title?: string; input?: { command?: string; description?: string } }
        | undefined;
      const toolTitle =
        typeof state?.title === "string"
          ? state.title
          : typeof part.tool === "string"
            ? part.tool
            : undefined;
      const detail = formatToolDetail(part);
      const toolLabel = toolTitle ? ` ${toolTitle}` : "";
      const status = state?.status;
      const prefix =
        status === "running"
          ? "Running tool"
          : status === "pending"
            ? "Preparing tool"
            : status === "completed"
              ? "Finished tool"
              : status === "error"
                ? "Tool failed"
                : toolTitle
                  ? "Running tool"
                  : "Running tool";
      if (detail) {
        return `${prefix}: ${detail}`;
      }
      return `${prefix}${toolLabel}`;
    }
    case "file": {
      const filename =
        typeof part.filename === "string"
          ? part.filename
          : typeof part.url === "string"
            ? part.url
            : undefined;
      return filename ? `Preparing file: ${filename}` : "Preparing file";
    }
    default:
      return null;
  }
}

export function statusFromEvent(event: ProgressEvent, sessionId: string): string | null {
  const payload = event.payload;
  if (!payload?.type) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  const eventSessionId =
    typeof properties?.sessionID === "string"
      ? properties.sessionID
      : typeof (properties as { sessionId?: unknown } | undefined)?.sessionId === "string"
        ? (properties as { sessionId?: string }).sessionId
        : undefined;

  if (payload.type === "session.status") {
    const sessionProperties = payload.properties as
      | { sessionID?: string; status?: unknown }
      | undefined;
    if (sessionProperties?.sessionID === sessionId) {
      return formatProgressStatus(statusFromSessionStatus(sessionProperties?.status));
    }
    return null;
  }

  if (payload.type === "session.error") {
    const properties = payload.properties as { sessionID?: string } | undefined;
    if (!properties?.sessionID || properties.sessionID === sessionId) {
      return "Error";
    }
    return null;
  }

  if (payload.type === "message.part.updated") {
    const partProperties = payload.properties as
      | { part?: Record<string, unknown> }
      | undefined;
    const part = partProperties?.part;
    const partSessionId =
      part && typeof part.sessionID === "string" ? part.sessionID : undefined;
    if (!part || partSessionId !== sessionId) return null;
    const status = statusFromPart(part);
    return status ? formatProgressStatus(status) : null;
  }

  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  switch (payload.type) {
    case "command.executed":
      return formatProgressStatus("Command executed");
    case "session.updated":
      return formatProgressStatus("Updating session");
    case "session.summary": {
      const title = typeof properties?.title === "string" ? properties.title : undefined;
      return formatProgressStatus(title ? `Summarizing: ${title}` : "Summarizing session");
    }
    case "message.updated":
      return formatProgressStatus("Updating message");
    case "question":
      return formatProgressStatus("Asking question");
    case "question.asked":
      return formatProgressStatus("Awaiting response");
    case "scheduler.run":
    case "snapshot.cleanup":
      return formatProgressStatus("Running maintenance");
    default:
      return null;
  }

  return null;
}

export function watchSessionProgress(
  sessionId: string,
  workingPath: string,
  handler: OpenCodeProgressHandler
): () => void {
  let running = true;

  void (async () => {
    try {
      const client = await getSessionClient(sessionId);
      const events = await client.global.event();

      for await (const globalEvent of events.stream) {
        if (!running) break;

        if (process.env.OPENCODE_EVENT_DUMP === "true") {
          log.info("OpenCode event", { sessionId, event: globalEvent });
        }

        const event: ProgressEvent = {
          directory: (globalEvent as any).directory,
          payload: (globalEvent as any).payload ?? globalEvent,
        };

        const status = statusFromEvent(event, sessionId);
        if (status) {
          handler(status);
        }
      }
    } catch (err) {
      if (running) {
        log.warn("OpenCode progress stream error", { error: String(err) });
      }
    }
  })();

  return () => {
    running = false;
  };
}

export async function abortSession(sessionId: string, directory?: string): Promise<void> {
  try {
    const client = await getSessionClient(sessionId);
    await client.session.abort({
      sessionID: sessionId,
      directory,
    });
  } catch (err) {
    log.warn("Failed to abort session", { sessionId, error: String(err) });
  }
}

export async function cancelActiveRequest(
  channelId: string,
  sessionId: string,
  directory?: string
): Promise<boolean> {
  const sessionKey = `${channelId}:${sessionId}`;
  const controller = activeRequests.get(sessionKey);
  if (controller) {
    controller.abort();
    activeRequests.delete(sessionKey);
    await abortSession(sessionId, directory);
    return true;
  }
  return false;
}
