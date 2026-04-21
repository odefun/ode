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

type QwenJsonRecord = {
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
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
};

const runtime = new CliAgentRuntime("Qwen");
/** See note in claude/client.ts — FIFO-bounded so abandoned sessions don't leak. */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "qwen",
  providerName: "Qwen",
  runtime,
  newSessions,
});

function resolveQwenBinary(): string {
  if (typeof Bun !== "undefined") {
    if (Bun.which("qwen")) return "qwen";
    if (Bun.which("qwen-code")) return "qwen-code";
  }
  return "qwen";
}

export function buildQwenCommandArgs(params: {
  sessionId: string;
  isNewSession: boolean;
  prompt: string;
  approvalMode?: "plan";
}): string[] {
  const args = [
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
  if (params.approvalMode === "plan") {
    args.push("--approval-mode", "plan");
  } else {
    args.push("--yolo");
  }
  if (!params.isNewSession) {
    args.push("--resume", params.sessionId);
  }
  args.push("-p", params.prompt);
  return args;
}

export function buildQwenCommand(args: string[]): string {
  return formatShellCommand([resolveQwenBinary(), ...args]);
}

function getRecordSessionId(record: QwenJsonRecord, fallbackSessionId: string): string {
  return typeof record.session_id === "string" ? record.session_id : fallbackSessionId;
}

function publishQwenRecordAsSessionEvents(record: QwenJsonRecord, fallbackSessionId: string): void {
  const sessionId = getRecordSessionId(record, fallbackSessionId);
  const rawType = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : "unknown";
  const eventPayload = {
    type: `qwen.raw.${rawType}`,
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

function parseQwenResponse(output: string): {
  text: string;
  sessionId?: string;
} {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let sessionId: string | undefined;
  let resultText = "";
  let errorMessage: string | undefined;
  const assistantChunks: string[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as QwenJsonRecord;
      if (typeof record.session_id === "string" && record.session_id.trim()) {
        sessionId = record.session_id;
      }
      if (record.type === "assistant") {
        const text = (record.message?.content ?? [])
          .filter((part) => part?.type === "text")
          .map((part) => part.text ?? "")
          .join("")
          .trim();
        if (text) assistantChunks.push(text);
      }
      if (record.type === "result") {
        if (record.is_error) {
          errorMessage = record.error || "Qwen returned an error";
        }
        if (typeof record.result === "string") {
          resultText = record.result.trim();
        }
      }
    } catch {
      // ignore non-json stream lines
    }
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const text = (resultText || assistantChunks.join("\n\n")).trim();
  if (!text) {
    throw new Error("Qwen returned empty response");
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
      const approvalMode = agent?.trim().toLowerCase() === "plan" ? "plan" : undefined;
      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const qwenPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);
      const isNewSession = newSessions.has(sessionId);

      const args = buildQwenCommandArgs({
        sessionId,
        isNewSession,
        prompt: qwenPrompt,
        approvalMode,
      });
      const command = buildQwenCommand(args);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      log.info("Running Qwen CLI", {
        cwd: workingPath,
        command,
        isNewSession,
      });

      let latestSessionId = sessionId;
      const output = await runCliJsonCommand<QwenJsonRecord>({
        providerName: "Qwen",
        binary: resolveQwenBinary(),
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => {
        const recordSessionId = getRecordSessionId(record, sessionId);
        latestSessionId = recordSessionId;
        publishQwenRecordAsSessionEvents(record, sessionId);
        },
      });

      const parsed = parseQwenResponse(output);
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
