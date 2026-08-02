import { setThreadSessionId, updateThreadSessionBinding } from "@/config/local/sessions";
import { LEGACY_AGENT_CAPABILITIES } from "@/shared/agent-protocol";
import { BoundedSet, log } from "@/utils";
import { buildPromptParts, buildPromptText, buildSystemPrompt, buildSystemWrappedPrompt } from "../shared";
import {
  CliAgentRuntime,
  formatShellCommand,
  noopStartServer,
  runCliJsonCommand,
  type SessionEnvironment as RuntimeSessionEnvironment,
} from "../runtime/base";
import { createCliThreadSessionManager } from "../runtime/cli-session";
import { inspectCliProtocol } from "../runtime/protocol-drift";
import {
  cancelAcpSession,
  prependSystemPrompt,
  sendMessageViaAcp,
  stopAcpProvider,
} from "../runtime/acp-client";
import type {
  AgentInput,
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
} from "../types";

export type SessionEnvironment = RuntimeSessionEnvironment;

type KiloToolCall = {
  id?: string;
  function?: {
    name?: string;
    arguments?: unknown;
  };
};

type KiloContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
};

type KiloJsonRecord = {
  type?: string;
  role?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  message?: {
    content?: KiloContentBlock[];
  };
  content?: KiloContentBlock[] | string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    id?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    };
  };
  tool_calls?: KiloToolCall[];
  tool_call_id?: string;
  result?: string;
  output?: string;
  text?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
  sessionId?: string;
  sessionID?: string;
};

const runtime = new CliAgentRuntime("Kilo");
/** See note in claude/client.ts — FIFO-bounded so abandoned sessions don't leak. */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const KILO_RECORD_TYPES = [
  "text",
  "tool_use",
  "step_start",
  "step_finish",
  "assistant",
  "user",
  "tool",
  "result",
  "stream_event",
];
const kiloSessionPrefix = "ses_";

function resolveKiloBinary(): string {
  if (typeof Bun !== "undefined") {
    if (Bun.which("kilo")) return "kilo";
  }
  return "kilo";
}

function buildKiloSessionId(): string {
  return `${kiloSessionPrefix}${crypto.randomUUID()}`;
}

function isValidKiloSessionId(value: string): boolean {
  return value.startsWith("ses");
}

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "kilo",
  providerName: "Kilo",
  runtime,
  newSessions,
  sessionIdFactory: buildKiloSessionId,
  validateSessionId: isValidKiloSessionId,
});

function buildModelArg(model?: OpenCodeOptions["model"]): string | undefined {
  if (!model?.modelID) return undefined;
  const providerID = model.providerID?.trim() || "openai";
  return `${providerID}/${model.modelID}`;
}

export function buildKiloCommandArgs(params: {
  sessionId: string;
  prompt: string;
  agent?: string;
  model?: OpenCodeOptions["model"];
  isNewSession?: boolean;
}): string[] {
  const args = [
    "run",
    "--format",
    "json",
  ];
  if (!params.isNewSession) {
    args.push("--session", params.sessionId);
  }
  if (params.agent?.trim()) {
    args.push("--agent", params.agent.trim());
  }
  const modelArg = buildModelArg(params.model);
  if (modelArg) {
    args.push("--model", modelArg);
  }
  args.push(params.prompt);
  return args;
}

export function buildKiloCommand(args: string[]): string {
  return formatShellCommand([resolveKiloBinary(), ...args]);
}

function sanitizeKiloOutput(text: string): string {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "")
    .replace(/[ \t]+$/gm, "");
}

function getRecordSessionId(record: KiloJsonRecord, fallbackSessionId: string): string {
  if (typeof record.session_id === "string") return record.session_id;
  if (typeof record.sessionId === "string") return record.sessionId;
  if (typeof record.sessionID === "string") return record.sessionID;
  return fallbackSessionId;
}

function publishKiloRecordAsSessionEvents(record: KiloJsonRecord, fallbackSessionId: string): void {
  const sessionId = getRecordSessionId(record, fallbackSessionId);
  const rawType = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : typeof record.role === "string" && record.role.trim()
      ? record.role.trim()
      : "unknown";
  const streamEventType = typeof record.event?.type === "string" ? record.event.type : undefined;
  const eventPayload = {
    type: `kilo.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      streamEventType,
      ...inspectCliProtocol({
        providerName: "Kilo",
        recordType: rawType,
        streamEventType,
        knownRecordTypes: KILO_RECORD_TYPES,
        anthropicStyleStream: true,
      }),
    },
  };
  runtime.publishSessionEvent(sessionId, eventPayload);
  if (sessionId !== fallbackSessionId) {
    runtime.publishSessionEvent(fallbackSessionId, eventPayload);
  }
}

function contentBlocks(record: KiloJsonRecord): KiloContentBlock[] {
  if (Array.isArray(record.message?.content)) return record.message?.content ?? [];
  if (Array.isArray(record.content)) return record.content as KiloContentBlock[];
  return [];
}

function textFromContent(record: KiloJsonRecord): string {
  if (typeof record.part?.text === "string" && record.part.text.trim()) return record.part.text.trim();
  if (typeof record.result === "string" && record.result.trim()) return record.result.trim();
  if (typeof record.text === "string" && record.text.trim()) return record.text.trim();
  if (typeof record.output === "string" && record.output.trim()) return record.output.trim();
  if (typeof record.content === "string" && record.content.trim()) return record.content.trim();
  const blocks = contentBlocks(record);
  const text = blocks
    .map((block) => {
      if (typeof block.text === "string") return block.text;
      if (typeof block.thinking === "string") return block.thinking;
      if (typeof block.content === "string") return block.content;
      return "";
    })
    .filter((value) => value.trim().length > 0)
    .join("");
  return text.trim();
}

function publishKiloTextUpdate(sessionId: string, text: string): void {
  if (!text.trim()) return;
  runtime.publishSessionEvent(sessionId, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "kilo-text",
        type: "text",
        text,
      },
    },
  });
}

function publishKiloToolUpdate(params: {
  sessionId: string;
  id: string;
  tool: string;
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}): void {
  runtime.publishSessionEvent(params.sessionId, {
    type: "message.part.updated",
    properties: {
      part: {
        id: params.id,
        type: "tool",
        tool: params.tool,
        state: {
          status: params.status,
          ...(params.input ? { input: params.input } : {}),
          ...(params.output ? { output: params.output } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
      },
    },
  });
}

function extractToolUses(record: KiloJsonRecord): Array<{ id: string; name: string; input?: Record<string, unknown> }> {
  const blocks = contentBlocks(record);
  const blockTools = blocks
    .filter((block) => block?.type === "tool_use")
    .map((block) => ({
      id: block.id || `kilo-tool-${Date.now()}`,
      name: block.name || "tool",
      input: block.input,
    }));
  const callTools = Array.isArray(record.tool_calls)
    ? record.tool_calls.map((call) => ({
      id: call.id || `kilo-tool-${Date.now()}`,
      name: call.function?.name || "tool",
      input: typeof call.function?.arguments === "object" && call.function?.arguments
        ? call.function?.arguments as Record<string, unknown>
        : undefined,
    }))
    : [];
  return [...blockTools, ...callTools];
}

function extractToolResults(record: KiloJsonRecord): Array<{ id: string; output?: string; error?: string; isError: boolean }> {
  const blocks = contentBlocks(record);
  return blocks
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      id: block.tool_use_id || record.tool_call_id || "",
      output: typeof block.content === "string" ? block.content : undefined,
      error: block.is_error ? (typeof block.content === "string" ? block.content : "Tool failed") : undefined,
      isError: block.is_error === true,
    }))
    .filter((result) => result.id.length > 0);
}

export function extractKiloFinalResponse(output: string): string {
  const cleaned = sanitizeKiloOutput(output);
  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const assistantMessages: string[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as KiloJsonRecord;
      const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
      const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
      if (role === "assistant" || type === "assistant" || type === "result" || type === "text") {
        const text = textFromContent(record);
        if (text) assistantMessages.push(text);
      }
    } catch {
      // ignore non-json lines
    }
  }

  const text = assistantMessages.join("\n\n").trim();
  return text || cleaned.trim();
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
    return await runtime.withSessionLock(sessionKey, async () => {
      const agent = options?.agent;
      const isNewSession = newSessions.has(sessionId);
      const parts = buildPromptParts(channelId, input, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const kiloPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);

      const args = buildKiloCommandArgs({
        sessionId,
        prompt: kiloPrompt,
        agent,
        model: options?.model,
        isNewSession,
      });
      const command = buildKiloCommand(args);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      runtime.publishSessionEvent(sessionId, {
        type: "session.status",
        properties: {
          status: {
            type: "busy",
          },
        },
      });

      log.info("Running Kilo CLI", {
        cwd: workingPath,
        command,
      });

      let observedSessionId: string | null = null;
      const output = await runCliJsonCommand<KiloJsonRecord>({
        providerName: "Kilo",
        binary: resolveKiloBinary(),
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => {
        publishKiloRecordAsSessionEvents(record, sessionId);
        const recordSessionId = getRecordSessionId(record, sessionId);
        if (recordSessionId && recordSessionId !== sessionId) {
          observedSessionId = recordSessionId;
        }

        const role = typeof record.role === "string" ? record.role.trim().toLowerCase() : "";
        const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
        if (role === "assistant" || type === "assistant" || type === "text") {
          const text = textFromContent(record);
          if (text) {
            publishKiloTextUpdate(recordSessionId, text);
          }
          for (const tool of extractToolUses(record)) {
            publishKiloToolUpdate({
              sessionId: recordSessionId,
              id: tool.id,
              tool: tool.name,
              status: "running",
              input: tool.input,
            });
          }
        }

        if (role === "tool" || type === "tool") {
          for (const result of extractToolResults(record)) {
            publishKiloToolUpdate({
              sessionId: recordSessionId,
              id: result.id,
              tool: "tool",
              status: result.isError ? "error" : "completed",
              output: result.output,
              error: result.error,
            });
          }
        }
        },
      });

      if (observedSessionId && observedSessionId !== sessionId && context?.slack?.threadId) {
        runtime.setSessionEnvironment(observedSessionId, envOverrides);
        setThreadSessionId(channelId, context.slack.threadId, observedSessionId);
      }

      const text = extractKiloFinalResponse(output);
      if (!text) {
        log.warn("Kilo returned empty output after successful CLI exit", { sessionId });
        const fallbackText = "Kilo completed without textual output.";
        publishKiloTextUpdate(observedSessionId ?? sessionId, fallbackText);
        runtime.publishSessionEvent(observedSessionId ?? sessionId, {
          type: "session.status",
          properties: {
            status: {
              type: "idle",
            },
          },
        });
        newSessions.delete(sessionId);
        if (observedSessionId) {
          newSessions.delete(observedSessionId);
        }
        return [{ text: fallbackText, messageType: "assistant" }];
      }

      publishKiloTextUpdate(observedSessionId ?? sessionId, text);
      runtime.publishSessionEvent(observedSessionId ?? sessionId, {
        type: "session.status",
        properties: {
          status: {
            type: "idle",
          },
        },
      });
      newSessions.delete(sessionId);
      if (observedSessionId) {
        newSessions.delete(observedSessionId);
      }
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
  const agent = options?.agent;
  const promptParts = buildPromptParts(channelId, input, { ...options, agent }, context);
  const systemPrompt = buildSystemPrompt(context?.slack);
  const environment = runtime.getSessionEnvironment(sessionId);

  return sendMessageViaAcp({
    providerId: "kilo",
    providerName: "Kilo",
    launch: { command: resolveKiloBinary(), args: ["acp"] },
    channelId,
    sessionId,
    isNewSession: newSessions.has(sessionId),
    workingPath,
    environment,
    parts: prependSystemPrompt(promptParts, systemPrompt),
    options,
    publisher: runtime,
    onNativeSessionId: (nativeSessionId) => {
      runtime.setSessionEnvironment(nativeSessionId, environment);
      newSessions.delete(sessionId);
      newSessions.delete(nativeSessionId);
      if (nativeSessionId !== sessionId && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, nativeSessionId);
      }
    },
    onNegotiated: ({ protocolVersion, capabilities }) => {
      if (context?.slack?.threadId) {
        updateThreadSessionBinding(channelId, context.slack.threadId, {
          transport: "acp",
          protocolVersion,
          capabilities,
        });
      }
    },
    onFallback: () => {
      if (context?.slack?.threadId) {
        updateThreadSessionBinding(channelId, context.slack.threadId, {
          transport: "cli-json",
          protocolVersion: undefined,
          capabilities: LEGACY_AGENT_CAPABILITIES,
        });
      }
    },
    fallback: () => sendMessageViaCli(channelId, sessionId, input, workingPath, options, context),
  });
}

export const ensureSession = runtime.ensureSession.bind(runtime);

export const subscribeToSession = runtime.subscribeToSession.bind(runtime);

export async function abortSession(sessionId: string): Promise<void> {
  await cancelAcpSession("kilo", sessionId).catch(() => false);
  await runtime.abortSession(sessionId);
}

export async function cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
  const [acpCancelled, cliCancelled] = await Promise.all([
    cancelAcpSession("kilo", sessionId).catch(() => false),
    runtime.cancelActiveRequest(channelId, sessionId),
  ]);
  return acpCancelled || cliCancelled;
}

export function stopServer(): void {
  stopAcpProvider("kilo");
  runtime.stopServer();
}
export const startServer = noopStartServer;
