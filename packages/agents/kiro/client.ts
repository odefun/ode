import { spawn, type ChildProcess } from "child_process";
import { BoundedSet, log } from "@/utils";
import { buildPromptParts, buildPromptText, buildSystemPrompt, buildSystemWrappedPrompt } from "../shared";
import {
  CliAgentRuntime,
  formatShellCommand,
  noopStartServer,
  type SessionEnvironment as RuntimeSessionEnvironment,
} from "../runtime/base";
import { createCliThreadSessionManager } from "../runtime/cli-session";
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
} from "../types";

export type SessionEnvironment = RuntimeSessionEnvironment;

const runtime = new CliAgentRuntime("Kiro");
/** See note in claude/client.ts — FIFO-bounded so abandoned sessions don't leak. */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "kiro",
  providerName: "Kiro",
  runtime,
  newSessions,
});

const TOOL_MARKER_PATTERN = /\(using tool:\s*([^\)]+)\)/i;
const READ_OPERATION_PATTERN = /Reading file:\s*(.+?),\s*from line\s*(\d+)\s*to\s*(\d+)/i;

function resolveKiroBinary(): string {
  if (typeof Bun !== "undefined") {
    if (Bun.which("kiro-cli")) return "kiro-cli";
    if (Bun.which("kiro")) return "kiro";
  }
  return "kiro-cli";
}

export function buildKiroCommandArgs(params: {
  isNewSession: boolean;
  prompt: string;
  agent?: string;
}): string[] {
  const args = [
    "chat",
    "--no-interactive",
    "--trust-all-tools",
  ];
  if (!params.isNewSession) {
    args.push("--resume");
  }
  if (params.agent?.trim()) {
    args.push("--agent", params.agent.trim());
  }
  args.push(params.prompt);
  return args;
}

export function buildKiroCommand(binary: string, args: string[]): string {
  return formatShellCommand([binary, ...args]);
}

function publishKiroTextUpdate(sessionId: string, text: string): void {
  runtime.publishSessionEvent(sessionId, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "kiro-text",
        type: "text",
        text,
      },
    },
  });
}

function publishKiroToolUpdate(params: {
  sessionId: string;
  id: string;
  tool: string;
  status: "pending" | "running" | "completed" | "error";
  title?: string;
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
          ...(params.title ? { title: params.title } : {}),
          ...(params.input ? { input: params.input } : {}),
          ...(params.output ? { output: params.output } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
      },
    },
  });
}

export function sanitizeKiroOutput(text: string): string {
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "")
    .replace(/[ \t]+$/gm, "");
}

function normalizeToolName(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) return "Unknown tool";
  if (raw === "fs_read" || raw === "read" || raw === "readfile") return "Read";
  if (raw === "grep" || raw === "search" || raw === "ripgrep") return "Grep";
  if (raw === "glob") return "Glob";
  if (raw === "shell" || raw === "bash" || raw === "command") return "Bash";
  if (raw === "code") return "Task";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function isOperationalLine(line: string): boolean {
  if (!line) return true;
  if (TOOL_MARKER_PATTERN.test(line)) return true;
  if (READ_OPERATION_PATTERN.test(line)) return true;
  if (/^(↱|✓|\.|- Completed in|- Summary:|Summary:|Batch\s+.+operation)/i.test(line)) return true;
  if (/^(Searching for:|Operation \d+:|Completed in \d|\[.*\]\s*\d+ bytes)/i.test(line)) return true;
  return false;
}

export function extractKiroFinalResponse(rawOutput: string): string {
  const cleaned = sanitizeKiroOutput(rawOutput);
  const lines = cleaned.split("\n").map((line) => line.trimEnd());
  const promptIndex = lines.findLastIndex((line) => line.trimStart().startsWith(">"));
  const start = promptIndex >= 0 ? promptIndex : 0;
  const candidate = lines.slice(start)
    .filter((line) => !isOperationalLine(line.trim()))
    .join("\n")
    .trim();

  if (!candidate) {
    return cleaned.trim();
  }

  return candidate.replace(/^>\s?/, "").trim();
}

type KiroToolRuntimeState = {
  id: string;
  name: string;
  title?: string;
  input?: Record<string, unknown>;
};

function createKiroStreamParser(sessionId: string) {
  let toolCounter = 0;
  let pending = "";
  let runningTool: KiroToolRuntimeState | null = null;
  let latestAssistantLine = "";

  const completeRunningTool = () => {
    if (!runningTool) return;
    publishKiroToolUpdate({
      sessionId,
      id: runningTool.id,
      tool: runningTool.name,
      status: "completed",
      title: runningTool.title,
      input: runningTool.input,
    });
    runningTool = null;
  };

  const startTool = (name: string, title: string, input?: Record<string, unknown>) => {
    completeRunningTool();
    const id = `kiro-tool-${++toolCounter}`;
    const toolState: KiroToolRuntimeState = {
      id,
      name,
      title,
      ...(input ? { input } : {}),
    };
    runningTool = toolState;
    publishKiroToolUpdate({
      sessionId,
      id,
      tool: name,
      status: "running",
      title,
      input,
    });
  };

  const pushLine = (rawLine: string) => {
    const line = sanitizeKiroOutput(rawLine).trim();
    if (!line) return;

    const readMatch = line.match(READ_OPERATION_PATTERN);
    if (readMatch) {
      const filePath = readMatch[1]?.trim() ?? "";
      const fromLine = Number(readMatch[2] ?? 1);
      const toLine = Number(readMatch[3] ?? fromLine);
      const id = `kiro-tool-${++toolCounter}`;
      publishKiroToolUpdate({
        sessionId,
        id,
        tool: "Read",
        status: "completed",
        title: `Read ${filePath}`,
        input: {
          filePath,
          offset: Math.max(0, fromLine - 1),
          limit: Math.max(1, toLine - fromLine + 1),
        },
      });
      return;
    }

    const toolMatch = line.match(TOOL_MARKER_PATTERN);
    if (toolMatch) {
      const rawTool = toolMatch[1] ?? "";
      const name = normalizeToolName(rawTool);
      const detail = line.replace(TOOL_MARKER_PATTERN, "").trim();
      const input = name === "Grep" && detail.startsWith("Searching for:")
        ? { pattern: detail.slice("Searching for:".length).trim() }
        : undefined;
      startTool(name, detail || `${name} operation`, input);
      return;
    }

    if (/completed in\s+\d/i.test(line) || /^summary:/i.test(line) || /^-\s+summary:/i.test(line)) {
      completeRunningTool();
      return;
    }

    if (line.startsWith(">")) {
      latestAssistantLine = line.replace(/^>\s?/, "").trim();
      if (latestAssistantLine) {
        publishKiroTextUpdate(sessionId, latestAssistantLine);
      }
    }
  };

  return {
    pushChunk(chunk: string) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        pushLine(line);
      }
    },
    finalize(rawOutput: string): string {
      if (pending.trim()) {
        pushLine(pending);
      }
      completeRunningTool();
      return extractKiroFinalResponse(rawOutput);
    },
    getLatestAssistantLine(): string {
      return latestAssistantLine;
    },
  };
}

async function runKiroCommand(
  binary: string,
  args: string[],
  cwd: string,
  env: SessionEnvironment,
  entry: { controller: AbortController; process?: ChildProcess },
  onChunk?: (chunk: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, ...env },
      signal: entry.controller.signal,
    });

    entry.process = child;
    child.stdin?.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk) => {
      const bufferChunk = Buffer.from(chunk);
      stdoutChunks.push(bufferChunk);
      onChunk?.(bufferChunk.toString("utf-8"));
    });

    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

      log.info("Kiro CLI completed", {
        code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });

      if (code !== 0) {
        reject(new Error(stderr || `Kiro CLI exited with code ${code}`));
        return;
      }

      resolve(stdout);
    });
  });
}

function parseKiroResponse(output: string): string {
  const text = extractKiroFinalResponse(output);
  if (!text) {
    throw new Error("Kiro returned empty response");
  }
  return text;
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
  const entry = runtime.beginRequest(sessionKey) as { controller: AbortController; process?: ChildProcess };

  try {
    return await runtime.withSessionLock(sessionKey, async () => {
      const parts = buildPromptParts(channelId, message, options, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);
      const kiroPrompt = buildSystemWrappedPrompt(systemPrompt, prompt);

      const envOverrides = runtime.getSessionEnvironment(sessionId);
      const binary = resolveKiroBinary();
      const args = buildKiroCommandArgs({
        isNewSession: newSessions.has(sessionId),
        prompt: kiroPrompt,
        agent: options?.agent,
      });
      const command = buildKiroCommand(binary, args);

      runtime.publishSessionEvent(sessionId, {
        type: "session.status",
        properties: {
          status: {
            type: "busy",
          },
        },
      });

      log.info("Running Kiro CLI", {
        cwd: workingPath,
        command,
      });

      const parser = createKiroStreamParser(sessionId);
      const output = await runKiroCommand(binary, args, workingPath, envOverrides, entry, (chunk) => {
        parser.pushChunk(chunk);
      });

      const text = parser.finalize(output) || parseKiroResponse(output);
      publishKiroTextUpdate(sessionId, text);
      runtime.publishSessionEvent(sessionId, {
        type: "session.status",
        properties: {
          status: {
            type: "idle",
          },
        },
      });
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
