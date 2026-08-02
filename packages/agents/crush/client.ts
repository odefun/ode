import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { setThreadSessionId } from "@/config/local/sessions";
import { BoundedSet, log } from "@/utils";
import { buildPromptParts, buildPromptText, buildSystemPrompt, buildSystemWrappedPrompt } from "../shared";
import {
  CliAgentRuntime,
  formatShellCommand,
  noopStartServer,
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

export type CrushRawRecord = {
  type?: "start" | "progress" | "log" | "message" | "text";
  text?: string;
  model?: string;
  sessionId?: string;
  level?: string;
  prompt?: string;
  elapsedMs?: number;
  messageId?: string;
  role?: string;
  provider?: string;
  parts?: unknown[];
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number | null;
};

const runtime = new CliAgentRuntime("Crush");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const CRUSH_RECORD_TYPES = ["start", "progress", "log", "message", "text"];

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "crush",
  providerName: "Crush",
  runtime,
  newSessions,
});

function resolveCrushBinary(): string {
  if (typeof Bun !== "undefined" && Bun.which("crush")) return "crush";
  return "crush";
}

function resolveCrushModel(model?: OpenCodeOptions["model"]): string | undefined {
  if (!model?.modelID) return undefined;
  const providerID = model.providerID?.trim();
  if (providerID && providerID !== "crush") return `${providerID}/${model.modelID}`;
  if (model.modelID.includes("/")) return model.modelID;
  return `chainbot/${model.modelID}`;
}

export function buildCrushCommandArgs(params: {
  sessionId: string;
  prompt: string;
  model?: OpenCodeOptions["model"];
  isNewSession?: boolean;
}): string[] {
  const args = [
    "run",
    "--verbose",
  ];
  const model = resolveCrushModel(params.model);
  if (model) args.push("--model", model);
  if (!params.isNewSession) {
    args.push("--session", params.sessionId);
  }
  args.push(params.prompt);
  return args;
}

export function buildCrushCommand(args: string[]): string {
  return formatShellCommand([resolveCrushBinary(), ...args]);
}

export function parseCrushResponse(output: string): string {
  return output.trim() || "Crush completed without textual output.";
}

function compactSingleLine(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function parseCrushLogLine(line: string): CrushRawRecord {
  const trimmed = line.trim();
  const match = trimmed.match(/^(INFO|WARN|ERRO|DEBUG)\s+(.+)$/);
  const body = match?.[2] ?? trimmed;
  const sessionMatch = body.match(/\bsession_id=([^\s]+)/);
  return {
    type: "log",
    level: match?.[1]?.toLowerCase(),
    text: body,
    sessionId: sessionMatch?.[1],
  };
}

type CrushMessageRow = {
  id: string;
  session_id: string;
  role: string;
  parts: string;
  model: string | null;
  provider: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

function readCrushMessages(params: {
  dbPath: string;
  sessionId: string;
  seenMessageVersions: Map<string, string>;
  onRecord: (record: CrushRawRecord) => void;
}): void {
  const { dbPath, sessionId, seenMessageVersions, onRecord } = params;
  if (!existsSync(dbPath)) return;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query(`
      SELECT id, session_id, role, parts, model, provider, created_at, updated_at, finished_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(sessionId) as CrushMessageRow[];

    for (const row of rows) {
      const version = `${row.updated_at}:${row.finished_at ?? ""}:${row.parts.length}`;
      if (seenMessageVersions.get(row.id) === version) continue;
      let parts: unknown[] = [];
      try {
        const parsed = JSON.parse(row.parts) as unknown;
        parts = Array.isArray(parsed) ? parsed : [];
      } catch {
        parts = [];
      }
      seenMessageVersions.set(row.id, version);
      onRecord({
        type: "message",
        sessionId: row.session_id,
        messageId: row.id,
        role: row.role,
        parts,
        model: row.model ?? undefined,
        provider: row.provider ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        finishedAt: row.finished_at,
      });
    }
  } catch {
    // The database may be locked while Crush writes; retry on the next poll.
  } finally {
    db?.close();
  }
}

async function runCrushCommand(params: {
  binary: string;
  args: string[];
  cwd: string;
  env: SessionEnvironment;
  entry: ReturnType<CliAgentRuntime["beginRequest"]>;
  timeoutMs: number;
  initialSessionId?: string;
  onRecord: (record: CrushRawRecord) => void;
}): Promise<string> {
  const { binary, args, cwd, env, entry, timeoutMs, initialSessionId, onRecord } = params;
  const dbPath = path.join(cwd, ".crush", "crush.db");
  const seenMessageVersions = new Map<string, string>();
  let crushSessionId = initialSessionId;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        CRUSH_DISABLE_METRICS: "1",
        CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: "1",
        DO_NOT_TRACK: "1",
        PWD: cwd,
      },
      signal: entry.controller.signal,
    });
    entry.process = child;
    child.stdin?.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBuffer = "";

    const flushLogLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const record = parseCrushLogLine(trimmed);
      if (record.sessionId) {
        crushSessionId = record.sessionId;
      }
      onRecord(record);
    };

    const pollMessages = () => {
      if (!crushSessionId) return;
      readCrushMessages({
        dbPath,
        sessionId: crushSessionId,
        seenMessageVersions,
        onRecord,
      });
    };
    const pollTimer = setInterval(pollMessages, 1000);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Crush CLI timed out"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));

    child.stderr?.on("data", (chunk) => {
      const bufferChunk = Buffer.from(chunk);
      stderrChunks.push(bufferChunk);
      stderrBuffer += bufferChunk.toString("utf-8");
      while (true) {
        const newlineIndex = stderrBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stderrBuffer.slice(0, newlineIndex);
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
        flushLogLine(line);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      clearInterval(pollTimer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      clearInterval(pollTimer);
      if (stderrBuffer.trim()) {
        flushLogLine(stderrBuffer);
      }
      pollMessages();
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      log.info("Crush CLI completed", {
        code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      if (code !== 0) {
        reject(new Error(stderr || `Crush CLI exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function publishCrushRecord(record: CrushRawRecord, sessionId: string): void {
  const rawType = typeof record.type === "string" && record.type.trim() ? record.type.trim() : "text";
  runtime.publishSessionEvent(sessionId, {
    type: `crush.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      ...inspectCliProtocol({
        providerName: "Crush",
        recordType: rawType,
        knownRecordTypes: CRUSH_RECORD_TYPES,
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
      const isNewSession = newSessions.has(sessionId);
      const parts = buildPromptParts(channelId, input, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const crushPrompt = buildSystemWrappedPrompt(buildSystemPrompt(context?.slack), prompt);
      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const args = buildCrushCommandArgs({
        sessionId,
        prompt: crushPrompt,
        model: options?.model,
        isNewSession,
      });
      const model = resolveCrushModel(options?.model);
      const startedAtMs = Date.now();

      runtime.publishSessionEvent(sessionId, {
        type: "crush.raw.start",
        properties: {
          record: {
            type: "start",
            model,
            prompt: compactSingleLine(prompt),
          } satisfies CrushRawRecord,
          recordType: "start",
        },
      });
      const progressTimer = setInterval(() => {
        publishCrushRecord({
          type: "progress",
          model,
          prompt: compactSingleLine(prompt),
          elapsedMs: Date.now() - startedAtMs,
        }, sessionId);
      }, 15_000);

      log.info("Running Crush CLI", {
        cwd: workingPath,
        command: buildCrushCommand(args),
      });

      let text: string;
      try {
        const output = await runCrushCommand({
          binary: resolveCrushBinary(),
          args,
          cwd: workingPath,
          env: envOverrides,
          entry,
          timeoutMs: 600_000,
          initialSessionId: isNewSession ? undefined : sessionId,
          onRecord: (record) => publishCrushRecord(record, sessionId),
        });
        text = parseCrushResponse(output);
      } finally {
        clearInterval(progressTimer);
      }
      publishCrushRecord({ type: "text", text }, sessionId);

      if (newSessions.has(sessionId) && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, sessionId);
      }
      newSessions.delete(sessionId);

      return [{ text, messageType: "assistant" }];
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
