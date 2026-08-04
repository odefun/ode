import type { AgentProviderId } from "@/shared/agent-provider";

export const COMPUTER_PROVIDER_IDS = ["opencode", "claudecode", "codex"] as const;

export function isComputerProviderSupported(providerId: AgentProviderId): boolean {
  return (COMPUTER_PROVIDER_IDS as readonly AgentProviderId[]).includes(providerId);
}

export type ComputerToolName =
  | "computer_session"
  | "browser_navigate"
  | "browser_observe"
  | "browser_act"
  | "browser_inspect"
  | "desktop_observe"
  | "desktop_act"
  | "computer_wait";

export type ComputerArtifact = {
  path: string;
  mimeType: string;
  kind: "screenshot";
};

export type ComputerToolResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  artifacts?: ComputerArtifact[];
};

export type ComputerSessionEvent = {
  type: string;
  properties: Record<string, unknown>;
};

export type ComputerContextRegistration = {
  contextId: string;
  channelId: string;
  threadId: string;
  sessionId?: string;
  cwd: string;
  providerId: AgentProviderId;
  publishEvent?: (event: ComputerSessionEvent) => void;
};

export type ComputerGatewayBinding = {
  enabled: boolean;
  contextId?: string;
  env: Record<string, string>;
};

export type BrowserSnapshotState = {
  revision: string;
  refs: Record<string, Record<string, unknown>>;
  url?: string;
};

export type DesktopSnapshotState = {
  revision: string;
  snapshotId: string;
  app?: string;
  elements: Record<string, Record<string, unknown>>;
};
