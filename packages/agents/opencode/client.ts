import {
  createSessionInstance,
  getSessionClient,
  ensureValidSession,
  getSessionEnvironment,
  getSessionServerUrl,
  type SessionEnvironment,
} from "./server";
import {
  setThreadSessionId,
  updateActiveRequest,
} from "@/config/local/sessions";
import { getChannelModel, isLocalMode } from "@/config";
import { log } from "@/utils";
import { buildPromptParts, buildSystemPrompt } from "../shared";
import { ServerAgentRuntime, formatShellCommand } from "../runtime/base";
import { getOrCreateThreadSession } from "../runtime/thread-session";
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
} from "../types";

const runtime = new ServerAgentRuntime();

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

/**
 * Shape of the OpenCode assistant-message `error` field. Matches the SDK's
 * `ApiError | ProviderAuthError | UnknownError | MessageOutputLengthError |
 * MessageAbortedError` union (see @opencode-ai/sdk types).
 */
type OpenCodeInfoError = {
  name?: string;
  data?: {
    message?: string;
    statusCode?: number;
    providerID?: string;
    responseBody?: string;
    [key: string]: unknown;
  };
};

export function extractInfoError(data: Record<string, unknown>): OpenCodeInfoError | null {
  const info = data.info as Record<string, unknown> | undefined;
  const error = info?.error;
  if (!error || typeof error !== "object") return null;
  return error as OpenCodeInfoError;
}

export function formatInfoError(error: OpenCodeInfoError): string {
  const name = error.name ?? "UnknownError";
  const message = error.data?.message;
  const statusCode = error.data?.statusCode;
  const statusSuffix = statusCode ? ` (status ${statusCode})` : "";
  if (message) {
    return `OpenCode ${name}${statusSuffix}: ${message}`;
  }
  return `OpenCode ${name}${statusSuffix}`;
}

/**
 * `MessageAbortedError` is produced by the OpenCode server when a run is
 * cancelled (e.g. the user typed `stop` and the kernel called
 * `session.abort`). It is a normal, non-fatal outcome: the kernel's stop
 * path at packages/core/kernel/request-run.ts is responsible for publishing
 * the final text. Treat it as a soft failure so we don't race ahead of the
 * stop handling with a failed-run status.
 */
export function isAbortError(error: OpenCodeInfoError): boolean {
  return error.name === "MessageAbortedError";
}

/**
 * Detect the Anthropic "image dimensions exceed max allowed size" error. A
 * single oversized screenshot stuck in session history would otherwise break
 * every subsequent turn in the thread, because the full history is replayed
 * on every prompt. See thread `C0AUUDD0VDX:1776966674.077239` for the
 * original report.
 */
export function isOversizedImageError(error: OpenCodeInfoError): boolean {
  if (error.name !== "APIError") return false;
  const haystacks: string[] = [];
  if (typeof error.data?.message === "string") haystacks.push(error.data.message);
  if (typeof error.data?.responseBody === "string") haystacks.push(error.data.responseBody);
  const blob = haystacks.join(" ").toLowerCase();
  if (!blob) return false;
  return (
    blob.includes("image dimensions exceed") ||
    blob.includes("2000 pixels") ||
    blob.includes("many-image requests")
  );
}

async function tryRevertOversizedImageTurn(
  client: Awaited<ReturnType<typeof getSessionClient>>,
  sessionId: string,
  data: Record<string, unknown>,
  directory: string
): Promise<void> {
  try {
    const info = data.info as { id?: string; parentID?: string } | undefined;
    // Prefer reverting to the parent user message so the failed assistant
    // turn plus its oversized-image tool output are removed; fall back to
    // the assistant message id if parent is missing.
    const messageID = info?.parentID ?? info?.id;
    if (!messageID) {
      log.warn("Oversized-image error detected but could not locate message id to revert", {
        sessionId,
      });
      return;
    }
    log.warn("Reverting session turn that triggered oversized-image APIError", {
      sessionId,
      messageID,
    });
    await client.session.revert({
      sessionID: sessionId,
      messageID,
      directory: directory || undefined,
    });
  } catch (err) {
    // Revert is best-effort: if it fails we still want the original API
    // error to surface to the user rather than swallowing it here.
    log.warn("Failed to revert session after oversized-image APIError", {
      sessionId,
      error: String(err),
    });
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

export async function getOrCreateSession(
  channelId: string,
  threadId: string,
  workingPath: string,
  env: SessionEnvironment = {}
): Promise<OpenCodeSessionInfo> {
  return getOrCreateThreadSession({
    channelId,
    threadId,
    providerId: "opencode",
    workingPath,
    env,
    createSession,
    getSessionEnvironment,
    setSessionEnvironment: () => {
      // OpenCode session environment is managed by server runtime registration.
    },
    onEnvironmentChanged: () => {
      log.debug("Session environment changed; creating new session", { channelId, threadId, workingPath });
    },
    onCreatingSession: () => {
      log.debug("Creating new session for thread", { channelId, threadId, workingPath });
    },
  });
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
    log.debug("Updating stored sessionId", {
      channelId,
      threadId: context.slack.threadId,
      oldSessionId: sessionId,
      newSessionId: validSessionId,
    });
    setThreadSessionId(channelId, context.slack.threadId, validSessionId);
    // Also rebind the in-flight activeRequest so the kernel event watcher
    // (which filters events by request.sessionId) keeps receiving events
    // after the server-side session was rotated. Without this the run
    // would appear stuck: events carry the new id and get dropped,
    // step-finish/stop is never observed, progress UI never updates.
    updateActiveRequest(channelId, context.slack.threadId, {
      sessionId: validSessionId,
    });
  }

  const activeSessionId = validSessionId;
  const sessionKey = `${channelId}:${activeSessionId}`;
  runtime.beginRequest(sessionKey);

  try {
    return await runtime.withSessionLock(sessionKey, async () => {
      const client = await getSessionClient(activeSessionId);

      const agent = options?.agent;
      const model = options?.model ?? (isLocalMode()
        ? (() => {
            const configured = getChannelModel(channelId);
            if (!configured) {
              throw new Error("Model missing for channel in ~/.config/ode/ode.json");
            }
            const parts = configured.split("/", 2);
            const providerRaw = parts.length > 1 ? (parts[0] ?? "openai") : "openai";
            const modelRaw = parts.length > 1 ? (parts[1] ?? "") : configured;
            const providerID = providerRaw.trim().toLowerCase().replace(/\s+/g, "-");
            const modelID = modelRaw.trim();
            if (!modelID) {
              throw new Error("Invalid model for channel in ~/.config/ode/ode.json");
            }
            return { providerID, modelID };
          })()
        : undefined);

      // Build message parts
      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);

      // Build system prompt with Slack context
      const system = buildSystemPrompt(context?.slack);
      const payload = { directory: workingPath, parts, agent, model, system };
      // const payload = { directory: workingPath, parts, agent, model };
      const serverUrl = getSessionServerUrl(activeSessionId);
      const command = serverUrl
        ? buildOpenCodeCommand(serverUrl, activeSessionId, payload)
        : null;

      log.debug("Sending message via SDK", { sessionId: activeSessionId, agent, model, command });

      const result = await client.session.prompt({
        sessionID: activeSessionId,
        ...payload,
      });

      log.debug("OpenCode SDK response received", {
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

      // The SDK returns 200 OK even when the underlying provider call failed:
      // the failure is stashed on `data.info.error` (ApiError, ProviderAuthError, ...)
      // and the assistant message ends up with zero text parts. Without this check
      // the kernel would silently fall back to "_Done_" (see
      // packages/core/kernel/request-run.ts:847) and hide the real failure from
      // the user.
      const data = result.data as Record<string, unknown>;
      const infoError = extractInfoError(data);
      if (infoError && !isAbortError(infoError)) {
        // If the error was caused by an oversized image in the session
        // history, try to revert the poisoned turn so subsequent messages
        // in this thread are not permanently broken. Fire-and-forget: we
        // do NOT await here, so a slow/hung revert cannot delay the user
        // from seeing the original API failure.
        if (isOversizedImageError(infoError)) {
          void tryRevertOversizedImageTurn(client, activeSessionId, data, workingPath);
        }
        throw new Error(formatInfoError(infoError));
      }
      // MessageAbortedError falls through: the assistant message is empty
      // because the user stopped the run. The kernel's stop path handles
      // this gracefully, so surfacing it as a thrown error here would just
      // race the stop handler and flip the run into a "failed" state.

      // Extract text from response in a few known shapes.
      const messages: OpenCodeMessage[] = [];

      const pushText = (value: unknown): void => {
        if (typeof value !== "string") return;
        const text = value.trim();
        if (!text) return;
        messages.push({
          text,
          messageType: "assistant",
        });
      };

      const responseParts = Array.isArray(data.parts) ? data.parts : [];
      for (const part of responseParts) {
        if (!part || typeof part !== "object") continue;
        const record = part as Record<string, unknown>;
        if (record.type === "text") {
          pushText(record.text);
        }
      }

      if (messages.length === 0 && Array.isArray(data.messages)) {
        for (const entry of data.messages) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          pushText(record.text);
          if (Array.isArray(record.parts)) {
            for (const part of record.parts) {
              if (!part || typeof part !== "object") continue;
              const partRecord = part as Record<string, unknown>;
              if (partRecord.type === "text") {
                pushText(partRecord.text);
              }
            }
          }
        }
      }

      if (messages.length === 0) {
        pushText(data.text);
        pushText(data.output_text);
      }

      log.debug("OpenCode completed", { messageCount: messages.length });
      return messages;
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

export interface ProgressEvent {
  directory?: string;
  payload?: {
    type?: string;
    properties?: Record<string, unknown>;
  };
}

function statusFromSessionStatus(status: unknown): string {
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

function statusFromPart(part: Record<string, unknown>): string | null {
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

function getSessionIdFromProperties(props: Record<string, unknown> | undefined): string | undefined {
  if (!props) return undefined;
  if (typeof props.sessionID === "string") return props.sessionID;
  if (typeof (props as { sessionId?: unknown }).sessionId === "string") {
    return (props as { sessionId: string }).sessionId;
  }
  return undefined;
}

const SIMPLE_STATUS_BY_TYPE: Record<string, string> = {
  "command.executed": "Command executed",
  "session.updated": "Updating session",
  "message.updated": "Updating message",
  question: "Asking question",
  "question.asked": "Awaiting response",
  "scheduler.run": "Running maintenance",
  "snapshot.cleanup": "Running maintenance",
};

export function statusFromEvent(event: ProgressEvent, sessionId: string): string | null {
  const payload = event.payload;
  if (!payload?.type) return null;

  const properties = payload.properties as Record<string, unknown> | undefined;
  const eventSessionId = getSessionIdFromProperties(properties);

  switch (payload.type) {
    case "session.status": {
      const sessionProperties = payload.properties as
        | { sessionID?: string; status?: unknown }
        | undefined;
      if (sessionProperties?.sessionID !== sessionId) return null;
      return statusFromSessionStatus(sessionProperties?.status);
    }
    case "session.error": {
      const errorProperties = payload.properties as { sessionID?: string } | undefined;
      if (!errorProperties?.sessionID || errorProperties.sessionID === sessionId) {
        return "Error";
      }
      return null;
    }
    case "message.part.updated": {
      const partProperties = payload.properties as
        | { part?: Record<string, unknown> }
        | undefined;
      const part = partProperties?.part;
      const partSessionId = part && typeof part.sessionID === "string" ? part.sessionID : undefined;
      if (!part || partSessionId !== sessionId) return null;
      const status = statusFromPart(part);
      return status;
    }
  }

  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  if (payload.type === "session.summary") {
    const title = typeof properties?.title === "string" ? properties.title : undefined;
    return title ? `Summarizing: ${title}` : "Summarizing session";
  }

  const simple = SIMPLE_STATUS_BY_TYPE[payload.type];
  return simple ?? null;
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
  const cancelled = await runtime.cancelActiveRequest(channelId, sessionId);
  if (cancelled) {
    await abortSession(sessionId, directory);
    return true;
  }
  return false;
}
