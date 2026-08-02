import { setThreadSessionId } from "@/config/local/sessions";
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
import type {
  AgentInput,
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
} from "../types";

export type SessionEnvironment = RuntimeSessionEnvironment;

type PiContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
};

export type PiJsonRecord = {
  type?: string;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: {
    content?: Array<{ type?: string; text?: string }> | string;
    isError?: boolean;
  };
  message?: {
    role?: string;
    content?: Array<PiContentBlock> | string;
    model?: string;
    provider?: string;
  };
  assistantMessageEvent?: {
    type?: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
  };
  messages?: Array<{
    role?: string;
    content?: Array<PiContentBlock> | string;
  }>;
};

const runtime = new CliAgentRuntime("Pi");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const PI_RECORD_TYPES = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_update",
  "message_end",
  "turn_end",
  "agent_end",
  "session",
  "tool_execution_start",
  "tool_execution_end",
  "agent_settled",
];
const DEFAULT_PI_MODEL = "claude-sonnet-4-5-20250929";

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "pi",
  providerName: "Pi",
  runtime,
  newSessions,
});

function resolvePiBinary(): string {
  if (typeof Bun !== "undefined" && Bun.which("pi")) return "pi";
  return "pi";
}

function resolvePiModel(model?: OpenCodeOptions["model"]): string {
  if (!model?.modelID) return DEFAULT_PI_MODEL;
  const providerID = model.providerID?.trim();
  if (providerID && providerID !== "pi") return `${providerID}/${model.modelID}`;
  return model.modelID;
}

export function buildPiCommandArgs(params: {
  sessionId: string;
  prompt: string;
  agent?: string;
  model?: OpenCodeOptions["model"];
}): string[] {
  const args = [
    "--mode",
    "json",
    "--print",
    "--session-id",
    params.sessionId,
    "--approve",
  ];
  const model = resolvePiModel(params.model);
  if (model.includes("/")) {
    args.push("--model", model);
  } else {
    args.push("--provider", "anthropic", "--model", model);
  }
  if (params.agent?.trim().toLowerCase() === "plan") {
    args.push("--tools", "read,grep,find,ls");
  }
  args.push(params.prompt);
  return args;
}

export function buildPiCommand(args: string[]): string {
  return formatShellCommand([resolvePiBinary(), ...args]);
}

function contentToText(content: PiContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function parsePiResponse(output: string): string {
  let lastAssistantText = "";
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = JSON.parse(trimmed) as PiJsonRecord;
      const messageText = record.message?.role === "assistant"
        ? contentToText(record.message.content)
        : "";
      if (messageText) lastAssistantText = messageText;
      if (record.type === "turn_end") {
        const text = contentToText(record.message?.content);
        if (text) lastAssistantText = text;
      }
      if (record.type === "agent_end" && Array.isArray(record.messages)) {
        for (const message of record.messages) {
          if (message.role !== "assistant") continue;
          const text = contentToText(message.content);
          if (text) lastAssistantText = text;
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return lastAssistantText || output.trim() || "Pi completed without textual output.";
}

function publishPiRecord(record: PiJsonRecord, fallbackSessionId: string): void {
  const rawType = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "unknown";
  runtime.publishSessionEvent(fallbackSessionId, {
    type: `pi.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      ...inspectCliProtocol({
        providerName: "Pi",
        recordType: rawType,
        knownRecordTypes: PI_RECORD_TYPES,
      }),
    },
  });
}

export async function sendMessage(
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
      const piPrompt = buildSystemWrappedPrompt(buildSystemPrompt(context?.slack), prompt);
      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const args = buildPiCommandArgs({
        sessionId,
        prompt: piPrompt,
        agent,
        model: options?.model,
      });

      log.info("Running Pi CLI", {
        cwd: workingPath,
        command: buildPiCommand(args),
      });

      const output = await runCliJsonCommand<PiJsonRecord>({
        providerName: "Pi",
        binary: resolvePiBinary(),
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => publishPiRecord(record, sessionId),
      });

      if (newSessions.has(sessionId) && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, sessionId);
      }
      newSessions.delete(sessionId);

      return [{ text: parsePiResponse(output), messageType: "assistant" }];
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

export const ensureSession = runtime.ensureSession.bind(runtime);
export const subscribeToSession = runtime.subscribeToSession.bind(runtime);
export const abortSession = runtime.abortSession.bind(runtime);
export const cancelActiveRequest = runtime.cancelActiveRequest.bind(runtime);
export const stopServer = runtime.stopServer.bind(runtime);
export const startServer = noopStartServer;
