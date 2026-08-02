import { homedir } from "node:os";
import { join } from "node:path";
import { setThreadSessionId, updateThreadSessionBinding } from "@/config/local/sessions";
import { LEGACY_AGENT_CAPABILITIES } from "@/shared/agent-protocol";
import { BoundedSet } from "@/utils";
import { log } from "@/utils";
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

type KimiJsonRecord = {
  role?: string;
  content?: string | { type?: string; text?: string; think?: string } | Array<{ type?: string; text?: string; think?: string }>;
  session_id?: string;
  sessionId?: string;
  sessionID?: string;
};

const runtime = new CliAgentRuntime("Kimi");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const KIMI_RECORD_TYPES = ["assistant", "tool", "user", "system"];
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "kimi",
  providerName: "Kimi",
  runtime,
  newSessions,
});

const KIMI_PLAN_SYSTEM_PROMPT = [
  "PLAN MODE REQUIREMENT:",
  "- This turn is planning-only.",
  "- Do not modify files.",
  "- Do not execute shell commands.",
  "- Return an implementation plan and risk notes.",
].join("\n");

export function buildKimiSystemPrompt(baseSystemPrompt: string, agent?: string): string {
  if (agent?.trim().toLowerCase() !== "plan") {
    return baseSystemPrompt;
  }
  return `${baseSystemPrompt}\n\n${KIMI_PLAN_SYSTEM_PROMPT}`;
}

export function buildKimiCommandArgs(params: {
  sessionId: string;
  workingPath: string;
  prompt: string;
  isNewSession?: boolean;
}): string[] {
  const args = [
    "--output-format",
    "stream-json",
  ];
  if (!params.isNewSession) {
    args.push("--session", params.sessionId);
  }
  args.push("-p", params.prompt);
  return args;
}

export function buildKimiCommand(args: string[]): string {
  return formatShellCommand(["kimi", ...args]);
}

function publishKimiEvent(sessionId: string, record: KimiJsonRecord): void {
  const role = typeof record.role === "string" && record.role.trim() ? record.role.trim() : "unknown";
  runtime.publishSessionEvent(sessionId, {
    type: `kimi.raw.${role}`,
    properties: {
      record,
      role,
      recordType: role,
      ...inspectCliProtocol({
        providerName: "Kimi",
        recordType: role,
        knownRecordTypes: KIMI_RECORD_TYPES,
      }),
    },
  });
}

function contentToText(content: KimiJsonRecord["content"]): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return [content.text, content.think].filter((value): value is string => typeof value === "string").join("\n");
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.think === "string") return part.think;
      return "";
    })
    .join("");
}

export function parseKimiResponse(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const assistantMessages: string[] = [];
  const fallbackMessages: string[] = [];
  const rawTextLines: string[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as KimiJsonRecord;
      const text = contentToText(record.content).trim();
      if (!text) continue;
      if (record.role === "assistant") {
        assistantMessages.push(text);
      } else {
        fallbackMessages.push(text);
      }
    } catch {
      if (!line.startsWith("{")) {
        rawTextLines.push(line);
      }
    }
  }

  const assistantText = assistantMessages.join("\n\n").trim();
  if (assistantText) return assistantText;

  const fallbackText = fallbackMessages.join("\n\n").trim();
  if (fallbackText) {
    log.warn("Kimi returned no assistant role output; using fallback text", {
      fallbackCount: fallbackMessages.length,
    });
    return fallbackText;
  }

  const rawText = rawTextLines.join("\n").trim();
  if (rawText) {
    log.warn("Kimi returned non-JSON output; using raw fallback text", {
      rawLineCount: rawTextLines.length,
    });
    return rawText;
  }

  log.warn("Kimi returned empty output; emitting placeholder response");
  return "Kimi completed without textual output.";
}

function getKimiRecordSessionId(record: KimiJsonRecord): string | undefined {
  if (typeof record.session_id === "string" && record.session_id.trim()) return record.session_id.trim();
  if (typeof record.sessionId === "string" && record.sessionId.trim()) return record.sessionId.trim();
  if (typeof record.sessionID === "string" && record.sessionID.trim()) return record.sessionID.trim();
  return undefined;
}

function parseKimiSessionId(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i] ?? "") as KimiJsonRecord;
      const sessionId = getKimiRecordSessionId(parsed);
      if (sessionId) return sessionId;
    } catch {
      // ignore non-json lines
    }
  }
  return undefined;
}

async function readLatestKimiSessionIdForWorkDir(workingPath: string, startedAtMs: number): Promise<string | undefined> {
  const indexPath = join(homedir(), ".kimi-code", "session_index.jsonl");
  let text = "";
  try {
    text = await Bun.file(indexPath).text();
  } catch {
    return undefined;
  }

  let latest: { sessionId: string; updatedAtMs: number } | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        sessionId?: unknown;
        workDir?: unknown;
        sessionDir?: unknown;
      };
      if (parsed.workDir !== workingPath || typeof parsed.sessionId !== "string") continue;
      let updatedAtMs = 0;
      if (typeof parsed.sessionDir === "string") {
        try {
          const stateText = await Bun.file(join(parsed.sessionDir, "state.json")).text();
          const state = JSON.parse(stateText) as { updatedAt?: unknown; createdAt?: unknown };
          const timestamp = typeof state.updatedAt === "string" ? state.updatedAt : state.createdAt;
          updatedAtMs = typeof timestamp === "string" ? Date.parse(timestamp) : 0;
        } catch {
          updatedAtMs = 0;
        }
      }
      if (Number.isFinite(updatedAtMs) && updatedAtMs > 0 && updatedAtMs + 5_000 < startedAtMs) {
        continue;
      }
      if (!latest || updatedAtMs >= latest.updatedAtMs) {
        latest = { sessionId: parsed.sessionId, updatedAtMs };
      }
    } catch {
      // ignore malformed lines
    }
  }
  return latest?.sessionId;
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
      const systemPrompt = buildKimiSystemPrompt(buildSystemPrompt(context?.slack), agent);
      const kimiPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);
      const isNewSession = newSessions.has(sessionId);
      const startedAtMs = Date.now();

      const args = buildKimiCommandArgs({
        sessionId,
        workingPath,
        prompt: kimiPrompt,
        isNewSession,
      });
      const command = buildKimiCommand(args);
      const envOverrides = runtime.getSessionEnvironment(sessionId);

      log.info("Running Kimi CLI", {
        cwd: workingPath,
        command,
      });

      const output = await runCliJsonCommand<KimiJsonRecord>({
        providerName: "Kimi",
        binary: "kimi",
        args,
        cwd: workingPath,
        env: envOverrides,
        entry,
        onRecord: (record) => {
          publishKimiEvent(sessionId, record);
        },
      });
      const responseSessionId = parseKimiSessionId(output)
        ?? (isNewSession ? await readLatestKimiSessionIdForWorkDir(workingPath, startedAtMs) : undefined);
      if (responseSessionId && responseSessionId !== sessionId && context?.slack?.threadId) {
        runtime.setSessionEnvironment(responseSessionId, envOverrides);
        setThreadSessionId(channelId, context.slack.threadId, responseSessionId);
      }
      newSessions.delete(sessionId);
      if (responseSessionId) {
        newSessions.delete(responseSessionId);
      }
      const text = parseKimiResponse(output);
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
  const systemPrompt = buildKimiSystemPrompt(buildSystemPrompt(context?.slack), agent);
  const environment = runtime.getSessionEnvironment(sessionId);

  return sendMessageViaAcp({
    providerId: "kimi",
    providerName: "Kimi",
    launch: { command: "kimi", args: ["acp"] },
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
  await cancelAcpSession("kimi", sessionId).catch(() => false);
  await runtime.abortSession(sessionId);
}

export async function cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
  const [acpCancelled, cliCancelled] = await Promise.all([
    cancelAcpSession("kimi", sessionId).catch(() => false),
    runtime.cancelActiveRequest(channelId, sessionId),
  ]);
  return acpCancelled || cliCancelled;
}

export function stopServer(): void {
  stopAcpProvider("kimi");
  runtime.stopServer();
}
export const startServer = noopStartServer;
