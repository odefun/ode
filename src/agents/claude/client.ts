import { spawn, type ChildProcess } from "child_process";
import {
  getChannelSettings,
  getOpenCodeSession,
  setOpenCodeSession,
} from "../../storage/settings";
import { log } from "../../logger";
import { buildPromptParts, buildPromptText, buildSlackSystemPrompt } from "../shared";
import type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
} from "../types";

export type SessionEnvironment = Record<string, string>;

const activeRequests = new Map<string, { controller: AbortController; process?: ChildProcess }>();
const sessionLocks = new Map<string, Promise<unknown>>();
const sessionEnvironments = new Map<string, SessionEnvironment>();
const newSessions = new Set<string>();
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const existing = sessionLocks.get(sessionKey);
  if (existing) {
    await existing.catch(() => {});
  }

  const promise = fn();
  sessionLocks.set(sessionKey, promise);

  try {
    return await promise;
  } finally {
    sessionLocks.delete(sessionKey);
  }
}

function normalizeSessionEnvironment(env?: SessionEnvironment | null): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join("\n");
}

function isValidUuid(value: string): boolean {
  return uuidRegex.test(value);
}

export async function createSession(workingPath: string, env?: SessionEnvironment): Promise<string> {
  const sessionId = crypto.randomUUID();
  sessionEnvironments.set(sessionId, env ?? {});
  newSessions.add(sessionId);
  log.info("Created Claude session", { sessionId, workingPath });
  return sessionId;
}

export async function getOrCreateSession(
  channelId: string,
  threadId: string,
  workingPath: string,
  env: SessionEnvironment = {}
): Promise<OpenCodeSessionInfo> {
  const existingSession = getOpenCodeSession(channelId, threadId);
  if (existingSession) {
    if (!isValidUuid(existingSession)) {
      log.info("Invalid Claude session id found; generating new session", {
        channelId,
        threadId,
        workingPath,
        existingSession,
      });
      const sessionId = await createSession(workingPath, env);
      setOpenCodeSession(channelId, threadId, sessionId);
      return { sessionId, created: true };
    }

    const existingEnv = normalizeSessionEnvironment(sessionEnvironments.get(existingSession));
    const desiredEnv = normalizeSessionEnvironment(env);
    if (existingEnv !== desiredEnv) {
      log.info("Claude session environment changed; creating new session", {
        channelId,
        threadId,
        workingPath,
      });
      const sessionId = await createSession(workingPath, env);
      setOpenCodeSession(channelId, threadId, sessionId);
      return { sessionId, created: true };
    }

    if (!sessionEnvironments.has(existingSession)) {
      sessionEnvironments.set(existingSession, env);
    }

    return { sessionId: existingSession, created: false };
  }

  log.info("Creating new Claude session for thread", { channelId, threadId, workingPath });
  const sessionId = await createSession(workingPath, env);
  setOpenCodeSession(channelId, threadId, sessionId);
  return { sessionId, created: true };
}

function extractJsonPayload(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return trimmed;

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith("{") && line.endsWith("}")) {
      return line;
    }
  }

  const start = trimmed.lastIndexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1).trim();
  }

  return trimmed;
}

function formatClaudeCommand(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0) return "''";
      if (/[^\w@%+=:,./-]/.test(arg)) {
        const escaped = arg.replace(/'/g, `'"'"'`);
        return `'${escaped}'`;
      }
      return arg;
    })
    .join(" ");
}

async function runClaudeCommand(
  args: string[],
  cwd: string,
  env: SessionEnvironment,
  entry: { controller: AbortController; process?: ChildProcess }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env, ...env },
      signal: entry.controller.signal,
    });

    entry.process = child;
    child.stdin?.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude CLI timed out"));
    }, 5 * 60 * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("spawn", () => {
      log.info("Claude CLI spawned", { pid: child.pid });
    });

    child.on("exit", (code, signal) => {
      log.info("Claude CLI exited", { code, signal });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

      log.info("Claude CLI completed", {
        code,
        stdout,
        stderr,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });

      if (code !== 0) {
        reject(new Error(stderr || `Claude CLI exited with code ${code}`));
        return;
      }

      if (stderr) {
        log.warn("Claude CLI stderr", { stderr });
      }

      resolve(stdout);
    });
  });
}

async function runClaudeWithFallback(
  baseArgs: string[],
  cwd: string,
  env: SessionEnvironment,
  entry: { controller: AbortController; process?: ChildProcess }
): Promise<{ output: string; permissionMode: string; command: string }> {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const modes = isRoot ? ["dontAsk"] : ["bypassPermissions", "dontAsk"];
  let lastError: Error | null = null;

  for (const mode of modes) {
    try {
      const args = [...baseArgs];
      const prompt = args.pop();
      if (prompt !== undefined) {
        args.push("--permission-mode", mode, "--", prompt);
      } else {
        args.push("--permission-mode", mode);
      }

      const command = formatClaudeCommand(["claude", ...args]);

      log.info("Running Claude CLI", {
        mode,
        cwd,
        command,
      });

      const output = await runClaudeCommand(args, cwd, env, entry);
      return { output, permissionMode: mode, command };
    } catch (err) {
      const error = err as Error;
      const message = error.message.toLowerCase();
      if (
        mode === "bypassPermissions" &&
        (message.includes("root") || message.includes("sudo") || message.includes("dangerously-skip-permissions"))
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError ?? new Error("Claude CLI failed");
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

  const existingEntry = activeRequests.get(sessionKey);
  if (existingEntry) {
    existingEntry.controller.abort();
    existingEntry.process?.kill("SIGTERM");
  }

  const entry = { controller: new AbortController() };
  activeRequests.set(sessionKey, entry);

  try {
    return await withSessionLock(sessionKey, async () => {
      const channelSettings = getChannelSettings(channelId);
      const overrides = channelSettings.agentOverrides;
      const agent = overrides?.agent || options?.agent;

      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
      const prompt = buildPromptText(parts);
      const systemPrompt = buildSlackSystemPrompt(context?.slack);

      const isNewSession = newSessions.has(sessionId);
      const sessionArgs = isNewSession ? ["--session-id", sessionId] : ["--resume", sessionId];
      const args = [
        "--print",
        "--output-format",
        "json",
        "--append-system-prompt",
        systemPrompt,
        ...sessionArgs,
        "--add-dir",
        workingPath,
        prompt,
      ];

      const envOverrides = sessionEnvironments.get(sessionId) ?? {};
      const { output, permissionMode, command } = await runClaudeWithFallback(
        args,
        workingPath,
        envOverrides,
        entry
      );

      log.info("Claude CLI response received", { sessionId, permissionMode, command });

      let parsed: { result?: string; is_error?: boolean; error?: string; session_id?: string } | null = null;
      try {
        const payload = extractJsonPayload(output);
        parsed = JSON.parse(payload) as {
          result?: string;
          is_error?: boolean;
          error?: string;
          session_id?: string;
        };
      } catch (err) {
        throw new Error(
          `Failed to parse Claude output: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (parsed?.is_error) {
        throw new Error(parsed.error || "Claude returned an error");
      }

      const responseSessionId = parsed?.session_id;
      if (responseSessionId && responseSessionId !== sessionId && context?.slack?.threadId) {
        sessionEnvironments.set(responseSessionId, envOverrides);
        setOpenCodeSession(channelId, context.slack.threadId, responseSessionId);
      }

      newSessions.delete(sessionId);
      if (responseSessionId) {
        newSessions.delete(responseSessionId);
      }

      const text = parsed?.result?.trim() ?? "";
      if (!text) {
        throw new Error("Claude returned empty response");
      }

      return [{ text, messageType: "assistant" }];
    });
  } finally {
    activeRequests.delete(sessionKey);
  }
}

export async function ensureSession(sessionId: string): Promise<void> {
  if (!sessionEnvironments.has(sessionId)) {
    sessionEnvironments.set(sessionId, {});
  }
}

export function subscribeToSession(_sessionId: string, _handler: (event: unknown) => void): () => void {
  return () => {};
}

export async function abortSession(sessionId: string, _directory?: string): Promise<void> {
  for (const [sessionKey, entry] of activeRequests) {
    if (sessionKey.endsWith(`:${sessionId}`)) {
      entry.controller.abort();
      entry.process?.kill("SIGTERM");
      activeRequests.delete(sessionKey);
    }
  }
}

export async function cancelActiveRequest(
  channelId: string,
  sessionId: string,
  _directory?: string
): Promise<boolean> {
  const sessionKey = `${channelId}:${sessionId}`;
  const entry = activeRequests.get(sessionKey);
  if (!entry) return false;

  entry.controller.abort();
  entry.process?.kill("SIGTERM");
  activeRequests.delete(sessionKey);
  return true;
}

export function stopServer(): void {
  for (const entry of activeRequests.values()) {
    entry.controller.abort();
    entry.process?.kill("SIGTERM");
  }
  activeRequests.clear();
}

export async function startServer(): Promise<void> {
  return;
}
