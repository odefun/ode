import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { log } from "@/utils";

type JsonRpcId = number | string;
type JsonRecord = Record<string, any>;

type PendingCall = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type PendingTurn = {
  resolve: (turn: JsonRecord) => void;
  reject: (error: Error) => void;
};

const pendingQuestions = new Map<string, {
  connection: CodexAppServerConnection;
  rpcId: JsonRpcId;
  questions: JsonRecord[];
}>();

export const CODEX_SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval",
]);

export function isKnownCodexServerRequestMethod(method: string): boolean {
  return CODEX_SERVER_REQUEST_METHODS.has(method);
}

export class CodexAppServerUnavailableError extends Error {}

export type CodexServerRequestFallback =
  | { kind: "handled-elsewhere" }
  | { kind: "result"; result: JsonRecord }
  | { kind: "error"; error: { code: number; message: string } };

/**
 * Return a protocol-valid, least-privilege response for app-server requests
 * that Ode cannot interactively fulfill yet. This keeps the turn moving (or
 * fails the individual capability clearly) instead of replying "method not
 * found", which app-server interprets as a broken client implementation.
 */
export function getCodexServerRequestFallback(
  method: string,
  nowMs = Date.now()
): CodexServerRequestFallback {
  if (method === "item/tool/requestUserInput") {
    return { kind: "handled-elsewhere" };
  }
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { kind: "result", result: { decision: "decline" } };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return {
      kind: "result",
      result: { decision: { denied: { rejection: "Ode did not receive explicit user approval." } } },
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return { kind: "result", result: { action: "decline", content: null, _meta: null } };
  }
  if (method === "item/permissions/requestApproval") {
    return { kind: "result", result: { permissions: {}, scope: "turn" } };
  }
  if (method === "item/tool/call") {
    return {
      kind: "result",
      result: {
        success: false,
        contentItems: [{
          type: "inputText",
          text: "Ode does not expose this client-side dynamic tool.",
        }],
      },
    };
  }
  if (method === "currentTime/read") {
    return {
      kind: "result",
      result: { currentTimeAt: Math.floor(nowMs / 1000) },
    };
  }
  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      kind: "error",
      error: { code: -32001, message: "Ode cannot refresh Codex account tokens; re-authenticate with Codex CLI." },
    };
  }
  if (method === "attestation/generate") {
    return {
      kind: "error",
      error: { code: -32002, message: "Client attestation is disabled for the Ode app-server connection." },
    };
  }
  return {
    kind: "error",
    error: { code: -32601, message: `Ode does not support server request ${method}` },
  };
}

export class CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly calls = new Map<JsonRpcId, PendingCall>();
  private readonly turns = new Map<string, PendingTurn>();
  private nextId = 1;
  private stdoutBuffer = "";
  private initialized = false;
  private closed = false;
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private readonly connectionId = randomUUID();

  constructor(
    private readonly cwd: string,
    env: Record<string, string>,
    private readonly onNotification: (notification: JsonRecord) => void
  ) {
    this.child = spawn("codex", ["app-server", "--stdio"], {
      cwd,
      env: { ...process.env, ...env, PWD: cwd },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log.debug("Codex app-server stderr", { text: text.slice(0, 2000) });
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.request("initialize", {
        clientInfo: { name: "ode", title: "Ode", version: "0.2.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.notify("initialized");
      this.initialized = true;
    } catch (error) {
      throw new CodexAppServerUnavailableError(`Codex app-server initialize failed: ${String(error)}`);
    }
  }

  async startThread(params: {
    cwd: string;
    model?: string;
    systemPrompt?: string;
    planMode?: boolean;
  }): Promise<string> {
    const response = await this.request("thread/start", {
      cwd: params.cwd,
      model: params.model ?? null,
      approvalPolicy: "never",
      sandbox: params.planMode ? "read-only" : "danger-full-access",
      developerInstructions: params.systemPrompt || null,
      experimentalRawEvents: false,
    }).catch((error) => {
      throw new CodexAppServerUnavailableError(`Codex thread/start failed: ${String(error)}`);
    });
    const threadId = response?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new CodexAppServerUnavailableError("Codex thread/start returned no thread id");
    }
    return threadId;
  }

  async resumeThread(params: {
    threadId: string;
    cwd: string;
    model?: string;
    systemPrompt?: string;
    planMode?: boolean;
  }): Promise<string> {
    const response = await this.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      model: params.model ?? null,
      approvalPolicy: "never",
      sandbox: params.planMode ? "read-only" : "danger-full-access",
      developerInstructions: params.systemPrompt || null,
      excludeTurns: true,
    }).catch((error) => {
      throw new CodexAppServerUnavailableError(`Codex thread/resume failed: ${String(error)}`);
    });
    return typeof response?.thread?.id === "string" ? response.thread.id : params.threadId;
  }

  async runTurn(params: {
    threadId: string;
    input: JsonRecord[];
    cwd: string;
    model?: string;
    effort?: string;
    planMode?: boolean;
  }): Promise<JsonRecord> {
    const response = await this.request("turn/start", {
      threadId: params.threadId,
      input: params.input,
      cwd: params.cwd,
      approvalPolicy: "never",
      model: params.model ?? null,
      effort: params.effort ?? null,
    });
    const turnId = response?.turn?.id;
    if (typeof turnId !== "string" || !turnId) throw new Error("Codex turn/start returned no turn id");
    this.activeTurn = { threadId: params.threadId, turnId };
    return await new Promise<JsonRecord>((resolve, reject) => {
      this.turns.set(turnId, { resolve, reject });
    }).finally(() => {
      if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
    });
  }

  async interrupt(): Promise<void> {
    const active = this.activeTurn;
    if (!active) return;
    await this.request("turn/interrupt", active).catch(() => undefined);
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingQuestions();
    this.child.kill("SIGTERM");
  }

  private request(method: string, params?: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(payload: unknown): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRecord);
      } catch (error) {
        log.warn("Invalid Codex app-server JSON", { error: String(error), line: line.slice(0, 500) });
      }
    }
  }

  private handleMessage(message: JsonRecord): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.calls.get(message.id);
      if (!pending) return;
      this.calls.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (!message.method) return;
    if (message.method === "serverRequest/resolved") {
      this.clearResolvedQuestion(message.params?.requestId);
    }
    this.onNotification(message);
    if (message.method === "turn/completed") {
      const turn = message.params?.turn;
      const turnId = turn?.id;
      const pending = typeof turnId === "string" ? this.turns.get(turnId) : undefined;
      if (pending) {
        this.turns.delete(turnId);
        if (turn?.status === "failed") {
          pending.reject(new Error(turn?.error?.message ?? "Codex turn failed"));
        } else {
          pending.resolve(turn);
        }
      }
    }
  }

  private handleServerRequest(message: JsonRecord): void {
    const method = String(message.method);
    if (method === "item/tool/requestUserInput") {
      const requestId = `codex-app:${this.connectionId}:${message.id}`;
      const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
      pendingQuestions.set(requestId, { connection: this, rpcId: message.id, questions });
      this.onNotification({
        method: "ode/question/requested",
        params: { requestId, ...message.params },
      });
      return;
    }
    const fallback = getCodexServerRequestFallback(method);
    if (fallback.kind === "result") {
      if (method !== "currentTime/read") {
        log.warn("Codex app-server request used safe fallback", { method });
        this.onNotification({
          method: "ode/serverRequest/declined",
          params: {
            requestMethod: method,
            threadId: message.params?.threadId ?? this.activeTurn?.threadId,
            turnId: message.params?.turnId ?? this.activeTurn?.turnId,
            message: `Ode safely declined ${method}; explicit user approval or a dedicated client capability is required.`,
          },
        });
      }
      this.respond(message.id, fallback.result);
      return;
    }
    if (fallback.kind === "error") {
      log.warn("Codex app-server request cannot be fulfilled", { method });
      this.onNotification({
        method: "ode/serverRequest/failed",
        params: {
          requestMethod: method,
          threadId: message.params?.threadId ?? this.activeTurn?.threadId,
          turnId: message.params?.turnId ?? this.activeTurn?.turnId,
          protocolKnown: isKnownCodexServerRequestMethod(method),
          message: fallback.error.message,
        },
      });
      this.write({ id: message.id, error: fallback.error });
    }
  }

  private clearResolvedQuestion(rpcId: JsonRpcId | undefined): void {
    if (rpcId === undefined) return;
    for (const [requestId, pending] of pendingQuestions) {
      if (pending.connection === this && pending.rpcId === rpcId) {
        pendingQuestions.delete(requestId);
      }
    }
  }

  private clearPendingQuestions(): void {
    for (const [requestId, pending] of pendingQuestions) {
      if (pending.connection === this) pendingQuestions.delete(requestId);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.calls.values()) pending.reject(error);
    for (const pending of this.turns.values()) pending.reject(error);
    this.calls.clear();
    this.turns.clear();
    this.clearPendingQuestions();
  }
}

export function replyToCodexAppServerQuestion(requestId: string, answers: Array<Array<string>>): boolean {
  const pending = pendingQuestions.get(requestId);
  if (!pending) return false;
  pendingQuestions.delete(requestId);
  const response: Record<string, { answers: string[] }> = {};
  pending.questions.forEach((question, index) => {
    const id = typeof question.id === "string" ? question.id : String(index);
    response[id] = { answers: answers[index] ?? [] };
  });
  pending.connection.respond(pending.rpcId, { answers: response });
  return true;
}
