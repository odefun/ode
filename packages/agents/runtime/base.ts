import { spawn, type ChildProcess } from "child_process";
import { log } from "@/utils";

export type SessionEnvironment = Record<string, string>;

type SessionHandler = (event: unknown) => void;

type ActiveRequestEntry = {
  controller: AbortController;
  process?: ChildProcess;
  /**
   * If this entry replaced an in-flight request, the previous process is kept
   * here so the next CLI invocation can wait for it to fully exit (and release
   * any session-level lock) before spawning a replacement.
   */
  previousProcess?: ChildProcess;
};

type RunCliJsonCommandParams<TRecord> = {
  providerName: string;
  binary: string;
  args: string[];
  cwd: string;
  env: SessionEnvironment;
  entry: ActiveRequestEntry;
  timeoutMs?: number;
  onRecord?: (record: TRecord) => void;
  onSpawn?: (pid: number | undefined) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  logRawOutput?: boolean;
};

/**
 * How long to wait for a previously-spawned CLI subprocess to fully exit
 * before spawning the next one for the same session. Several CLIs (notably
 * `claude`) hold an in-flight session lock until the process actually exits,
 * so spawning a replacement too eagerly produces "Session ID … is already in
 * use".
 */
const PROCESS_CLOSE_TIMEOUT_MS = 2000;

async function waitForPreviousProcessClose(
  providerName: string,
  entry: ActiveRequestEntry
): Promise<void> {
  const previous = entry.previousProcess;
  if (!previous) return;
  // Drop the reference unconditionally so we don't hold the previous process
  // forever, even if it has already exited.
  entry.previousProcess = undefined;
  if (previous.exitCode !== null || previous.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      log.warn(`${providerName} previous process did not close in time`, {
        pid: previous.pid,
        timeoutMs: PROCESS_CLOSE_TIMEOUT_MS,
      });
      finish();
    }, PROCESS_CLOSE_TIMEOUT_MS);
    previous.once("close", finish);
    previous.once("exit", finish);
  });
}

/**
 * When a CLI exits non-zero but writes its real error to stdout (as the
 * `claude` CLI does for upstream 5xx — `code=1`, stderr empty, the
 * `API Error: 524 …` payload buried in the last stream-json `type:"result"`
 * line), we still need to surface that text so downstream transient-error
 * matching can recognise it. This pulls the most useful message out of the
 * captured stdout in a provider-agnostic way.
 */
export function extractErrorFromStdout(stdout: string): string | undefined {
  if (!stdout) return undefined;

  const lines = stdout.split("\n");
  // Scan from the end: the terminating record (e.g. `type:"result"`) is
  // emitted last and carries the most reliable error payload.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as {
        is_error?: boolean;
        error?: unknown;
        result?: unknown;
      };
      if (parsed.is_error === true || typeof parsed.error === "string") {
        if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
          return parsed.error.trim();
        }
        if (typeof parsed.result === "string" && parsed.result.trim().length > 0) {
          return parsed.result.trim();
        }
        // Last resort: return the raw record so isTransientClaudeError can
        // still pattern-match on its body (e.g. `cloudflare_error`).
        return line;
      }
    } catch {
      // Not a JSON line; keep scanning.
    }
  }

  // No structured error found; fall back to the last non-empty line of stdout
  // (avoids returning multi-MB blobs).
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line) return line.length > 500 ? `${line.slice(0, 500)}…` : line;
  }
  return undefined;
}

export async function runCliJsonCommand<TRecord>(params: RunCliJsonCommandParams<TRecord>): Promise<string> {
  const {
    providerName,
    binary,
    args,
    cwd,
    env,
    entry,
    timeoutMs,
    onRecord,
    onSpawn,
    onExit,
    logRawOutput = false,
  } = params;

  // If a previous child process for the same session was just SIGTERM'd, give
  // it a brief window to actually exit (and release any server-side session
  // lock) before we spawn the next one. Bounded by PROCESS_CLOSE_TIMEOUT_MS,
  // so a stuck child can never block us indefinitely.
  await waitForPreviousProcessClose(providerName, entry);

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
    let stdoutBuffer = "";

    const flushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !onRecord) return;
      try {
        onRecord(JSON.parse(trimmed) as TRecord);
      } catch {
        // ignore non-json stream lines
      }
    };

    child.stdout?.on("data", (chunk) => {
      const bufferChunk = Buffer.from(chunk);
      stdoutChunks.push(bufferChunk);
      stdoutBuffer += bufferChunk.toString("utf-8");
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        flushLine(line);
      }
    });

    child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : null;
    const timeout = effectiveTimeoutMs === null
      ? null
      : setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${providerName} CLI timed out`));
      }, effectiveTimeoutMs);

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("spawn", () => {
      onSpawn?.(child.pid);
    });

    child.on("exit", (code, signal) => {
      onExit?.(code, signal);
    });

    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (stdoutBuffer.trim().length > 0) {
        flushLine(stdoutBuffer);
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

      const completionDetails: Record<string, unknown> = {
        code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      };
      if (logRawOutput) {
        completionDetails.stdout = stdout;
        completionDetails.stderr = stderr;
      }

      log.info(`${providerName} CLI completed`, completionDetails);

      if (code !== 0) {
        // Prefer stderr (CLI's own diagnostics). If stderr is empty — which
        // is the case for claude on Anthropic upstream 5xx — fall back to
        // mining stdout for a structured error record so downstream code can
        // recognise transient failures like API Error: 524 and retry.
        const stdoutError = stderr ? undefined : extractErrorFromStdout(stdout);
        reject(
          new Error(
            stderr ||
              stdoutError ||
              `${providerName} CLI exited with code ${code}`
          )
        );
        return;
      }

      if (stderr) {
        log.warn(`${providerName} CLI stderr`, { stderr });
      }

      resolve(stdout);
    });
  });
}

export function normalizeSessionEnvironment(env?: SessionEnvironment | null): string {
  if (!env) return "";
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join("\n");
}

export function formatShellCommand(args: string[]): string {
  return args
    .map((arg) => {
      if (arg.length === 0) return "''";
      if (/[^\w@%+=:,./-]/.test(arg)) {
        const escaped = arg.replace(/'/g, `"'"'"`);
        return `'${escaped}'`;
      }
      return arg;
    })
    .join(" ");
}

export async function noopStartServer(): Promise<void> {
  return;
}

export abstract class BaseAgentRuntime {
  protected readonly sessionLocks = new Map<string, Promise<unknown>>();
  protected readonly sessionEnvironments = new Map<string, SessionEnvironment>();
  protected readonly sessionSubscribers = new Map<string, Set<SessionHandler>>();

  protected constructor(private readonly providerName: string) {}

  async withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.sessionLocks.get(sessionKey);
    if (existing) {
      await existing.catch(() => {});
    }

    const promise = fn();
    this.sessionLocks.set(sessionKey, promise);

    try {
      return await promise;
    } finally {
      this.sessionLocks.delete(sessionKey);
    }
  }

  ensureSessionEnvironment(sessionId: string): void {
    if (!this.sessionEnvironments.has(sessionId)) {
      this.sessionEnvironments.set(sessionId, {});
    }
  }

  getSessionEnvironment(sessionId: string): SessionEnvironment {
    return this.sessionEnvironments.get(sessionId) ?? {};
  }

  setSessionEnvironment(sessionId: string, env: SessionEnvironment): void {
    this.sessionEnvironments.set(sessionId, env);
  }

  subscribeToSession(sessionId: string, handler: SessionHandler): () => void {
    const handlers = this.sessionSubscribers.get(sessionId) ?? new Set<SessionHandler>();
    handlers.add(handler);
    this.sessionSubscribers.set(sessionId, handlers);

    return () => {
      const activeHandlers = this.sessionSubscribers.get(sessionId);
      if (!activeHandlers) return;
      activeHandlers.delete(handler);
      if (activeHandlers.size === 0) {
        this.sessionSubscribers.delete(sessionId);
      }
    };
  }

  publishSessionEvent(sessionId: string, event: unknown): void {
    const handlers = this.sessionSubscribers.get(sessionId);
    if (!handlers || handlers.size === 0) return;
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        log.warn(`${this.providerName} session subscriber failed`, {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  protected clearSharedState(): void {
    this.sessionLocks.clear();
    this.sessionSubscribers.clear();
  }
}

export class CliAgentRuntime extends BaseAgentRuntime {
  private readonly activeRequests = new Map<string, ActiveRequestEntry>();

  constructor(providerName: string) {
    super(providerName);
  }

  beginRequest(sessionKey: string): ActiveRequestEntry {
    const existingEntry = this.activeRequests.get(sessionKey);
    if (existingEntry) {
      existingEntry.controller.abort();
      existingEntry.process?.kill("SIGTERM");
    }

    const entry: ActiveRequestEntry = {
      controller: new AbortController(),
      previousProcess: existingEntry?.process,
    };
    this.activeRequests.set(sessionKey, entry);
    return entry;
  }

  endRequest(sessionKey: string): void {
    this.activeRequests.delete(sessionKey);
  }

  async ensureSession(sessionId: string): Promise<void> {
    this.ensureSessionEnvironment(sessionId);
  }

  async abortSession(sessionId: string): Promise<void> {
    for (const [sessionKey, entry] of this.activeRequests) {
      if (sessionKey.endsWith(`:${sessionId}`)) {
        entry.controller.abort();
        entry.process?.kill("SIGTERM");
        this.activeRequests.delete(sessionKey);
      }
    }
  }

  async cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
    const sessionKey = `${channelId}:${sessionId}`;
    const entry = this.activeRequests.get(sessionKey);
    if (!entry) return false;

    entry.controller.abort();
    entry.process?.kill("SIGTERM");
    this.activeRequests.delete(sessionKey);
    return true;
  }

  stopServer(): void {
    for (const entry of this.activeRequests.values()) {
      entry.controller.abort();
      entry.process?.kill("SIGTERM");
    }
    this.activeRequests.clear();
    this.clearSharedState();
  }
}

export class ServerAgentRuntime extends BaseAgentRuntime {
  private readonly activeRequests = new Map<string, AbortController>();

  constructor() {
    super("OpenCode");
  }

  beginRequest(sessionKey: string): AbortController {
    const existingController = this.activeRequests.get(sessionKey);
    if (existingController) {
      existingController.abort();
    }

    const controller = new AbortController();
    this.activeRequests.set(sessionKey, controller);
    return controller;
  }

  endRequest(sessionKey: string): void {
    this.activeRequests.delete(sessionKey);
  }

  async cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
    const sessionKey = `${channelId}:${sessionId}`;
    const controller = this.activeRequests.get(sessionKey);
    if (!controller) return false;
    controller.abort();
    this.activeRequests.delete(sessionKey);
    return true;
  }
}
