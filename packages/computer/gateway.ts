import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getChannelComputerUse,
  getComputerGatewayConfig,
  ODE_CONFIG_FILE,
} from "@/config";
import type { AgentProviderId } from "@/shared/agent-provider";
import { log } from "@/utils";
import { createDeferred, type Deferred } from "@/core/runtime/helpers";
import { AgentBrowserDriver } from "./drivers/agent-browser";
import { OdeDesktopDriver } from "./drivers/desktop";
import { resolveAgentBrowserExecutable } from "./ode-app";
import {
  assertAllowedApp,
  assertAllowedOrigin,
  browserActionNeedsApproval,
  describeComputerAction,
  desktopActionNeedsApproval,
} from "./policy";
import { parseComputerToolInput } from "./tools";
import type {
  BrowserSnapshotState,
  ComputerContextRegistration,
  ComputerGatewayBinding,
  ComputerSessionEvent,
  ComputerToolName,
  ComputerToolResult,
  DesktopSnapshotState,
} from "./types";
import { isComputerProviderSupported } from "./types";

const ENV_CONTEXT_ID = "ODE_COMPUTER_CONTEXT_ID";
const ENV_GATEWAY_URL = "ODE_COMPUTER_GATEWAY_URL";
const ENV_GATEWAY_TOKEN = "ODE_COMPUTER_GATEWAY_TOKEN";
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

type ContextRuntime = ComputerContextRegistration & {
  token: string;
  browser?: AgentBrowserDriver;
  desktop?: OdeDesktopDriver;
  browserSnapshot?: BrowserSnapshotState;
  desktopSnapshot?: DesktopSnapshotState;
  revisionCounter: number;
  updatedAt: number;
};

type PendingApproval = {
  contextId: string;
  sessionId?: string;
  deferred: Deferred<boolean>;
  timer: ReturnType<typeof setTimeout>;
};

type RpcServer = {
  port: number;
  stop(closeActiveConnections?: boolean): void;
};

export class ComputerGateway {
  private readonly contexts = new Map<string, ContextRuntime>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private rpcServer?: RpcServer;
  private desktopQueue: Promise<void> = Promise.resolve();

  async createBinding(params: {
    channelId: string;
    threadId: string;
    cwd: string;
    providerId: AgentProviderId;
  }): Promise<ComputerGatewayBinding> {
    await this.pruneExpiredContexts();
    const global = getComputerGatewayConfig();
    const channel = getChannelComputerUse(params.channelId);
    const enabled = isComputerProviderSupported(params.providerId)
      && global.enabled
      && (channel.browser !== "off" || channel.desktop !== "off");
    if (!enabled) return { enabled: false, env: {} };
    const contextId = stableContextId(params.channelId, params.threadId, params.providerId);
    let context = this.contexts.get(contextId);
    if (!context) {
      context = {
        ...params,
        contextId,
        token: randomBytes(32).toString("base64url"),
        revisionCounter: 0,
        updatedAt: Date.now(),
      };
      this.contexts.set(contextId, context);
    } else {
      Object.assign(context, params, { updatedAt: Date.now() });
    }
    const url = await this.ensureRpcServer();
    return {
      enabled: true,
      contextId,
      env: {
        [ENV_CONTEXT_ID]: contextId,
        [ENV_GATEWAY_URL]: url,
        [ENV_GATEWAY_TOKEN]: context.token,
      },
    };
  }

  registerContext(registration: ComputerContextRegistration): void {
    const context = this.contexts.get(registration.contextId);
    if (!context) return;
    Object.assign(context, registration, { updatedAt: Date.now() });
  }

  registerSession(contextId: string | undefined, sessionId: string, publishEvent?: (event: ComputerSessionEvent) => void): void {
    if (!contextId) return;
    const context = this.contexts.get(contextId);
    if (!context) return;
    context.sessionId = sessionId;
    if (publishEvent) context.publishEvent = publishEvent;
    context.updatedAt = Date.now();
  }

  async invoke(contextId: string, name: string, rawInput: unknown): Promise<ComputerToolResult> {
    const context = this.contexts.get(contextId);
    if (!context) throw new Error("Ode Computer context is missing or expired");
    const input = parseComputerToolInput(name, rawInput);
    const startedAt = Date.now();
    try {
      const result = await this.invokeParsed(context, name as ComputerToolName, input);
      await this.audit(context, name, input, true, Date.now() - startedAt, undefined, result);
      return result;
    } catch (error) {
      await this.audit(context, name, input, false, Date.now() - startedAt, error);
      throw error;
    }
  }

  replyToApproval(params: { requestId: string; sessionId: string; answers: Array<Array<string>> }): boolean {
    const pending = this.pendingApprovals.get(params.requestId);
    if (!pending) return false;
    if (pending.sessionId && pending.sessionId !== params.sessionId) {
      throw new Error("Computer approval does not belong to this agent session");
    }
    this.pendingApprovals.delete(params.requestId);
    clearTimeout(pending.timer);
    const answer = params.answers.flat().join(" ").trim().toLowerCase();
    const allowed = /^(allow|approve|yes|ok|允许|同意|批准)(\b|\s|$)/i.test(answer);
    pending.deferred.resolve(allowed);
    return true;
  }

  async stop(): Promise<void> {
    for (const context of this.contexts.values()) {
      await context.browser?.close().catch(() => undefined);
    }
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.deferred.resolve(false);
    }
    this.pendingApprovals.clear();
    this.contexts.clear();
    this.rpcServer?.stop(true);
    this.rpcServer = undefined;
  }

  private async invokeParsed(
    context: ContextRuntime,
    name: ComputerToolName,
    input: Record<string, unknown>,
  ): Promise<ComputerToolResult> {
    const global = getComputerGatewayConfig();
    const channel = getChannelComputerUse(context.channelId);
    if (!global.enabled) throw new Error("Ode Computer Gateway is disabled globally");
    context.updatedAt = Date.now();

    if (name === "computer_session") {
      if (input.action === "close") {
        if ((input.surface === "all" || input.surface === "browser") && context.browser) {
          await context.browser.close().catch(() => undefined);
          context.browser = undefined;
          context.browserSnapshot = undefined;
        }
        if (input.surface === "all" || input.surface === "desktop") {
          context.desktop = undefined;
          context.desktopSnapshot = undefined;
        }
      }
      return {
        ok: true,
        data: {
          contextId: context.contextId,
          provider: context.providerId,
          browser: channel.browser,
          desktop: channel.desktop,
          browserSession: context.browser?.sessionName,
          browserRevision: context.browserSnapshot?.revision,
          desktopRevision: context.desktopSnapshot?.revision,
          allowedOrigins: channel.allowedOrigins,
          allowedApps: channel.allowedApps,
          approvalPolicy: channel.approvalPolicy,
        },
      };
    }

    if (name.startsWith("browser_")) {
      if (channel.browser === "off") throw new Error("Browser use is disabled for this channel");
      context.browser ??= new AgentBrowserDriver(
        context.contextId,
        resolveAgentBrowserExecutable(global.browserExecutable),
        global.commandTimeoutMs,
        global.browserHeaded,
        channel.browserProfile,
      );
      if (name === "browser_navigate") {
        assertAllowedOrigin(String(input.url), channel.allowedOrigins);
        const data = await context.browser.navigate(String(input.url));
        const currentUrl = await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        context.browserSnapshot = undefined;
        return { ok: true, data: { ...data, currentUrl } };
      }
      if (name === "browser_observe") {
        await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        const observed = await context.browser.observe({
          interactive: input.interactive !== false,
          includeUrls: input.includeUrls !== false,
          screenshot: input.screenshot === true,
          fullPage: input.fullPage === true,
        });
        const currentUrl = await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        const revision = this.nextRevision(context, "browser");
        const refs = isRecord(observed.data.refs) ? observed.data.refs as Record<string, Record<string, unknown>> : {};
        context.browserSnapshot = { revision, refs, url: currentUrl };
        return { ok: true, data: { ...observed.data, currentUrl, revision }, artifacts: observed.artifacts };
      }
      if (name === "browser_inspect") {
        await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        const data = await context.browser.inspect(input);
        const currentUrl = await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        return { ok: true, data: { ...data, currentUrl } };
      }
      if (name === "browser_act") {
        if (channel.browser !== "interact") throw new Error("Browser interaction is disabled for this channel");
        this.assertRevision(input.revision, context.browserSnapshot?.revision, "browser");
        const approvalRequired = browserActionNeedsApproval(input, context.browserSnapshot, channel.approvalPolicy);
        if (approvalRequired) {
          await this.requireApproval(context, name, input, global.approvalTimeoutMs);
        }
        context.browserSnapshot = undefined;
        const data = await context.browser.act(input);
        const currentUrl = await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
        return {
          ok: true,
          data: { ...data, currentUrl, requiresObserve: true, approvalRequired, approvalGranted: approvalRequired },
        };
      }
    }

    if (name.startsWith("desktop_")) {
      if (channel.desktop === "off") throw new Error("Desktop use is disabled for this channel");
      context.desktop ??= new OdeDesktopDriver(global.commandTimeoutMs);
      if (name === "desktop_observe") {
        const app = assertAllowedApp(typeof input.app === "string" ? input.app : undefined, channel.allowedApps);
        const observed = await this.withDesktopLock(() => context.desktop!.observe({
          app,
          annotate: input.annotate !== false,
          screenshot: input.screenshot !== false,
        }));
        const actualApp = typeof observed.data.application_name === "string" ? observed.data.application_name : app;
        assertAllowedApp(actualApp, channel.allowedApps);
        const snapshotId = String(observed.data.snapshot_id ?? "");
        if (!snapshotId) throw new Error("Ode desktop service did not return a snapshot_id");
        const elements: Record<string, Record<string, unknown>> = {};
        if (Array.isArray(observed.data.ui_elements)) {
          for (const raw of observed.data.ui_elements) {
            if (!isRecord(raw) || typeof raw.id !== "string") continue;
            elements[raw.id] = raw;
          }
        }
        const revision = this.nextRevision(context, "desktop");
        context.desktopSnapshot = { revision, snapshotId, app: actualApp, elements };
        return { ok: true, data: { ...observed.data, revision }, artifacts: observed.artifacts };
      }
      if (name === "desktop_act") {
        if (channel.desktop !== "control") throw new Error("Desktop control is disabled for this channel");
        this.assertRevision(input.revision, context.desktopSnapshot?.revision, "desktop");
        const app = assertAllowedApp(
          typeof input.app === "string" ? input.app : context.desktopSnapshot?.app,
          channel.allowedApps,
        );
        input.app = app;
        if (input.action === "open_url") assertAllowedOrigin(String(input.url), channel.allowedOrigins);
        const approvalRequired = desktopActionNeedsApproval(input, context.desktopSnapshot, channel.approvalPolicy);
        if (approvalRequired) {
          await this.requireApproval(context, name, input, global.approvalTimeoutMs);
        }
        const snapshotId = context.desktopSnapshot!.snapshotId;
        context.desktopSnapshot = undefined;
        const data = await this.withDesktopLock(() => context.desktop!.act(input, snapshotId));
        return {
          ok: true,
          data: { ...data, requiresObserve: true, approvalRequired, approvalGranted: approvalRequired },
        };
      }
    }

    if (name === "computer_wait") {
      if (input.surface === "desktop") {
        if (input.condition !== "time") throw new Error("Desktop wait currently supports condition=time only");
        await new Promise((resolve) => setTimeout(resolve, Number(input.timeoutMs)));
        return { ok: true, data: { waitedMs: input.timeoutMs } };
      }
      if (channel.browser === "off") throw new Error("Browser use is disabled for this channel");
      context.browser ??= new AgentBrowserDriver(
        context.contextId,
        resolveAgentBrowserExecutable(global.browserExecutable),
        global.commandTimeoutMs,
        global.browserHeaded,
        channel.browserProfile,
      );
      const data = await context.browser.wait(input);
      const currentUrl = await this.assertBrowserStillAllowed(context, channel.allowedOrigins);
      context.browserSnapshot = undefined;
      return { ok: true, data: { ...data, currentUrl, requiresObserve: true } };
    }

    throw new Error(`Unsupported Ode Computer tool: ${name}`);
  }

  private nextRevision(context: ContextRuntime, surface: "browser" | "desktop"): string {
    context.revisionCounter += 1;
    return `${surface === "browser" ? "b" : "d"}:${context.revisionCounter}:${randomUUID().slice(0, 8)}`;
  }

  private assertRevision(provided: unknown, current: string | undefined, surface: string): void {
    if (!current) throw new Error(`No current ${surface} observation. Observe before acting.`);
    if (provided !== current) throw new Error(`Stale ${surface} revision. Observe again before acting.`);
  }

  private async assertBrowserStillAllowed(context: ContextRuntime, allowedOrigins: string[]): Promise<string> {
    if (!context.browser) throw new Error("Browser session is not available");
    const current = await context.browser.currentUrl();
    if (typeof current.url !== "string" || !current.url) {
      throw new Error("Browser did not report its current URL");
    }
    try {
      assertAllowedOrigin(current.url, allowedOrigins);
      return current.url;
    } catch (error) {
      await context.browser.close().catch(() => undefined);
      context.browser = undefined;
      context.browserSnapshot = undefined;
      throw error;
    }
  }

  private async pruneExpiredContexts(): Promise<void> {
    const cutoff = Date.now() - CONTEXT_TTL_MS;
    const expired = Array.from(this.contexts.values()).filter((context) => context.updatedAt < cutoff);
    for (const context of expired) {
      await context.browser?.close().catch(() => undefined);
      this.contexts.delete(context.contextId);
    }
  }

  private async requireApproval(
    context: ContextRuntime,
    name: ComputerToolName,
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<void> {
    if (!context.publishEvent || !context.sessionId) {
      throw new Error("This computer action requires approval, but no active IM session can receive it");
    }
    const requestId = `ode-computer:${randomUUID()}`;
    const deferred = createDeferred<boolean>();
    const timer = setTimeout(() => {
      this.pendingApprovals.delete(requestId);
      deferred.resolve(false);
    }, timeoutMs);
    this.pendingApprovals.set(requestId, {
      contextId: context.contextId,
      sessionId: context.sessionId,
      deferred,
      timer,
    });
    context.publishEvent({
      type: "question.asked",
      properties: {
        id: requestId,
        sessionID: context.sessionId,
        odePermission: { permission: "computer_use", patterns: [name] },
        questions: [{
          header: "Computer",
          question: `Allow Ode Computer to ${describeComputerAction(name, input)}?`,
          options: [
            { label: "Allow once", description: "Run this action once." },
            { label: "Deny", description: "Do not run this action." },
          ],
          multiSelect: false,
          custom: false,
        }],
      },
    });
    const allowed = await deferred.promise;
    clearTimeout(timer);
    this.pendingApprovals.delete(requestId);
    context.publishEvent({
      type: allowed ? "question.replied" : "question.rejected",
      properties: {
        id: requestId,
        requestID: requestId,
        sessionID: context.sessionId,
      },
    });
    if (!allowed) throw new Error("Computer action was denied or approval timed out");
  }

  private async withDesktopLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.desktopQueue;
    let release!: () => void;
    this.desktopQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureRpcServer(): Promise<string> {
    if (this.rpcServer) return `http://127.0.0.1:${this.rpcServer.port}`;
    this.rpcServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/invoke") {
          return Response.json({ ok: false, error: "Not found" }, { status: 404 });
        }
        let body: { contextId?: unknown; name?: unknown; input?: unknown };
        try {
          body = await request.json() as typeof body;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        if (typeof body.contextId !== "string" || typeof body.name !== "string") {
          return Response.json({ ok: false, error: "contextId and name are required" }, { status: 400 });
        }
        const context = this.contexts.get(body.contextId);
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        if (!context || !secureEqual(token, context.token)) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }
        try {
          const result = await this.invoke(body.contextId, body.name, body.input);
          return Response.json({ ok: true, result });
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
        }
      },
    }) as RpcServer;
    return `http://127.0.0.1:${this.rpcServer.port}`;
  }

  private async audit(
    context: ContextRuntime,
    tool: string,
    input: Record<string, unknown>,
    ok: boolean,
    durationMs: number,
    error?: unknown,
    result?: ComputerToolResult,
  ): Promise<void> {
    const path = join(dirname(ODE_CONFIG_FILE), "computer-audit.jsonl");
    const record = {
      timestamp: new Date().toISOString(),
      contextId: context.contextId,
      channelId: context.channelId,
      threadId: context.threadId,
      sessionId: context.sessionId,
      provider: context.providerId,
      tool,
      argumentKeys: Object.keys(input).sort(),
      ok,
      durationMs,
      approvalRequired: result?.data?.approvalRequired,
      approvalGranted: result?.data?.approvalGranted,
      error: ok ? undefined : error instanceof Error ? error.message : String(error),
    };
    try {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (auditError) {
      log.warn("Failed to append Ode Computer audit record", { error: String(auditError) });
    }
  }
}

function stableContextId(channelId: string, threadId: string, providerId: AgentProviderId): string {
  const input = `${providerId}\0${channelId}\0${threadId}`;
  return `ocg_${new Bun.CryptoHasher("sha256").update(input).digest("hex").slice(0, 32)}`;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const computerGateway = new ComputerGateway();

export async function createComputerGatewayBinding(params: {
  channelId: string;
  threadId: string;
  cwd: string;
  providerId: AgentProviderId;
}): Promise<ComputerGatewayBinding> {
  return computerGateway.createBinding(params);
}

export function registerComputerContext(registration: ComputerContextRegistration): void {
  computerGateway.registerContext(registration);
}

export function registerComputerSession(
  contextId: string | undefined,
  sessionId: string,
  publishEvent?: (event: ComputerSessionEvent) => void,
): void {
  computerGateway.registerSession(contextId, sessionId, publishEvent);
}

export function replyToComputerApproval(params: {
  requestId: string;
  sessionId: string;
  answers: Array<Array<string>>;
}): boolean {
  return computerGateway.replyToApproval(params);
}

export const COMPUTER_GATEWAY_ENV = {
  contextId: ENV_CONTEXT_ID,
  url: ENV_GATEWAY_URL,
  token: ENV_GATEWAY_TOKEN,
} as const;
