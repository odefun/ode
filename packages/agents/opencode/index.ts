import {
  createSessionInstance,
  getSessionClient,
  ensureValidSession,
  getSessionEnvironment,
  getSessionServerUrl,
  startServer,
  stopServer,
  isServerReady,
  getAnyServerUrl,
  ensureSession,
  ensureValidSession as ensureOpenCodeValidSession,
  stopAllSessions,
  subscribeToSession,
  type EventHandler,
  type SessionEnvironment,
} from "./server";
import { setThreadSessionId } from "@/config/local/settings";
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

class OpenCodeMessageProcessor {
  private readonly runtime = new ServerAgentRuntime();

  startServer(): Promise<void> {
    return startServer();
  }

  stopServer(): Promise<void> {
    return Promise.resolve(stopServer());
  }

  ensureSession(sessionId: string): Promise<void> {
    return ensureSession(sessionId);
  }

  subscribeToSession(sessionId: string, handler: (event: unknown) => void): () => void {
    return subscribeToSession(sessionId, handler);
  }

  async createSession(workingPath: string, env?: SessionEnvironment): Promise<string> {
    const { client, register } = await createSessionInstance(env);

    const result = await client.session.create({
      directory: workingPath,
    });

    if (!result.data?.id) {
      log.error("Session creation failed", {
        hasData: !!result.data,
        data: result.data,
        error: (result as { error?: unknown }).error,
      });
      throw new Error("Failed to create session: no ID returned");
    }

    const sessionId = result.data.id;
    register(sessionId, env ?? {});
    return sessionId;
  }

  async getOrCreateSession(
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
      createSession: this.createSession.bind(this),
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

  async sendMessage(
    channelId: string,
    sessionId: string,
    message: string,
    workingPath: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ): Promise<OpenCodeMessage[]> {
    const validSessionId = await ensureValidSession(sessionId, workingPath);

    if (validSessionId !== sessionId && context?.slack?.threadId) {
      log.debug("Updating stored sessionId", {
        channelId,
        threadId: context.slack.threadId,
        oldSessionId: sessionId,
        newSessionId: validSessionId,
      });
      setThreadSessionId(channelId, context.slack.threadId, validSessionId);
    }

    const activeSessionId = validSessionId;
    const sessionKey = `${channelId}:${activeSessionId}`;
    this.runtime.beginRequest(sessionKey);

    try {
      return await this.runtime.withSessionLock(sessionKey, async () => {
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

        const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
        const system = buildSystemPrompt(context?.slack);
        const payload = { directory: workingPath, parts, agent, model, system };
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

        const messages: OpenCodeMessage[] = [];
        const data = result.data as Record<string, unknown>;

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
      this.runtime.endRequest(sessionKey);
    }
  }

  async abortSession(sessionId: string, directory?: string): Promise<void> {
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

  async cancelActiveRequest(
    channelId: string,
    sessionId: string,
    directory?: string
  ): Promise<boolean> {
    const cancelled = await this.runtime.cancelActiveRequest(channelId, sessionId);
    if (cancelled) {
      await this.abortSession(sessionId, directory);
      return true;
    }
    return false;
  }
}

export const openCodeAgent = new OpenCodeMessageProcessor();

export const createSession = openCodeAgent.createSession.bind(openCodeAgent);
export const getOrCreateSession = openCodeAgent.getOrCreateSession.bind(openCodeAgent);
export const sendMessage = openCodeAgent.sendMessage.bind(openCodeAgent);
export const abortSession = openCodeAgent.abortSession.bind(openCodeAgent);
export const cancelActiveRequest = openCodeAgent.cancelActiveRequest.bind(openCodeAgent);

export {
  startServer,
  stopServer,
  isServerReady,
  createSessionInstance,
  getSessionClient,
  getAnyServerUrl,
  ensureSession,
  ensureOpenCodeValidSession as ensureValidSession,
  stopAllSessions,
  subscribeToSession,
  type EventHandler,
};

export type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
};
