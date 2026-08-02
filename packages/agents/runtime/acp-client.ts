import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  PROTOCOL_VERSION,
  client,
  methods,
  ndJsonStream,
  type AgentCapabilities as AcpAgentCapabilities,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallContent,
} from "@agentclientprotocol/sdk";
import packageJson from "../../../package.json" with { type: "json" };
import type { AgentProviderId } from "@/shared/agent-provider";
import type {
  AgentCapabilities as OdeAgentCapabilities,
  AgentInputPart,
} from "@/shared/agent-protocol";
import { log } from "@/utils";
import type { OpenCodeMessage, OpenCodeOptions } from "../types";
import type { SessionEnvironment } from "./base";

const ACP_SETUP_TIMEOUT_MS = 15_000;
const ODE_CLIENT_VERSION = packageJson.version ?? "0.0.0";
const KNOWN_ACP_SESSION_UPDATES = new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
]);

type SessionEventPublisher = {
  publishSessionEvent(sessionId: string, event: unknown): void;
};

export type AcpLaunchConfig = {
  command: string;
  args: string[];
};

export type AcpSendParams = {
  providerId: AgentProviderId;
  providerName: string;
  launch: AcpLaunchConfig;
  channelId: string;
  sessionId: string;
  isNewSession: boolean;
  workingPath: string;
  environment: SessionEnvironment;
  parts: readonly AgentInputPart[];
  options?: OpenCodeOptions;
  publisher: SessionEventPublisher;
  onNativeSessionId?: (nativeSessionId: string) => void;
  onNegotiated?: (details: {
    protocolVersion: string;
    capabilities: OdeAgentCapabilities;
  }) => void;
  onFallback?: () => void;
  fallback: () => Promise<OpenCodeMessage[]>;
};

type ToolSnapshot = {
  id: string;
  name: string;
  title?: string;
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

type PendingAcpPermission = {
  providerId: AgentProviderId;
  sessionIds: Set<string>;
  options: PermissionOption[];
  settle: (outcome: RequestPermissionOutcome) => void;
};

const pendingAcpPermissions = new Map<string, PendingAcpPermission>();

export class AcpUnavailableError extends Error {
  constructor(providerName: string, cause: unknown) {
    super(`${providerName} ACP is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AcpUnavailableError";
    this.cause = cause;
  }
}

export function mapAcpCapabilities(
  capabilities: AcpAgentCapabilities | undefined
): OdeAgentCapabilities {
  const sessions = capabilities?.sessionCapabilities;
  return {
    sessions: {
      create: true,
      resume: sessions?.resume != null,
      load: capabilities?.loadSession === true,
      list: sessions?.list != null,
      delete: sessions?.delete != null,
      close: sessions?.close != null,
      fork: sessions?.fork != null,
    },
    input: {
      text: true,
      image: capabilities?.promptCapabilities?.image === true,
      resource: true,
      fileRef: true,
    },
    events: {
      message: true,
      reasoningSummary: true,
      plan: true,
      tool: true,
      command: false,
      fileDiff: false,
      usage: true,
    },
    interaction: {
      approval: true,
      question: false,
      cancel: true,
    },
  };
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeEnvironment(environment: SessionEnvironment): string {
  return Object.keys(environment)
    .sort()
    .map((key) => `${key}=${environment[key]}`)
    .join("\n");
}

function withTimeoutSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ACP setup timed out")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function readTextContent(content: ContentBlock): string {
  if (content.type === "text") return content.text;
  if (content.type === "resource" && "text" in content.resource) return content.resource.text;
  return "";
}

export interface AcpTextAccumulator {
  messageId?: string;
  text: string;
}

export function appendAcpContentChunk(
  current: AcpTextAccumulator,
  update: { content: ContentBlock; messageId?: string | null }
): AcpTextAccumulator {
  const chunk = readTextContent(update.content);
  if (!chunk) return current;
  const messageId = update.messageId || undefined;
  const startsNewMessage = !!messageId && !!current.messageId && messageId !== current.messageId;
  return {
    messageId: messageId ?? current.messageId,
    text: `${startsNewMessage ? "" : current.text}${chunk}`,
  };
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function stringifyAcpToolContent(content: readonly ToolCallContent[] | null | undefined): string | undefined {
  const lines = (content ?? []).flatMap((entry) => {
    if (entry.type === "content") {
      const text = readTextContent(entry.content).trim();
      if (text) return [text];
      if (entry.content.type === "resource_link") {
        return [`Resource: ${entry.content.name} (${entry.content.uri})`];
      }
      return [];
    }
    if (entry.type === "diff") return [`Changed ${entry.path}`];
    if (entry.type === "terminal") return [`Terminal: ${entry.terminalId}`];
    return [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function normalizeToolStatus(
  status: "pending" | "in_progress" | "completed" | "failed" | null | undefined
): ToolSnapshot["status"] {
  if (status === "in_progress") return "running";
  if (status === "failed") return "error";
  return status ?? "pending";
}

function flattenConfigOptions(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => {
    if ("group" in entry) return entry.options;
    return [entry];
  });
}

function findConfigValue(
  options: SessionConfigOption[] | null | undefined,
  category: string,
  requested: string | undefined
): { configId: string; value: string } | undefined {
  const target = requested?.trim().toLowerCase();
  if (!target) return undefined;
  for (const option of options ?? []) {
    const id = option.id.toLowerCase();
    const name = option.name.toLowerCase();
    if (option.category !== category && !id.includes(category) && !name.includes(category)) continue;
    const match = flattenConfigOptions(option).find((candidate) => {
      const value = candidate.value.toLowerCase();
      const label = candidate.name.toLowerCase();
      return value === target || label === target || value.endsWith(`/${target}`);
    });
    if (match) return { configId: option.id, value: match.value };
  }
  return undefined;
}

async function inputPartToAcpBlock(
  part: AgentInputPart,
  capabilities: AcpAgentCapabilities | undefined
): Promise<ContentBlock> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }

  const uri = pathToFileURL(part.path).href;
  if (part.type === "image" && capabilities?.promptCapabilities?.image) {
    const bytes = await Bun.file(part.path).arrayBuffer();
    return {
      type: "image",
      mimeType: part.mimeType,
      data: Buffer.from(bytes).toString("base64"),
    };
  }

  if (part.type === "resource" && capabilities?.promptCapabilities?.embeddedContext) {
    if (part.text !== undefined) {
      return {
        type: "resource",
        resource: { uri, mimeType: part.mimeType, text: part.text },
      };
    }
    const file = Bun.file(part.path);
    if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
      return {
        type: "resource",
        resource: { uri, mimeType: part.mimeType, text: await file.text() },
      };
    }
    return {
      type: "resource",
      resource: {
        uri,
        mimeType: part.mimeType,
        blob: Buffer.from(await file.arrayBuffer()).toString("base64"),
      },
    };
  }

  return {
    type: "resource_link",
    uri,
    name: part.filename,
    mimeType: part.mimeType,
    size: part.size,
  };
}

export async function buildAcpPrompt(
  parts: readonly AgentInputPart[],
  capabilities: AcpAgentCapabilities | undefined
): Promise<ContentBlock[]> {
  return Promise.all(parts.map((part) => inputPartToAcpBlock(part, capabilities)));
}

export function prependSystemPrompt(
  parts: readonly AgentInputPart[],
  systemPrompt: string
): AgentInputPart[] {
  const trimmed = systemPrompt.trim();
  if (!trimmed) return [...parts];
  return [
    { type: "text", text: `<system-prompt>\n${trimmed}\n</system-prompt>` },
    ...parts,
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactPermissionDetail(value: unknown, maxLength = 320): string | undefined {
  const text = stringifyUnknown(value)?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function buildAcpPermissionQuestion(params: {
  providerName: string;
  requestId: string;
  sessionId: string;
  request: RequestPermissionRequest;
}): Record<string, unknown> {
  const tool = params.request.toolCall;
  const title = tool.title || tool.name || tool.kind || "use a tool";
  const detail = compactPermissionDetail(tool.rawInput);
  const locations = tool.locations?.map((location) => location.path).filter(Boolean).join(", ");
  const suffix = [detail, locations ? `Locations: ${locations}` : undefined]
    .filter(Boolean)
    .join("\n");
  return {
    type: "question.asked",
    properties: {
      id: params.requestId,
      sessionID: params.sessionId,
      questions: [{
        header: "Permission",
        question: `${params.providerName} wants permission to ${title}.${suffix ? `\n${suffix}` : ""}`,
        options: params.request.options.map((option) => ({
          label: option.name,
          description: option.kind.replaceAll("_", " "),
        })),
        multiple: false,
        custom: false,
      }],
    },
  };
}

function normalizePermissionChoice(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

export function selectAcpPermissionOutcome(
  options: readonly PermissionOption[],
  answers: Array<Array<string>>
): RequestPermissionOutcome {
  const answer = answers.flat().map((value) => value.trim()).find(Boolean);
  if (!answer) return { outcome: "cancelled" };
  const normalized = normalizePermissionChoice(answer);
  const selected = options.find((option) => {
    const aliases = [
      option.optionId,
      option.name,
      option.kind,
      option.kind.replaceAll("_", " "),
    ];
    return aliases.some((alias) => normalizePermissionChoice(alias) === normalized);
  });
  return selected
    ? { outcome: "selected", optionId: selected.optionId }
    : { outcome: "cancelled" };
}

export function scopeAcpSessionEvent(event: unknown, sessionId: string): unknown {
  const record = asRecord(event);
  const properties = asRecord(record?.properties);
  if (!record || !properties) return event;
  if (record.type === "question.asked" || record.type === "question.replied" || record.type === "question.rejected") {
    return { ...record, properties: { ...properties, sessionID: sessionId } };
  }
  if (record.type !== "message.part.updated") return event;
  const part = asRecord(properties.part);
  if (!part) return event;
  return {
    ...record,
    properties: {
      ...properties,
      part: { ...part, sessionID: sessionId },
    },
  };
}

export async function replyToAcpQuestion(params: {
  providerId: AgentProviderId;
  sessionId: string;
  requestId: string;
  answers: Array<Array<string>>;
}): Promise<void> {
  const pending = pendingAcpPermissions.get(params.requestId);
  if (!pending || pending.providerId !== params.providerId || !pending.sessionIds.has(params.sessionId)) {
    throw new Error(`No pending ACP permission request found: ${params.requestId}`);
  }
  pending.settle(selectAcpPermissionOutcome(pending.options, params.answers));
}

class AcpAgentConnection {
  readonly aliases = new Set<string>();
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private context?: ClientContext;
  private capabilities?: AcpAgentCapabilities;
  private protocolVersion = String(PROTOCOL_VERSION);
  private nativeSessionId?: string;
  private stderr = "";
  private assistantText = "";
  private assistantMessageId?: string;
  private reasoningText = "";
  private reasoningMessageId?: string;
  private readonly tools = new Map<string, ToolSnapshot>();
  private readonly pendingPermissionIds = new Set<string>();
  private readonly unknownUpdateTypes = new Set<string>();

  constructor(
    private readonly params: Omit<AcpSendParams, "fallback" | "parts" | "options">,
    readonly environmentKey: string
  ) {
    this.aliases.add(params.sessionId);
  }

  get sessionId(): string | undefined {
    return this.nativeSessionId;
  }

  get isAlive(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  get negotiated(): { protocolVersion: string; capabilities: OdeAgentCapabilities } {
    return {
      protocolVersion: this.protocolVersion,
      capabilities: mapAcpCapabilities(this.capabilities),
    };
  }

  private publish(event: unknown): void {
    for (const alias of this.aliases) {
      this.params.publisher.publishSessionEvent(alias, scopeAcpSessionEvent(event, alias));
    }
  }

  private publishRaw(notification: SessionNotification): void {
    const updateType = typeof (notification.update as { sessionUpdate?: unknown }).sessionUpdate === "string"
      ? String((notification.update as { sessionUpdate: string }).sessionUpdate)
      : "unknown";
    const protocolKnown = KNOWN_ACP_SESSION_UPDATES.has(updateType);
    if (!protocolKnown && !this.unknownUpdateTypes.has(updateType)) {
      this.unknownUpdateTypes.add(updateType);
      log.warn("Unknown ACP session update", {
        provider: this.params.providerId,
        updateType,
        protocolVersion: this.protocolVersion,
      });
    }
    this.publish({
      type: `${this.params.providerId}.acp.${updateType}`,
      properties: {
        notification,
        update: notification.update,
        protocolKnown,
        protocolLabel: `ACP ${updateType}`,
      },
    });
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (request.options.length === 0) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = [
      "acp",
      this.params.providerId,
      request.sessionId,
      request.toolCall.toolCallId,
      crypto.randomUUID(),
    ].join(":");
    this.publish(buildAcpPermissionQuestion({
      providerName: this.params.providerName,
      requestId,
      sessionId: this.nativeSessionId ?? this.params.sessionId,
      request,
    }));
    this.publish({
      type: "session.status",
      properties: { status: `Waiting for approval: ${request.toolCall.title || request.toolCall.name || "tool"}` },
    });

    return new Promise<RequestPermissionResponse>((resolve) => {
      let settled = false;
      const settle = (outcome: RequestPermissionOutcome) => {
        if (settled) return;
        settled = true;
        pendingAcpPermissions.delete(requestId);
        this.pendingPermissionIds.delete(requestId);
        this.publish({
          type: outcome.outcome === "cancelled" ? "question.rejected" : "question.replied",
          properties: { id: requestId, sessionID: this.nativeSessionId ?? this.params.sessionId },
        });
        resolve({ outcome });
      };
      this.pendingPermissionIds.add(requestId);
      pendingAcpPermissions.set(requestId, {
        providerId: this.params.providerId,
        sessionIds: this.aliases,
        options: request.options,
        settle,
      });
    });
  }

  private cancelPendingPermissions(): void {
    for (const requestId of [...this.pendingPermissionIds]) {
      pendingAcpPermissions.get(requestId)?.settle({ outcome: "cancelled" });
    }
  }

  private publishText(type: "text" | "reasoning", text: string): void {
    this.publish({
      type: "message.part.updated",
      properties: {
        part: {
          id: type === "text" ? "acp-assistant" : "acp-reasoning",
          sessionID: this.nativeSessionId,
          type,
          text,
        },
      },
    });
  }

  private publishTool(tool: ToolSnapshot): void {
    this.publish({
      type: "message.part.updated",
      properties: {
        part: {
          id: tool.id,
          sessionID: this.nativeSessionId,
          type: "tool",
          tool: tool.name,
          state: {
            status: tool.status,
            title: tool.title,
            input: tool.input,
            output: tool.output,
            error: tool.error,
            metadata: tool.metadata,
          },
        },
      },
    });
  }

  private applyUpdate(update: SessionUpdate): void {
    if (update.sessionUpdate === "agent_message_chunk") {
      const next = appendAcpContentChunk({
        messageId: this.assistantMessageId,
        text: this.assistantText,
      }, update);
      if (next.text !== this.assistantText) {
        this.assistantMessageId = next.messageId;
        this.assistantText = next.text;
        this.publishText("text", this.assistantText);
      }
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      const next = appendAcpContentChunk({
        messageId: this.reasoningMessageId,
        text: this.reasoningText,
      }, update);
      if (next.text !== this.reasoningText) {
        this.reasoningMessageId = next.messageId;
        this.reasoningText = next.text;
        this.publishText("reasoning", this.reasoningText);
      }
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      const contentOutput = stringifyAcpToolContent(update.content);
      const tool: ToolSnapshot = {
        id: update.toolCallId,
        name: update.name || update.title || update.kind || "tool",
        title: update.title,
        status: normalizeToolStatus(update.status),
        input: update.rawInput && typeof update.rawInput === "object"
          ? update.rawInput as Record<string, unknown>
          : undefined,
        output: stringifyUnknown(update.rawOutput) ?? contentOutput,
        metadata: update.locations || update.content
          ? { locations: update.locations, kind: update.kind, content: update.content }
          : undefined,
      };
      this.tools.set(tool.id, tool);
      this.publishTool(tool);
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const previous = this.tools.get(update.toolCallId);
      const output = stringifyUnknown(update.rawOutput) ?? stringifyAcpToolContent(update.content);
      const status = update.status ? normalizeToolStatus(update.status) : previous?.status ?? "pending";
      const tool: ToolSnapshot = {
        id: update.toolCallId,
        name: update.name || previous?.name || update.title || update.kind || "tool",
        title: update.title ?? previous?.title,
        status,
        input: update.rawInput && typeof update.rawInput === "object"
          ? update.rawInput as Record<string, unknown>
          : previous?.input,
        output: status === "error" ? previous?.output : output ?? previous?.output,
        error: status === "error" ? output ?? previous?.error : previous?.error,
        metadata: update.locations || update.content
          ? { ...previous?.metadata, locations: update.locations, kind: update.kind, content: update.content }
          : previous?.metadata,
      };
      this.tools.set(tool.id, tool);
      this.publishTool(tool);
      return;
    }
    if (update.sessionUpdate === "plan") {
      this.publish({ type: "todo.updated", properties: { items: update.entries } });
      return;
    }
    if (update.sessionUpdate === "plan_update") {
      if (update.plan.type === "items") {
        this.publish({ type: "todo.updated", properties: { items: update.plan.entries } });
      } else if (update.plan.type === "markdown") {
        this.publish({
          type: "message.part.updated",
          properties: {
            part: {
              id: `acp-plan-${update.plan.planId}`,
              sessionID: this.nativeSessionId,
              type: "reasoning",
              text: update.plan.content,
            },
          },
        });
      } else {
        this.publish({ type: "session.updated", properties: { plan: update.plan } });
      }
      return;
    }
    if (update.sessionUpdate === "plan_removed") {
      this.publish({ type: "todo.updated", properties: { items: [], planId: update.planId } });
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      this.publish({
        type: "session.updated",
        properties: { availableCommands: update.availableCommands },
      });
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      this.publish({
        type: "session.updated",
        properties: { mode: update.currentModeId },
      });
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.publish({
        type: "session.updated",
        properties: { configOptions: update.configOptions },
      });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      this.publish({
        type: "message.updated",
        properties: { info: { usage: update } },
      });
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      this.publish({ type: "session.updated", properties: update });
      return;
    }

    const updateType = typeof (update as { sessionUpdate?: unknown }).sessionUpdate === "string"
      ? String((update as { sessionUpdate: string }).sessionUpdate)
      : "unknown";
    if (!KNOWN_ACP_SESSION_UPDATES.has(updateType)) {
      this.publish({
        type: "session.status",
        properties: { status: `${this.params.providerName} integration update required: ACP ${updateType}` },
      });
    }
  }

  private async spawnAndConnect(): Promise<void> {
    const child = spawn(this.params.launch.command, this.params.launch.args, {
      cwd: this.params.workingPath,
      env: {
        ...process.env,
        ...this.params.environment,
        PWD: this.params.workingPath,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${Buffer.from(chunk).toString("utf8")}`.slice(-16_000);
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    const app = client({ name: "Ode" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.requestPermission(params))
      .onNotification(methods.client.session.update, ({ params }) => {
        this.publishRaw(params);
        this.applyUpdate(params.update);
      });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    );
    this.connection = app.connect(stream);
    this.context = this.connection.agent;
  }

  async initialize(): Promise<void> {
    try {
      await this.spawnAndConnect();
      const timeout = withTimeoutSignal(ACP_SETUP_TIMEOUT_MS);
      try {
        const response = await this.context!.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            terminal: false,
            plan: {},
          },
          clientInfo: { name: "Ode", version: ODE_CLIENT_VERSION },
        }, { cancellationSignal: timeout.signal });
        this.capabilities = response.agentCapabilities;
        this.protocolVersion = String(response.protocolVersion);
      } finally {
        timeout.dispose();
      }
    } catch (error) {
      this.close();
      throw new AcpUnavailableError(this.params.providerName, this.stderr.trim() || error);
    }
  }

  async startOrLoad(): Promise<{
    nativeSessionId: string;
    configOptions?: SessionConfigOption[] | null;
    modes?: SessionModeState | null;
  }> {
    if (!this.context) throw new AcpUnavailableError(this.params.providerName, "not initialized");
    try {
      const timeout = withTimeoutSignal(ACP_SETUP_TIMEOUT_MS);
      try {
        if (this.params.isNewSession) {
          const response = await this.context.request(methods.agent.session.new, {
            cwd: this.params.workingPath,
            mcpServers: [],
          }, { cancellationSignal: timeout.signal });
          this.nativeSessionId = response.sessionId;
          this.aliases.add(response.sessionId);
          return {
            nativeSessionId: response.sessionId,
            configOptions: response.configOptions,
            modes: response.modes,
          };
        }

        if (!this.capabilities?.loadSession) {
          throw new Error("agent does not advertise session/load");
        }
        const response = await this.context.request(methods.agent.session.load, {
          sessionId: this.params.sessionId,
          cwd: this.params.workingPath,
          mcpServers: [],
        }, { cancellationSignal: timeout.signal });
        this.nativeSessionId = this.params.sessionId;
        return {
          nativeSessionId: this.params.sessionId,
          configOptions: response?.configOptions,
          modes: response?.modes,
        };
      } finally {
        timeout.dispose();
      }
    } catch (error) {
      this.close();
      throw new AcpUnavailableError(this.params.providerName, this.stderr.trim() || error);
    }
  }

  async configure(
    options: OpenCodeOptions | undefined,
    configOptions: SessionConfigOption[] | null | undefined,
    modes: SessionModeState | null | undefined
  ): Promise<void> {
    if (!this.context || !this.nativeSessionId) return;

    const model = findConfigValue(configOptions, "model", options?.model?.modelID);
    if (model) {
      await this.context.request(methods.agent.session.setConfigOption, {
        sessionId: this.nativeSessionId,
        configId: model.configId,
        value: model.value,
      }).catch((error) => {
        log.warn(`${this.params.providerName} ACP could not select requested model`, {
          model: options?.model?.modelID,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const effort = findConfigValue(configOptions, "thought_level", options?.reasoningEffort);
    if (effort) {
      await this.context.request(methods.agent.session.setConfigOption, {
        sessionId: this.nativeSessionId,
        configId: effort.configId,
        value: effort.value,
      }).catch(() => {});
    }

    if (options?.agent?.trim().toLowerCase() === "plan") {
      // ACP modes are agent-defined, so discover the plan mode instead of
      // assuming a provider-specific identifier.
      const planMode = modes?.availableModes.find((mode) =>
        mode.id.toLowerCase() === "plan" || mode.name.toLowerCase() === "plan"
      );
      if (planMode) {
        await this.context.request(methods.agent.session.setMode, {
          sessionId: this.nativeSessionId,
          modeId: planMode.id,
        }).catch(() => {});
      } else {
        const planConfig = findConfigValue(configOptions, "mode", "plan");
        if (planConfig) {
          await this.context.request(methods.agent.session.setConfigOption, {
            sessionId: this.nativeSessionId,
            configId: planConfig.configId,
            value: planConfig.value,
          }).catch(() => {});
        }
      }
    }
  }

  async prompt(parts: readonly AgentInputPart[]): Promise<OpenCodeMessage[]> {
    if (!this.context || !this.nativeSessionId) {
      throw new Error(`${this.params.providerName} ACP session is not ready`);
    }
    this.assistantText = "";
    this.assistantMessageId = undefined;
    this.reasoningText = "";
    this.reasoningMessageId = undefined;
    this.tools.clear();
    this.publish({ type: "session.status", properties: { status: { type: "busy" } } });
    try {
      const prompt = await buildAcpPrompt(parts, this.capabilities);
      const response = await this.context.request(methods.agent.session.prompt, {
        sessionId: this.nativeSessionId,
        prompt,
      });
      if (response.usage) {
        this.publish({ type: "message.updated", properties: { info: { usage: response.usage } } });
      }
      const text = this.assistantText.trim();
      if (!text && response.stopReason !== "cancelled") {
        return [{
          text: `${this.params.providerName} completed without textual output.`,
          messageType: "assistant",
        }];
      }
      return text ? [{ text, messageType: "assistant" }] : [];
    } finally {
      this.publish({ type: "session.status", properties: { status: { type: "idle" } } });
    }
  }

  async cancel(): Promise<boolean> {
    if (!this.context || !this.nativeSessionId || !this.isAlive) return false;
    this.cancelPendingPermissions();
    await this.context.notify(methods.agent.session.cancel, { sessionId: this.nativeSessionId });
    return true;
  }

  close(): void {
    this.cancelPendingPermissions();
    this.connection?.close();
    this.connection = undefined;
    this.context = undefined;
    if (this.child) {
      const child = this.child;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2_000);
        forceKill.unref();
      }
    }
    this.child = undefined;
  }
}

class AcpConnectionPool {
  private readonly connections = new Map<string, AcpAgentConnection>();
  private readonly locks = new Map<string, Promise<unknown>>();

  private key(providerId: AgentProviderId, sessionId: string): string {
    return `${providerId}:${sessionId}`;
  }

  private find(providerId: AgentProviderId, sessionId: string): AcpAgentConnection | undefined {
    return this.connections.get(this.key(providerId, sessionId));
  }

  private register(providerId: AgentProviderId, connection: AcpAgentConnection): void {
    for (const alias of connection.aliases) {
      this.connections.set(this.key(providerId, alias), connection);
    }
  }

  async send(params: Omit<AcpSendParams, "fallback">): Promise<OpenCodeMessage[]> {
    const lockKey = this.key(params.providerId, params.sessionId);
    const previous = this.locks.get(lockKey);
    if (previous) await previous.catch(() => {});

    const operation = this.sendUnlocked(params);
    this.locks.set(lockKey, operation);
    try {
      return await operation;
    } finally {
      if (this.locks.get(lockKey) === operation) this.locks.delete(lockKey);
    }
  }

  private async sendUnlocked(params: Omit<AcpSendParams, "fallback">): Promise<OpenCodeMessage[]> {
    const environmentKey = normalizeEnvironment(params.environment);
    let connection = this.find(params.providerId, params.sessionId);
    if (connection && (!connection.isAlive || connection.environmentKey !== environmentKey)) {
      connection.close();
      connection = undefined;
    }

    if (!connection) {
      connection = new AcpAgentConnection(params, environmentKey);
      await connection.initialize();
      const session = await connection.startOrLoad();
      await connection.configure(params.options, session.configOptions, session.modes);
      this.register(params.providerId, connection);
      params.onNativeSessionId?.(session.nativeSessionId);
      params.onNegotiated?.(connection.negotiated);
    }

    return connection.prompt(params.parts);
  }

  async cancel(providerId: AgentProviderId, sessionId: string): Promise<boolean> {
    return await this.find(providerId, sessionId)?.cancel() ?? false;
  }

  close(providerId?: AgentProviderId): void {
    const unique = new Set<AcpAgentConnection>();
    for (const [key, connection] of this.connections) {
      if (!providerId || key.startsWith(`${providerId}:`)) unique.add(connection);
    }
    for (const connection of unique) connection.close();
    for (const key of [...this.connections.keys()]) {
      if (!providerId || key.startsWith(`${providerId}:`)) this.connections.delete(key);
    }
  }
}

const pool = new AcpConnectionPool();

export async function sendMessageViaAcp(params: AcpSendParams): Promise<OpenCodeMessage[]> {
  const providerFlag = `ODE_${params.providerId.toUpperCase()}_LEGACY_CLI`;
  if (isEnabled(process.env.ODE_ACP_DISABLED) || isEnabled(process.env[providerFlag])) {
    params.onFallback?.();
    return params.fallback();
  }

  try {
    return await pool.send(params);
  } catch (error) {
    if (!(error instanceof AcpUnavailableError)) throw error;
    log.warn(`${params.providerName} ACP setup failed; using the existing CLI transport`, {
      error: error.message,
    });
    params.onFallback?.();
    return params.fallback();
  }
}

export async function cancelAcpSession(providerId: AgentProviderId, sessionId: string): Promise<boolean> {
  return pool.cancel(providerId, sessionId);
}

export function stopAcpProvider(providerId?: AgentProviderId): void {
  pool.close(providerId);
}
