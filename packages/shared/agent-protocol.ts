import type { AgentProviderId } from "./agent-provider";

export const ODE_RUN_EVENT_SCHEMA_VERSION = 1 as const;

export type AgentTransport =
  | "native-app-server"
  | "native-sdk"
  | "server-sdk"
  | "acp"
  | "cli-json";

export type InboundAttachmentKind = "image" | "text" | "document" | "binary";

/**
 * An IM attachment after Ode has downloaded it into its private local store.
 * Platform credentials and expiring remote URLs must never escape the IM
 * adapter; agent adapters consume only this stable local descriptor.
 */
export type InboundAttachment = Readonly<{
  id: string;
  sourcePlatform: "slack" | "discord" | "lark";
  sourceMessageId: string;
  filename: string;
  mimeType: string;
  size: number;
  localPath: string;
  sha256: string;
  kind: InboundAttachmentKind;
}>;

export type AgentInputPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "image";
      path: string;
      filename: string;
      mimeType: string;
      size: number;
    }>
  | Readonly<{
      type: "resource";
      path: string;
      filename: string;
      mimeType: string;
      size: number;
      text?: string;
    }>
  | Readonly<{
      type: "fileRef";
      path: string;
      filename: string;
      mimeType: string;
      size: number;
    }>;

export type AgentInput = Readonly<{
  parts: readonly AgentInputPart[];
}>;

export type AgentCapabilities = Readonly<{
  sessions: Readonly<{
    create: boolean;
    resume: boolean;
    load: boolean;
    list: boolean;
    delete: boolean;
    close: boolean;
    fork: boolean;
  }>;
  input: Readonly<{
    text: boolean;
    image: boolean;
    resource: boolean;
    fileRef: boolean;
  }>;
  events: Readonly<{
    message: boolean;
    reasoningSummary: boolean;
    plan: boolean;
    tool: boolean;
    command: boolean;
    fileDiff: boolean;
    usage: boolean;
  }>;
  interaction: Readonly<{
    approval: boolean;
    question: boolean;
    cancel: boolean;
  }>;
}>;

export type AgentSessionBinding = Readonly<{
  odeSessionId: string;
  providerId: AgentProviderId;
  transport: AgentTransport;
  nativeSessionId: string;
  protocolVersion?: string;
  capabilities: AgentCapabilities;
  createdAt: number;
  updatedAt: number;
}>;

export type OdeRunEventType =
  | "run.started"
  | "run.progress"
  | "run.completed"
  | "run.failed"
  | "message.delta"
  | "message.completed"
  | "reasoning.summary.delta"
  | "plan.updated"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "tool.failed"
  | "command.output.delta"
  | "file.diff.updated"
  | "approval.requested"
  | "approval.resolved"
  | "question.requested"
  | "question.resolved"
  | "usage.updated"
  | "attachment.received"
  | "provider.raw";

/**
 * Append-only event stored by the Ode runtime. `rawEvent` is deliberately
 * retained while adapters migrate so fixture replay and unknown future
 * provider events remain debuggable without leaking into renderers.
 */
export type OdeRunEvent = Readonly<{
  id: string;
  schemaVersion: typeof ODE_RUN_EVENT_SCHEMA_VERSION;
  timestamp: number;
  type: OdeRunEventType;
  providerId: AgentProviderId;
  sessionId: string;
  runId?: string;
  itemId?: string;
  data: Readonly<Record<string, unknown>>;
  rawEvent?: Readonly<Record<string, unknown>>;
}>;

export const LEGACY_AGENT_CAPABILITIES: AgentCapabilities = {
  sessions: {
    create: true,
    resume: true,
    load: false,
    list: false,
    delete: false,
    close: false,
    fork: false,
  },
  input: {
    text: true,
    image: false,
    resource: false,
    fileRef: true,
  },
  events: {
    message: true,
    reasoningSummary: false,
    plan: false,
    tool: true,
    command: false,
    fileDiff: false,
    usage: false,
  },
  interaction: {
    approval: false,
    question: false,
    cancel: true,
  },
};

export function createAgentInput(
  text: string,
  attachments: readonly InboundAttachment[] = []
): AgentInput {
  const parts: AgentInputPart[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: "text", text: trimmed });
  }

  for (const attachment of attachments) {
    const common = {
      path: attachment.localPath,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
    if (attachment.kind === "image") {
      parts.push({ type: "image", ...common });
    } else if (attachment.kind === "text" || attachment.kind === "document") {
      parts.push({ type: "resource", ...common });
    } else {
      parts.push({ type: "fileRef", ...common });
    }
  }

  return { parts };
}

export function getAgentInputText(input: AgentInput): string {
  return input.parts
    .filter((part): part is Extract<AgentInputPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

export function getAgentInputAttachments(
  input: AgentInput
): Array<Exclude<AgentInputPart, { type: "text" }>> {
  return input.parts.filter(
    (part): part is Exclude<AgentInputPart, { type: "text" }> => part.type !== "text"
  );
}

export function renderAgentInputAsText(input: AgentInput): string {
  const text = getAgentInputText(input);
  const attachments = getAgentInputAttachments(input);
  if (attachments.length === 0) return text;

  const attachmentLines = attachments.map((part) =>
    `- ${part.filename} (${part.mimeType}, ${part.size} bytes): ${part.path}`
  );
  const instruction = text || "Please inspect the attached files and continue based on the thread context.";
  return [
    instruction,
    "<attachments>",
    ...attachmentLines,
    "</attachments>",
  ].join("\n");
}
