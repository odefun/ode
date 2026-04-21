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

type GeminiJsonRecord = {
  type?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  session_id?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  error?: {
    type?: string;
    message?: string;
  };
  result?: string;
  model?: string;
};

const runtime = new CliAgentRuntime("Gemini");
/** See note in claude/client.ts — FIFO-bounded so abandoned sessions don't leak. */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "gemini",
  providerName: "Gemini",
  runtime,
  newSessions,
});

function resolveGeminiBinary(): string {
  if (typeof Bun !== "undefined" && Bun.which("gemini")) return "gemini";
  return "gemini";
}

function resolveGeminiApprovalMode(agent?: string): "plan" | undefined {
  return agent?.trim().toLowerCase() === "plan" ? "plan" : undefined;
}

export function buildGeminiCommandArgs(params: {
  sessionId: string;
  isNewSession: boolean;
  prompt: string;
  approvalMode?: "plan";
}): string[] {
  const args = [
    "-p",
    params.prompt,
    "--output-format",
    "stream-json",
    "--approval-mode",
    params.approvalMode ?? "yolo",
  ];
  if (!params.isNewSession) {
    args.push("--resume", params.sessionId);
  }
  return args;
}

export function buildGeminiCommand(args: string[]): string {
  return formatShellCommand([resolveGeminiBinary(), ...args]);
}

function isPlanModeUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("approval mode \"plan\" is only available")
    || message.includes("experimental.plan is enabled");
}

function getRecordSessionId(record: GeminiJsonRecord, fallbackSessionId: string): string {
  return typeof record.session_id === "string" && record.session_id.trim()
    ? record.session_id
    : fallbackSessionId;
}

function publishGeminiRecordAsSessionEvents(record: GeminiJsonRecord, fallbackSessionId: string): void {
  const sessionId = getRecordSessionId(record, fallbackSessionId);
  const rawType = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : "unknown";
  const eventPayload = {
    type: `gemini.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      role: typeof record.role === "string" ? record.role : undefined,
    },
  };
  runtime.publishSessionEvent(sessionId, eventPayload);
  if (sessionId !== fallbackSessionId) {
    runtime.publishSessionEvent(fallbackSessionId, eventPayload);
  }
}

function parseGeminiResponse(output: string): {
  text: string;
  sessionId?: string;
} {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const assistantChunks: string[] = [];
  let resultText = "";
  let sessionId: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as GeminiJsonRecord;
      if (typeof record.session_id === "string" && record.session_id.trim()) {
        sessionId = record.session_id;
      }

      if (record.type === "error") {
        errorMessage = record.error?.message || "Gemini returned an error";
      }

      if (record.type === "message" && record.role === "assistant" && typeof record.content === "string") {
        assistantChunks.push(record.content);
      }

      if (record.type === "result") {
        if (record.status === "error") {
          errorMessage = record.error?.message || "Gemini returned an error";
        }
        if (typeof record.result === "string" && record.result.trim()) {
          resultText = record.result.trim();
        }
      }
    } catch {
      // ignore non-json lines
    }
  }

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const text = (resultText || assistantChunks.join("")).trim();
  if (!text) {
    throw new Error("Gemini returned empty response");
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
      const approvalMode = resolveGeminiApprovalMode(agent);
      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const geminiPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);
      const isNewSession = newSessions.has(sessionId);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      const run = async (forceApprovalMode?: "plan"): Promise<string> => {
        const args = buildGeminiCommandArgs({
          sessionId,
          isNewSession,
          prompt: geminiPrompt,
          approvalMode: forceApprovalMode,
        });
        const command = buildGeminiCommand(args);
        log.info("Running Gemini CLI", {
          cwd: workingPath,
          command,
          isNewSession,
          approvalMode: forceApprovalMode ?? "yolo",
        });

        return runCliJsonCommand<GeminiJsonRecord>({
          providerName: "Gemini",
          binary: resolveGeminiBinary(),
          args,
          cwd: workingPath,
          env: envOverrides,
          entry,
          onRecord: (record) => {
            publishGeminiRecordAsSessionEvents(record, sessionId);
          },
        });
      };

      let output = "";
      try {
        output = await run(approvalMode);
      } catch (error) {
        if (approvalMode === "plan" && isPlanModeUnavailable(error)) {
          log.warn("Gemini plan approval mode unavailable; retrying with default approval mode", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          output = await run(undefined);
        } else {
          throw error;
        }
      }

      const parsed = parseGeminiResponse(output);
      const responseSessionId = parsed.sessionId;
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
