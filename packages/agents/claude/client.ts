import { randomUUID } from "node:crypto";
import { setThreadSessionId } from "@/config/local/sessions";
import { BoundedSet, log } from "@/utils";
import { createDeferred, type Deferred } from "@/core/runtime/helpers";
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

const runtime = new CliAgentRuntime("Claude");
type RuntimeRequestEntry = ReturnType<CliAgentRuntime["beginRequest"]>;

// Cap how many AskUserQuestion → reply hops we honor inside a single
// sendMessage call. If the model keeps asking after this many rounds
// something is wrong (e.g. a buggy prompt loop) and we'd rather surface a
// hard failure than spin forever holding a Slack thread hostage.
const MAX_ASK_USER_QUESTION_ROUNDS = 8;

/**
 * Each Claude session can have at most one in-flight AskUserQuestion request
 * at a time. The runtime serializes turns via `withSessionLock`, so even when
 * the model loops we never have overlapping pendings on the same session.
 *
 * Stored per sessionId so `replyToQuestion(sessionId, requestId, answers)`
 * can route the reply back to the awaiting `sendMessage` invocation, which
 * then resumes the Claude CLI with the answers as a follow-up user prompt.
 */
type PendingClaudeQuestion = {
  requestId: string;
  questionCount: number;
  deferred: Deferred<{ status: "answered"; answers: string[] } | { status: "cancelled"; reason?: string }>;
};
const pendingQuestions = new Map<string, PendingClaudeQuestion>();
/**
 * FIFO-bounded cache of session ids that have not yet completed their first
 * turn. Evicting the oldest entry on overflow is safe: the flag only gates
 * one-time startup behaviour for that session, and any session that has been
 * queued for this long without being consumed is effectively abandoned.
 */
const NEW_SESSIONS_MAX_ENTRIES = 1000;
const newSessions = new BoundedSet<string>(NEW_SESSIONS_MAX_ENTRIES);
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function deriveSessionTitleFromPrompt(message: string): string | undefined {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 80).trim()}...`;
}

function isValidUuid(value: string): boolean {
  return uuidRegex.test(value);
}

export const { createSession, getOrCreateSession } = createCliThreadSessionManager({
  providerId: "claudecode",
  providerName: "Claude",
  runtime,
  newSessions,
  validateSessionId: isValidUuid,
});

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
        const escaped = arg.replace(/'/g, `"'"'"`);
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

/**
 * Publish a Claude stream-json record as a session event.
 *
 * `subscriptionSessionId` is the session id the kernel subscribed against
 * when the request started. We *always* dispatch on that id even when the
 * record itself carries a different `session_id` (Claude can rotate the id
 * mid-turn on `--resume`), because in-process subscribers register by id
 * and would otherwise stop receiving events the moment the id changes.
 *
 * `recordSessionFallback` is only used to compute the `session_id` we tag
 * onto the published event payload (which downstream code reads to filter
 * inspector state by session). Keeping that distinct from the dispatch key
 * means we don't lose events even if the record drifts.
 */
function publishClaudeRecordAsSessionEvents(
  record: ClaudeJsonRecord,
  subscriptionSessionId: string,
  recordSessionFallback: string = subscriptionSessionId
): void {
  const recordSessionId = getRecordSessionId(record, recordSessionFallback);
  const rawType = typeof record.type === "string" && record.type.trim()
    ? record.type.trim()
    : "unknown";
  runtime.publishSessionEvent(subscriptionSessionId, {
    type: `claude.raw.${rawType}`,
    properties: {
      record,
      recordType: rawType,
      recordSessionId,
      streamEventType: typeof record.event?.type === "string" ? record.event.type : undefined,
    },
  });
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

export type ClaudeAskUserQuestionOption = {
  label: string;
  description?: string;
};

export type ClaudeAskUserQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: ClaudeAskUserQuestionOption[];
};

export type ClaudeAskUserQuestionToolUse = {
  toolUseId?: string;
  questions: ClaudeAskUserQuestion[];
};

function coerceQuestionOptions(raw: unknown): ClaudeAskUserQuestionOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options = raw
    .map((entry): ClaudeAskUserQuestionOption | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const labelRaw = typeof record.label === "string" ? record.label.trim() : "";
      if (!labelRaw) return null;
      const descriptionRaw = typeof record.description === "string" ? record.description.trim() : "";
      const option: ClaudeAskUserQuestionOption = { label: labelRaw };
      if (descriptionRaw) option.description = descriptionRaw;
      return option;
    })
    .filter((option): option is ClaudeAskUserQuestionOption => option !== null);
  return options.length > 0 ? options : undefined;
}

function coerceQuestions(raw: unknown): ClaudeAskUserQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions = raw
    .map((entry): ClaudeAskUserQuestion | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const questionText = typeof record.question === "string" ? record.question.trim() : "";
      if (!questionText) return null;
      const out: ClaudeAskUserQuestion = { question: questionText };
      if (typeof record.header === "string" && record.header.trim()) {
        out.header = record.header.trim();
      }
      if (typeof record.multiSelect === "boolean") {
        out.multiSelect = record.multiSelect;
      }
      const options = coerceQuestionOptions(record.options);
      if (options) out.options = options;
      return out;
    })
    .filter((question): question is ClaudeAskUserQuestion => question !== null);
  return questions;
}

/**
 * Walk the Claude stream-json output and return the *last* AskUserQuestion
 * tool_use, if any. We only consider fully assembled `assistant` records
 * (not partial `stream_event` deltas) so we always read a coherent input
 * payload. Returns `null` when the model never invoked AskUserQuestion in
 * this turn.
 */
export function extractAskUserQuestionToolUse(output: string): ClaudeAskUserQuestionToolUse | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let lastFound: ClaudeAskUserQuestionToolUse | null = null;
  for (const line of lines) {
    let parsed: ClaudeJsonRecord;
    try {
      parsed = JSON.parse(line) as ClaudeJsonRecord;
    } catch {
      continue;
    }
    if (parsed.type !== "assistant") continue;
    const blocks = parsed.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      if (record.type !== "tool_use") continue;
      if (typeof record.name !== "string") continue;
      if (record.name !== "AskUserQuestion") continue;
      const input = record.input;
      if (!input || typeof input !== "object" || Array.isArray(input)) continue;
      const questionsRaw = (input as Record<string, unknown>).questions;
      const questions = coerceQuestions(questionsRaw);
      if (questions.length === 0) continue;
      const toolUseIdRaw = record.id;
      lastFound = {
        toolUseId: typeof toolUseIdRaw === "string" ? toolUseIdRaw : undefined,
        questions,
      };
    }
  }
  return lastFound;
}

function formatAskUserQuestionAnswers(
  questions: ClaudeAskUserQuestion[],
  answers: string[]
): string {
  // Phrased as a follow-up user message that resumes the previous turn. We
  // restate the questions because Claude on `--resume` only sees prior
  // assistant tool_use + the tool_result error we couldn't suppress, and
  // it's much clearer to repeat the Q/A inline than to rely on the model
  // recovering the context.
  const lines: string[] = [
    "Here are my answers to the questions you just asked:",
    "",
  ];
  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]?.question ?? `Question ${i + 1}`;
    const answer = answers[i] ?? "";
    const prefix = questions.length > 1 ? `Q${i + 1}: ` : "Q: ";
    lines.push(`${prefix}${question}`);
    lines.push(`A: ${answer}`);
    lines.push("");
  }
  lines.push(
    "Use these answers to continue. Don't call AskUserQuestion again for the same items unless something is genuinely ambiguous after re-reading my answers."
  );
  return lines.join("\n").trimEnd();
}

async function runClaudeCommand(
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

async function runClaudeWithFallback(
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

      const output = await runClaudeCommand(args, cwd, env, entry, onRecord);
      return { output, permissionMode: mode, command };
    } catch (err) {
      const error = err as Error;
      const message = error.message.toLowerCase();
      const isBypassNotAllowed =
        mode === "bypassPermissions" &&
        (message.includes("root") ||
          message.includes("sudo") ||
          message.includes("dangerously-skip-permissions"));
      const isModeUnsupported =
        message.includes("invalid") &&
        message.includes("permission") &&
        message.includes("mode");

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

  // The kernel subscribed against this `sessionId` when it built the
  // request, and `subscribeToSession` registers handlers per-id in an
  // in-memory map. If Claude rotates `session_id` mid-turn (it can on
  // `--resume`), publishing on the rotated id would leave the kernel
  // listening on a now-empty channel — including the question.asked event
  // that drives the Slack question UI. We always dispatch on the original
  // id and treat any rotated id as something we only need to honor when
  // *spawning* the next Claude CLI invocation.
  //
  // adapter.ts also keys provider ownership off this original id, so all
  // routing (subscribe → kernel filter → replyToQuestion) stays consistent
  // even when the underlying Claude session id drifts.
  const subscriptionSessionId = sessionId;

  try {
    return await runtime.withSessionLock(sessionKey, async () => {
      const agent = options?.agent;
      const forcedPermissionMode = resolveClaudePermissionMode(agent);

      const parts = buildPromptParts(channelId, message, { ...options, agent }, context);
      const initialPrompt = buildPromptText(parts);
      const systemPrompt = buildSystemPrompt(context?.slack);

      let isNewSession = newSessions.has(sessionId);
      // Id used for Claude CLI --session-id / --resume + per-id environment
      // overrides. Tracks the latest session id Claude reported so resume
      // works after a rotation, while events stay on `subscriptionSessionId`.
      let runtimeSessionId = sessionId;
      let prompt = initialPrompt;

      if (isNewSession) {
        const fallbackTitle = deriveSessionTitleFromPrompt(message);
        if (fallbackTitle) {
          runtime.publishSessionEvent(subscriptionSessionId, {
            type: "session.updated",
            properties: {
              sessionID: subscriptionSessionId,
              info: {
                title: fallbackTitle,
              },
            },
          });
        }
      }

      for (let round = 0; round < MAX_ASK_USER_QUESTION_ROUNDS; round += 1) {
        const args = buildClaudeCommandArgs({
          sessionId: runtimeSessionId,
          isNewSession,
          systemPrompt,
          workingPath,
          prompt,
        });

        const envOverrides = runtime.getSessionEnvironment(runtimeSessionId);
        const { output, permissionMode, command } = await runClaudeWithFallback(
          args,
          workingPath,
          envOverrides,
          entry,
          forcedPermissionMode,
          (record) => {
            publishClaudeRecordAsSessionEvents(record, subscriptionSessionId, runtimeSessionId);
          }
        );

        log.info("Claude CLI response received", {
          subscriptionSessionId,
          runtimeSessionId,
          permissionMode,
          command,
          round,
        });

        let parsed: { result?: string; is_error?: boolean; error?: string; session_id?: string } | null = null;
        let parseError: Error | null = null;
        try {
          parsed = parseClaudeResult(output);
        } catch (err) {
          parseError = err instanceof Error ? err : new Error(String(err));
        }

        const responseSessionId = parsed?.session_id;
        if (responseSessionId && responseSessionId !== runtimeSessionId && context?.slack?.threadId) {
          runtime.setSessionEnvironment(responseSessionId, envOverrides);
          setThreadSessionId(channelId, context.slack.threadId, responseSessionId);
          runtimeSessionId = responseSessionId;
        }

        if (parsed?.is_error) {
          throw new Error(parsed.error || "Claude returned an error");
        }

        const text = parsed?.result?.trim() ?? "";
        if (text) {
          newSessions.delete(sessionId);
          newSessions.delete(runtimeSessionId);
          return [{ text, messageType: "assistant" }];
        }

        // No usable final result. Before giving up with "empty response",
        // see if the model parked the turn on AskUserQuestion. When it did
        // we want to surface the question to the user (via the same
        // question.asked event the kernel already wires for OpenCode) and
        // resume the Claude CLI with the user's answer instead of failing
        // the whole turn.
        const askUser = extractAskUserQuestionToolUse(output);
        if (!askUser) {
          if (parseError) {
            throw new Error(`Failed to parse Claude output: ${parseError.message}`);
          }
          throw new Error("Claude returned empty response");
        }

        const requestId = askUser.toolUseId && askUser.toolUseId.length > 0
          ? askUser.toolUseId
          : `claude-q-${randomUUID()}`;

        const deferred = createDeferred<
          { status: "answered"; answers: string[] } | { status: "cancelled"; reason?: string }
        >();
        // Key the pending entry by `subscriptionSessionId` so
        // `replyToQuestion(sessionId, ...)` from the adapter (which uses the
        // same original id) finds it even after `runtimeSessionId` rotated.
        pendingQuestions.set(subscriptionSessionId, {
          requestId,
          questionCount: askUser.questions.length,
          deferred,
        });

        runtime.publishSessionEvent(subscriptionSessionId, {
          type: "question.asked",
          properties: {
            id: requestId,
            // Use the kernel-known id so `extractEventSessionId` matches
            // `request.sessionId` and the kernel doesn't filter the event.
            sessionID: subscriptionSessionId,
            questions: askUser.questions,
          },
        });

        let outcome: { status: "answered"; answers: string[] } | { status: "cancelled"; reason?: string };
        try {
          outcome = await deferred.promise;
        } finally {
          const stored = pendingQuestions.get(subscriptionSessionId);
          if (stored && stored.requestId === requestId) {
            pendingQuestions.delete(subscriptionSessionId);
          }
        }

        if (outcome.status === "cancelled") {
          throw new Error(outcome.reason ?? "Claude question cancelled");
        }

        prompt = formatAskUserQuestionAnswers(askUser.questions, outcome.answers);
        isNewSession = false;
      }

      throw new Error(
        `Claude AskUserQuestion loop exceeded ${MAX_ASK_USER_QUESTION_ROUNDS} rounds without a final response`
      );
    });
  } finally {
    runtime.endRequest(sessionKey);
  }
}

/**
 * Resolve a pending AskUserQuestion request with the user's answers. The
 * adapter routes Claude question replies here when the kernel collects all
 * answers for a previously-published `question.asked` event.
 *
 * `answers` is a parallel array to the questions originally asked. When the
 * kernel collected one user reply per question (the normal multi-question
 * flow), each entry is a single trimmed string. We accept the
 * `Array<Array<string>>` shape that the OpenCode `question.reply` API uses
 * and flatten it down to one string per question.
 */
export async function replyToQuestion(params: {
  sessionId: string;
  requestId: string;
  answers: Array<Array<string>>;
}): Promise<void> {
  const pending = pendingQuestions.get(params.sessionId);
  if (!pending) {
    throw new Error(`No pending Claude question for session ${params.sessionId}`);
  }
  if (pending.requestId !== params.requestId) {
    throw new Error(
      `Claude question requestId mismatch (expected ${pending.requestId}, got ${params.requestId})`
    );
  }

  const flattened: string[] = [];
  for (let i = 0; i < pending.questionCount; i += 1) {
    const entry = params.answers[i];
    if (Array.isArray(entry) && entry.length > 0) {
      const joined = entry
        .map((value) => (typeof value === "string" ? value.trim() : String(value ?? "").trim()))
        .filter((value) => value.length > 0)
        .join(", ");
      flattened.push(joined);
    } else {
      flattened.push("");
    }
  }
  pending.deferred.resolve({ status: "answered", answers: flattened });
}

/**
 * Cancel any pending AskUserQuestion for this session, unblocking
 * `sendMessage` so the caller's `withSessionLock` can release. Used by stop
 * commands and abort paths.
 */
function cancelPendingQuestion(sessionId: string, reason?: string): void {
  const pending = pendingQuestions.get(sessionId);
  if (!pending) return;
  pendingQuestions.delete(sessionId);
  pending.deferred.resolve({ status: "cancelled", reason });
}

export const ensureSession = runtime.ensureSession.bind(runtime);

export const subscribeToSession = runtime.subscribeToSession.bind(runtime);

export async function abortSession(sessionId: string, _directory?: string): Promise<void> {
  cancelPendingQuestion(sessionId, "Claude session aborted");
  await runtime.abortSession(sessionId);
}

export async function cancelActiveRequest(channelId: string, sessionId: string): Promise<boolean> {
  cancelPendingQuestion(sessionId, "Claude request cancelled");
  return runtime.cancelActiveRequest(channelId, sessionId);
}

export const stopServer = runtime.stopServer.bind(runtime);
export const startServer = noopStartServer;
