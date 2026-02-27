import { setThreadSessionId } from "@/config/local/settings";
import { log } from "@/utils";
import { buildPromptParts, buildPromptText, buildSystemPrompt } from "../shared";
import {
  CliAgentRuntime,
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

type RuntimeRequestEntry = ReturnType<CliAgentRuntime["beginRequest"]>;

type ClaudeJsonRecord = {
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

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function deriveSessionTitleFromPrompt(message: string): string | undefined {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 80).trim()}...`;
}

function isValidUuid(value: string): boolean {
  return uuidRegex.test(value);
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
        const escaped = arg.replace(/'/g, "'\"'\"'");
        return `'${escaped}'`;
      }
      return arg;
    })
    .join(" ");
}

export function buildClaudeCommandArgs(params: {
  sessionId: string;
  isNewSession: boolean;
  systemPrompt: string;
  workingPath: string;
  prompt: string;
}): string[] {
  const sessionArgs = params.isNewSession
    ? ["--session-id", params.sessionId]
    : ["--resume", params.sessionId];
  return [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--append-system-prompt",
    params.systemPrompt,
    ...sessionArgs,
    "--add-dir",
    params.workingPath,
    params.prompt,
  ];
}

export function buildClaudeCommand(
  baseArgs: string[],
  permissionMode: string
): { args: string[]; command: string } {
  const args = [...baseArgs];
  const prompt = args.pop();
  args.push("--tools", "default");
  args.push("--allowedTools", "Bash,Glob,Grep,Read,Edit,Write,WebFetch,Task,TodoWrite,NotebookEdit,TaskOutput,TaskStop,ToolSearch,Skill,AskUserQuestion");
  if (prompt !== undefined) {
    args.push("--permission-mode", permissionMode, "--", prompt);
  } else {
    args.push("--permission-mode", permissionMode);
  }
  const command = formatClaudeCommand(["claude", ...args]);
  return { args, command };
}

function resolveClaudePermissionMode(agent?: string): string | undefined {
  if (agent?.trim().toLowerCase() === "plan") {
    return "plan";
  }
  return undefined;
}

function getRecordSessionId(record: ClaudeJsonRecord, fallbackSessionId: string): string {
  return typeof record.session_id === "string" ? record.session_id : fallbackSessionId;
}

function parseClaudeResult(output: string): {
  result?: string;
  is_error?: boolean;
  error?: string;
  session_id?: string;
} {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as ClaudeJsonRecord;
      if (parsed.type === "result") {
        return {
          result: parsed.result,
          is_error: parsed.is_error,
          error: parsed.error,
          session_id: parsed.session_id,
        };
      }
    } catch {
      // ignore non-json lines
    }
  }

  const payload = extractJsonPayload(output);
  return JSON.parse(payload) as {
    result?: string;
    is_error?: boolean;
    error?: string;
    session_id?: string;
  };
}

class ClaudeCodeMessageProcessor {
  private readonly runtime = new CliAgentRuntime("Claude");
  private readonly newSessions = new Set<string>();
  readonly createSession: (workingPath: string, env?: Record<string, string>) => Promise<string>;
  readonly getOrCreateSession: (
    channelId: string,
    threadId: string,
    workingPath: string,
    env?: Record<string, string>
  ) => Promise<{ sessionId: string; created: boolean }>;

  constructor() {
    const manager = createCliThreadSessionManager({
      providerId: "claudecode",
      providerName: "Claude",
      runtime: this.runtime,
      newSessions: this.newSessions,
      validateSessionId: isValidUuid,
    });
    this.createSession = manager.createSession;
    this.getOrCreateSession = manager.getOrCreateSession;
  }

  private getRecordSessionId(record: ClaudeJsonRecord, fallbackSessionId: string): string {
    return getRecordSessionId(record, fallbackSessionId);
  }

  private publishClaudeRecordAsSessionEvents(record: ClaudeJsonRecord, fallbackSessionId: string): void {
    const sessionId = this.getRecordSessionId(record, fallbackSessionId);
    const rawType = typeof record.type === "string" && record.type.trim()
      ? record.type.trim()
      : "unknown";
    this.runtime.publishSessionEvent(sessionId, {
      type: `claude.raw.${rawType}`,
      properties: {
        record,
        recordType: rawType,
        streamEventType: typeof record.event?.type === "string" ? record.event.type : undefined,
      },
    });
  }

  private async runClaudeCommand(
    args: string[],
    cwd: string,
    env: SessionEnvironment,
    entry: RuntimeRequestEntry,
    onRecord?: (record: ClaudeJsonRecord) => void
  ): Promise<string> {
    return runCliJsonCommand<ClaudeJsonRecord>({
      providerName: "Claude",
      binary: "claude",
      args,
      cwd,
      env,
      entry,
      timeoutMs: 5 * 60 * 1000,
      onRecord,
      onSpawn: (pid) => {
        log.info("Claude CLI spawned", { pid });
      },
      onExit: (code, signal) => {
        log.info("Claude CLI exited", { code, signal });
      },
      logRawOutput: true,
    });
  }

  private async runClaudeWithFallback(
    baseArgs: string[],
    cwd: string,
    env: SessionEnvironment,
    entry: RuntimeRequestEntry,
    forcedPermissionMode?: string,
    onRecord?: (record: ClaudeJsonRecord) => void
  ): Promise<{ output: string; permissionMode: string; command: string }> {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    const modes = forcedPermissionMode
      ? [forcedPermissionMode]
      : (isRoot
        ? ["dontAsk", "acceptEdits", "default"]
        : ["bypassPermissions", "dontAsk", "acceptEdits", "default"]);
    let lastError: Error | null = null;

    for (const mode of modes) {
      try {
        const { args, command } = buildClaudeCommand(baseArgs, mode);

        log.info("Running Claude CLI", {
          mode,
          cwd,
          command,
        });

        const output = await this.runClaudeCommand(args, cwd, env, entry, onRecord);
        return { output, permissionMode: mode, command };
      } catch (err) {
        const error = err as Error;
        const message = error.message.toLowerCase();
        const isBypassNotAllowed =
          mode === "bypassPermissions" &&
          (message.includes("root")
            || message.includes("sudo")
            || message.includes("dangerously-skip-permissions"));
        const isModeUnsupported =
          message.includes("invalid")
          && message.includes("permission")
          && message.includes("mode");

        if (isBypassNotAllowed || isModeUnsupported) {
          lastError = error;
          log.warn("Retrying Claude CLI with fallback permission mode", {
            failedMode: mode,
            error: error.message,
          });
          continue;
        }

        throw error;
      }
    }

    throw lastError ?? new Error("Claude CLI failed");
  }

  async sendMessage(
    channelId: string,
    sessionId: string,
    message: string,
    workingPath: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ): Promise<OpenCodeMessage[]> {
    const sessionKey = `${channelId}:${sessionId}`;
    const entry = this.runtime.beginRequest(sessionKey);

    try {
      return await this.runtime.withSessionLock(sessionKey, async () => {
        const agent = options?.agent;
        const forcedPermissionMode = resolveClaudePermissionMode(agent);

        const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
        const prompt = buildPromptText(parts);
        const systemPrompt = buildSystemPrompt(context?.slack);

        const isNewSession = this.newSessions.has(sessionId);
        if (isNewSession) {
          const fallbackTitle = deriveSessionTitleFromPrompt(message);
          if (fallbackTitle) {
            this.runtime.publishSessionEvent(sessionId, {
              type: "session.updated",
              properties: {
                sessionID: sessionId,
                info: {
                  title: fallbackTitle,
                },
              },
            });
          }
        }
        const args = buildClaudeCommandArgs({
          sessionId,
          isNewSession,
          systemPrompt,
          workingPath,
          prompt,
        });

        const envOverrides = this.runtime.getSessionEnvironment(sessionId);
        const { output, permissionMode, command } = await this.runClaudeWithFallback(
          args,
          workingPath,
          envOverrides,
          entry,
          forcedPermissionMode,
          (record) => {
            this.publishClaudeRecordAsSessionEvents(record, sessionId);
          }
        );

        log.info("Claude CLI response received", { sessionId, permissionMode, command });

        let parsed: { result?: string; is_error?: boolean; error?: string; session_id?: string } | null = null;
        try {
          parsed = parseClaudeResult(output);
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
          this.runtime.setSessionEnvironment(responseSessionId, envOverrides);
          setThreadSessionId(channelId, context.slack.threadId, responseSessionId);
        }

        this.newSessions.delete(sessionId);
        if (responseSessionId) {
          this.newSessions.delete(responseSessionId);
        }

        const text = parsed?.result?.trim() ?? "";
        if (!text) {
          throw new Error("Claude returned empty response");
        }

        return [{ text, messageType: "assistant" }];
      });
    } finally {
      this.runtime.endRequest(sessionKey);
    }
  }

  ensureSession(sessionId: string): Promise<void> {
    return this.runtime.ensureSession(sessionId);
  }

  subscribeToSession(sessionId: string, handler: (event: unknown) => void): () => void {
    return this.runtime.subscribeToSession(sessionId, handler);
  }

  abortSession(sessionId: string): Promise<void> {
    return this.runtime.abortSession(sessionId);
  }

  cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
    return this.runtime.cancelActiveRequest(channelId, sessionId);
  }

  stopServer(): Promise<void> {
    return Promise.resolve(this.runtime.stopServer());
  }

  startServer(): Promise<void> {
    return noopStartServer();
  }
}

export const claudeCodeAgent = new ClaudeCodeMessageProcessor();

export const createSession = claudeCodeAgent.createSession;
export const getOrCreateSession = claudeCodeAgent.getOrCreateSession;
export const sendMessage = claudeCodeAgent.sendMessage.bind(claudeCodeAgent);
export const cancelActiveRequest = claudeCodeAgent.cancelActiveRequest.bind(claudeCodeAgent);
export const abortSession = claudeCodeAgent.abortSession.bind(claudeCodeAgent);
export const ensureSession = claudeCodeAgent.ensureSession.bind(claudeCodeAgent);
export const subscribeToSession = claudeCodeAgent.subscribeToSession.bind(claudeCodeAgent);
export const startServer = claudeCodeAgent.startServer.bind(claudeCodeAgent);
export const stopServer = claudeCodeAgent.stopServer.bind(claudeCodeAgent);
