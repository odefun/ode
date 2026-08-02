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

type CodeBuddyContentBlock = {
  type?: string;
  text?: string;
};

export type CodeBuddyJsonRecord = {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  errors?: string[];
  message?: {
    role?: string;
    content?: CodeBuddyContentBlock[] | string;
    model?: string;
  };
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
};

const runtime = new CliAgentRuntime("CodeBuddy");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const CODEBUDDY_RECORD_TYPES = ["system", "assistant", "user", "stream_event", "result"];
const DEFAULT_CODEBUDDY_MODEL = "gpt-5.1";

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "codebuddy",
  providerName: "CodeBuddy",
  runtime,
  newSessions,
});

function resolveCodeBuddyBinary(): string {
  if (typeof Bun !== "undefined") {
    if (Bun.which("codebuddy")) return "codebuddy";
    if (Bun.which("cbc")) return "cbc";
  }
  return "codebuddy";
}

function resolveCodeBuddyModel(model?: OpenCodeOptions["model"]): string {
  if (!model?.modelID) return DEFAULT_CODEBUDDY_MODEL;
  const providerID = model.providerID?.trim();
  if (providerID && providerID !== "codebuddy") return `${providerID}/${model.modelID}`;
  return model.modelID;
}

export function buildCodeBuddyCommandArgs(params: {
  sessionId: string;
  prompt: string;
  agent?: string;
  model?: OpenCodeOptions["model"];
}): string[] {
  return [
    "--print",
    params.prompt,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--session-id",
    params.sessionId,
    "--model",
    resolveCodeBuddyModel(params.model),
    "--permission-mode",
    params.agent?.trim().toLowerCase() === "plan" ? "plan" : "dontAsk",
    "--max-turns",
    "20",
    "--setting-sources",
    "user",
  ];
}

export function buildCodeBuddyCommand(args: string[]): string {
  return formatShellCommand([resolveCodeBuddyBinary(), ...args]);
}

function contentToText(content: CodeBuddyContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function parseCodeBuddyResponse(output: string): string {
  let lastAssistantText = "";
  let resultText = "";
  let errorText = "";
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = JSON.parse(trimmed) as CodeBuddyJsonRecord;
      if (record.type === "assistant") {
        const text = contentToText(record.message?.content);
        if (text) lastAssistantText = text;
      }
      if (record.type === "result") {
        if (typeof record.result === "string" && record.result.trim()) {
          resultText = record.result.trim();
        }
        if (record.is_error) {
          errorText = record.errors?.join("\n") || resultText || "CodeBuddy reported an error";
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  if (errorText) throw new Error(errorText);
  return resultText || lastAssistantText || output.trim() || "CodeBuddy completed without textual output.";
}

function publishCodeBuddyRecord(record: CodeBuddyJsonRecord, fallbackSessionId: string): void {
  const sessionId = typeof record.session_id === "string" && record.session_id.trim()
    ? record.session_id
    : fallbackSessionId;
  const rawType = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "unknown";
  const streamEventType = typeof record.event?.type === "string" ? record.event.type : undefined;
  const payload = {
    type: `codebuddy.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      streamEventType,
      ...inspectCliProtocol({
        providerName: "CodeBuddy",
        recordType: rawType,
        streamEventType,
        knownRecordTypes: CODEBUDDY_RECORD_TYPES,
        anthropicStyleStream: true,
      }),
    },
  };
  runtime.publishSessionEvent(sessionId, payload);
  if (sessionId !== fallbackSessionId) {
    runtime.publishSessionEvent(fallbackSessionId, payload);
  }
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
      const parts = buildPromptParts(channelId, input, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const codeBuddyPrompt = buildSystemWrappedPrompt(buildSystemPrompt(context?.slack), prompt);
      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const args = buildCodeBuddyCommandArgs({
        sessionId,
        prompt: codeBuddyPrompt,
        agent,
        model: options?.model,
      });

      log.info("Running CodeBuddy CLI", {
        cwd: workingPath,
        command: buildCodeBuddyCommand(args),
      });

      const output = await runCliJsonCommand<CodeBuddyJsonRecord>({
        providerName: "CodeBuddy",
        binary: resolveCodeBuddyBinary(),
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => publishCodeBuddyRecord(record, sessionId),
      });

      if (newSessions.has(sessionId) && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, sessionId);
      }
      newSessions.delete(sessionId);

      return [{ text: parseCodeBuddyResponse(output), messageType: "assistant" }];
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

export const ensureSession = runtime.ensureSession.bind(runtime);
export const subscribeToSession = runtime.subscribeToSession.bind(runtime);

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
    providerId: "codebuddy",
    providerName: "CodeBuddy",
    launch: { command: resolveCodeBuddyBinary(), args: ["--acp"] },
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

export async function abortSession(sessionId: string): Promise<void> {
  await cancelAcpSession("codebuddy", sessionId).catch(() => false);
  await runtime.abortSession(sessionId);
}

export async function cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
  const [acpCancelled, cliCancelled] = await Promise.all([
    cancelAcpSession("codebuddy", sessionId).catch(() => false),
    runtime.cancelActiveRequest(channelId, sessionId),
  ]);
  return acpCancelled || cliCancelled;
}

export function stopServer(): void {
  stopAcpProvider("codebuddy");
  runtime.stopServer();
}
export const startServer = noopStartServer;
