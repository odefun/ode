import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
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

export type OpenHandsJsonRecord = {
  type?: string;
  kind?: string;
  source?: string;
  id?: string;
  model?: string;
  prompt?: string;
  elapsedMs?: number;
  llm_message?: {
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }> | string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: unknown;
      };
    }> | null;
  };
  error?: string;
};

const runtime = new CliAgentRuntime("OpenHands");
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const DEFAULT_OPENHANDS_MODEL = "anthropic/claude-sonnet-4-5-20250929";
const OPENHANDS_EVENT_POLL_MS = 1000;
const OPENHANDS_RECORD_TYPES = [
  "start",
  "progress",
  "SystemPromptEvent",
  "ActionEvent",
  "ObservationEvent",
  "MessageEvent",
];

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "openhands",
  providerName: "OpenHands",
  runtime,
  newSessions,
});

function resolveOpenHandsBinary(): string {
  if (typeof Bun !== "undefined" && Bun.which("openhands")) return "openhands";
  return "openhands";
}

function resolveOpenHandsModel(model?: OpenCodeOptions["model"]): string {
  if (!model?.modelID) return DEFAULT_OPENHANDS_MODEL;
  const providerID = model.providerID?.trim();
  if (providerID && providerID !== "openhands") return `${providerID}/${model.modelID}`;
  if (model.modelID.includes("/")) return model.modelID;
  return `anthropic/${model.modelID}`;
}

export function buildOpenHandsCommandArgs(params: {
  prompt: string;
}): string[] {
  return [
    "--headless",
    "--json",
    "--override-with-envs",
    "--exit-without-confirmation",
    "-t",
    params.prompt,
  ];
}

export function buildOpenHandsCommand(args: string[]): string {
  return formatShellCommand([resolveOpenHandsBinary(), ...args]);
}

function extractJsonBlocks(output: string): OpenHandsJsonRecord[] {
  const records: OpenHandsJsonRecord[] = [];
  const marker = "--JSON Event--";
  let index = 0;
  while (index < output.length) {
    const markerIndex = output.indexOf(marker, index);
    if (markerIndex < 0) break;
    let cursor = markerIndex + marker.length;
    while (cursor < output.length && /\s/.test(output[cursor] ?? "")) cursor += 1;
    if (output[cursor] !== "{") {
      index = cursor + 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = cursor;
    for (; end < output.length; end += 1) {
      const char = output[end] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    const jsonText = output.slice(cursor, end).trim();
    try {
      records.push(JSON.parse(jsonText) as OpenHandsJsonRecord);
    } catch {
      // ignore malformed event blocks
    }
    index = end;
  }
  return records;
}

function consumeJsonBlocks(buffer: string): {
  records: OpenHandsJsonRecord[];
  rest: string;
} {
  const records: OpenHandsJsonRecord[] = [];
  const marker = "--JSON Event--";
  let cursor = 0;
  while (cursor < buffer.length) {
    const markerIndex = buffer.indexOf(marker, cursor);
    if (markerIndex < 0) {
      return { records, rest: buffer.slice(Math.max(0, buffer.length - marker.length)) };
    }

    let jsonStart = markerIndex + marker.length;
    while (jsonStart < buffer.length && /\s/.test(buffer[jsonStart] ?? "")) jsonStart += 1;
    if (jsonStart >= buffer.length) {
      return { records, rest: buffer.slice(markerIndex) };
    }
    if (buffer[jsonStart] !== "{") {
      cursor = jsonStart + 1;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = jsonStart;
    let complete = false;
    for (; end < buffer.length; end += 1) {
      const char = buffer[end] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          complete = true;
          break;
        }
      }
    }
    if (!complete) {
      return { records, rest: buffer.slice(markerIndex) };
    }

    try {
      records.push(JSON.parse(buffer.slice(jsonStart, end)) as OpenHandsJsonRecord);
    } catch {
      // ignore malformed event blocks
    }
    cursor = end;
  }
  return { records, rest: "" };
}

function openHandsConversationsRoot(): string {
  return path.join(homedir(), ".openhands", "conversations");
}

async function listConversationDirNames(): Promise<Set<string>> {
  try {
    const entries = await readdir(openHandsConversationsRoot(), { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

function openHandsRecordKey(record: OpenHandsJsonRecord): string | undefined {
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  if (!id) return undefined;
  const kind = typeof record.kind === "string" && record.kind.trim() ? record.kind.trim() : "unknown";
  return `${kind}:${id}`;
}

async function readOpenHandsEventFiles(params: {
  knownConversationDirs: Set<string>;
  seenEventFiles: Set<string>;
  startedAtMs: number;
  onRecord: (record: OpenHandsJsonRecord) => void;
}): Promise<void> {
  const { knownConversationDirs, seenEventFiles, startedAtMs, onRecord } = params;
  let entries;
  try {
    entries = await readdir(openHandsConversationsRoot(), { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (knownConversationDirs.has(entry.name)) continue;
    const conversationDir = path.join(openHandsConversationsRoot(), entry.name);
    try {
      const info = await stat(conversationDir);
      if (info.mtimeMs < startedAtMs - 5000) continue;
    } catch {
      continue;
    }

    const eventsDir = path.join(conversationDir, "events");
    let files;
    try {
      files = await readdir(eventsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const eventFiles = files
      .filter((file) => file.isFile() && /^event-\d+-.+\.json$/.test(file.name))
      .map((file) => file.name)
      .sort();

    for (const fileName of eventFiles) {
      const filePath = path.join(eventsDir, fileName);
      if (seenEventFiles.has(filePath)) continue;
      try {
        const text = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(text) as OpenHandsJsonRecord;
        seenEventFiles.add(filePath);
        onRecord(parsed);
      } catch {
        // The file may still be in the middle of being written; retry on the next poll.
      }
    }
  }
}

async function runOpenHandsCommand(params: {
  binary: string;
  args: string[];
  cwd: string;
  env: SessionEnvironment;
  entry: ReturnType<CliAgentRuntime["beginRequest"]>;
  timeoutMs: number;
  onRecord: (record: OpenHandsJsonRecord) => void;
}): Promise<string> {
  const { binary, args, cwd, env, entry, timeoutMs, onRecord } = params;
  const startedAtMs = Date.now();
  const knownConversationDirs = await listConversationDirNames();
  const seenEventFiles = new Set<string>();
  const seenRecordKeys = new Set<string>();
  const emitRecord = (record: OpenHandsJsonRecord) => {
    const key = openHandsRecordKey(record);
    if (key) {
      if (seenRecordKeys.has(key)) return;
      seenRecordKeys.add(key);
    }
    onRecord(record);
  };

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env, PWD: cwd },
      signal: entry.controller.signal,
    });
    entry.process = child;
    child.stdin?.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let streamBuffer = "";
    let settled = false;

    const flushRecords = () => {
      const consumed = consumeJsonBlocks(streamBuffer);
      streamBuffer = consumed.rest;
      for (const record of consumed.records) {
        emitRecord(record);
      }
    };

    const pollEventFiles = async () => {
      await readOpenHandsEventFiles({
        knownConversationDirs,
        seenEventFiles,
        startedAtMs,
        onRecord: emitRecord,
      });
    };
    const pollTimer = setInterval(() => {
      void pollEventFiles();
    }, OPENHANDS_EVENT_POLL_MS);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenHands CLI timed out"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const bufferChunk = Buffer.from(chunk);
      stdoutChunks.push(bufferChunk);
      streamBuffer += bufferChunk.toString("utf-8");
      flushRecords();
    });

    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      clearInterval(pollTimer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(pollTimer);
      void (async () => {
        await pollEventFiles();
        flushRecords();
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        log.info("OpenHands CLI completed", {
          code,
          stdoutLength: stdout.length,
          stderrLength: stderr.length,
        });
        if (code !== 0) {
          reject(new Error(stderr || `OpenHands CLI exited with code ${code}`));
          return;
        }
        if (stderr) {
          log.warn("OpenHands CLI stderr", { stderr });
        }
        resolve(stdout);
      })().catch((error) => reject(error));
    });
  });
}

function messageText(record: OpenHandsJsonRecord): string {
  const content = record.llm_message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function parseOpenHandsResponse(output: string): {
  text: string;
  records: OpenHandsJsonRecord[];
} {
  const records = extractJsonBlocks(output);
  let lastAgentText = "";
  for (const record of records) {
    if (record.source !== "agent" && record.llm_message?.role !== "assistant") continue;
    const text = messageText(record);
    if (text) lastAgentText = text;
  }
  if (lastAgentText) return { text: lastAgentText, records };

  const summaryMatch = output.match(/Last message sent by the agent:\s*([\s\S]*?)Conversation ID:/);
  const summaryText = summaryMatch?.[1]
    ?.split("\n")
    .map((line) => line.replace(/[│╭╮╰╯─]/g, "").trim())
    .filter(Boolean)
    .filter((line) => line !== "Agent")
    .join("\n")
    .trim();
  return {
    text: summaryText || output.trim() || "OpenHands completed without textual output.",
    records,
  };
}

function publishOpenHandsRecord(record: OpenHandsJsonRecord, fallbackSessionId: string): void {
  const rawType =
    typeof record.kind === "string" && record.kind.trim()
      ? record.kind.trim()
      : typeof record.type === "string" && record.type.trim()
        ? record.type.trim()
        : "unknown";
  runtime.publishSessionEvent(fallbackSessionId, {
    type: `openhands.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      ...inspectCliProtocol({
        providerName: "OpenHands",
        recordType: rawType,
        knownRecordTypes: OPENHANDS_RECORD_TYPES,
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
      const openHandsPrompt = buildSystemWrappedPrompt(buildSystemPrompt(context?.slack), prompt);
      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const args = buildOpenHandsCommandArgs({ prompt: openHandsPrompt });
      const model = resolveOpenHandsModel(options?.model);
      const startedAtMs = Date.now();
      publishOpenHandsRecord({
        type: "start",
        model,
        prompt,
      }, sessionId);
      const progressTimer = setInterval(() => {
        publishOpenHandsRecord({
          type: "progress",
          model,
          prompt,
          elapsedMs: Date.now() - startedAtMs,
        }, sessionId);
      }, 15_000);

      runtime.publishSessionEvent(sessionId, {
        type: "session.status",
        properties: {
          status: { type: "busy" },
        },
      });

      log.info("Running OpenHands CLI", {
        cwd: workingPath,
        command: buildOpenHandsCommand(args),
        model,
      });

      let parsed: ReturnType<typeof parseOpenHandsResponse>;
      try {
        const output = await runOpenHandsCommand({
          binary: resolveOpenHandsBinary(),
          args,
          cwd: workingPath,
          env: {
            OPENHANDS_SUPPRESS_BANNER: "1",
            LLM_MODEL: model,
            ...envOverrides,
          },
          entry,
          timeoutMs: 600_000,
          onRecord: (record) => publishOpenHandsRecord(record, sessionId),
        });
        parsed = parseOpenHandsResponse(output);
      } finally {
        clearInterval(progressTimer);
      }

      if (newSessions.has(sessionId) && context?.slack?.threadId) {
        setThreadSessionId(channelId, context.slack.threadId, sessionId);
      }
      newSessions.delete(sessionId);

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
