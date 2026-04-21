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
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
} from "../types";

export type SessionEnvironment = RuntimeSessionEnvironment;

type GooseJsonRecord = {
  type?: string;
  event?: {
    type?: string;
    index?: number;
    content_block?: Record<string, unknown>;
    delta?: Record<string, unknown>;
  };
  message?: {
    content?: Array<{ type?: string; text?: string }>;
  };
  role?: string;
  content?: string;
  text?: string;
  result?: string;
  output?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
  sessionId?: string;
  sessionID?: string;
};

const runtime = new CliAgentRuntime("Goose");
/** See note in claude/client.ts — FIFO-bounded so abandoned sessions don't leak. */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "goose",
  providerName: "Goose",
  runtime,
  newSessions,
});

function resolveGooseBinary(): string {
  if (typeof Bun !== "undefined" && Bun.which("goose")) return "goose";
  return "goose";
}

export function buildGooseCommandArgs(params: {
  sessionId: string;
  isNewSession: boolean;
  prompt: string;
}): string[] {
  const args = [
    "run",
    "--output-format",
    "stream-json",
    "--name",
    params.sessionId,
  ];
  if (!params.isNewSession) {
    args.push("--resume");
  }
  args.push("-t", params.prompt);
  return args;
}

export function buildGooseCommand(args: string[]): string {
  return formatShellCommand([resolveGooseBinary(), ...args]);
}

function getRecordSessionId(record: GooseJsonRecord, fallbackSessionId: string): string {
  if (typeof record.session_id === "string") return record.session_id;
  if (typeof record.sessionId === "string") return record.sessionId;
  if (typeof record.sessionID === "string") return record.sessionID;
  return fallbackSessionId;
}

function publishGooseRecordAsSessionEvents(record: GooseJsonRecord, fallbackSessionId: string): void {
  const sessionId = getRecordSessionId(record, fallbackSessionId);
  const rawType = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : typeof record.role === "string" && record.role.trim()
      ? record.role.trim()
      : "unknown";
  const eventPayload = {
    type: `goose.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      streamEventType: typeof record.event?.type === "string" ? record.event.type : undefined,
    },
  };
  runtime.publishSessionEvent(sessionId, eventPayload);
  if (sessionId !== fallbackSessionId) {
    runtime.publishSessionEvent(fallbackSessionId, eventPayload);
  }
}

function textFromRecord(record: GooseJsonRecord): string {
  if (typeof record.result === "string" && record.result.trim()) return record.result;
  if (typeof record.output === "string" && record.output.trim()) return record.output;
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  if (typeof record.content === "string" && record.content.trim()) return record.content;
  const content = record.message?.content ?? [];
  const joined = content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  return joined.trim() ? joined : "";
}

function isPlaceholderResult(text: string): boolean {
  return /^\?+$/.test(text.trim());
}

function stitchAssistantChunks(chunks: string[]): string {
  let stitched = "";
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (!stitched) {
      stitched = chunk;
      continue;
    }
    if (chunk.startsWith(stitched)) {
      stitched = chunk;
      continue;
    }
    if (stitched.endsWith(chunk)) {
      continue;
    }
    stitched += chunk;
  }
  return stitched;
}

export function parseGooseResponse(output: string): {
  text: string;
  sessionId?: string;
} {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let resultText = "";
  const assistantChunks: string[] = [];
  const plainChunks: string[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as GooseJsonRecord;
      const recordSessionId = getRecordSessionId(record, "").trim();
      if (recordSessionId) {
        sessionId = recordSessionId;
      }

      const recordText = textFromRecord(record);
      if (recordText) {
        assistantChunks.push(recordText);
      }

      if (record.is_error) {
        errorMessage = record.error || "Goose returned an error";
      }

      const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
      if ((type === "result" || type.endsWith("completed")) && recordText) {
        resultText = recordText;
      }
    } catch {
      plainChunks.push(line);
    }
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const assistantText = stitchAssistantChunks(assistantChunks);
  const finalResultText = isPlaceholderResult(resultText) ? "" : resultText;
  const text = (finalResultText || assistantText || plainChunks.join("\n")).trim();
  if (!text) {
    throw new Error("Goose returned empty response");
  }

  return { text, sessionId };
}

export async function sendMessage(
  channelId: string,
  sessionId: string,
  message: string,
  workingPath: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): Promise<OpenCodeMessage[]> {
  const sessionKey = `${channelId}:${sessionId}`;
  const entry = runtime.beginRequest(sessionKey);

  try {
    return await runtime.withSessionLock(sessionKey, async () => {
      const agent = options?.agent;
      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const goosePrompt = buildSystemWrappedPrompt(systemPrompt, prompt);
      const isNewSession = newSessions.has(sessionId);

      const args = buildGooseCommandArgs({
        sessionId,
        isNewSession,
        prompt: goosePrompt,
      });
      const command = buildGooseCommand(args);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      log.info("Running Goose CLI", {
        cwd: workingPath,
        command,
        isNewSession,
      });

      let latestSessionId = sessionId;
      const output = await runCliJsonCommand<GooseJsonRecord>({
        providerName: "Goose",
        binary: resolveGooseBinary(),
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => {
        const recordSessionId = getRecordSessionId(record, sessionId);
        latestSessionId = recordSessionId;
        publishGooseRecordAsSessionEvents(record, sessionId);
        },
      });

      const parsed = parseGooseResponse(output);
      const responseSessionId = parsed.sessionId || latestSessionId;
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

export const ensureSession = runtime.ensureSession.bind(runtime);

export const subscribeToSession = runtime.subscribeToSession.bind(runtime);

export const abortSession = runtime.abortSession.bind(runtime);

export const cancelActiveRequest = runtime.cancelActiveRequest.bind(runtime);

export const stopServer = runtime.stopServer.bind(runtime);
export const startServer = noopStartServer;
