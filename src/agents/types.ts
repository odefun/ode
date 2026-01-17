export interface OpenCodeMessage {
  text: string;
  messageType: "assistant" | "result" | "system" | "user" | "notify";
}

export interface OpenCodeOptions {
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export interface SlackContext {
  channelId: string;
  threadId: string;
  userId: string;
  threadHistory?: string;
}

export interface OpenCodeMessageContext {
  threadHistory?: string;
  slack?: SlackContext;
}

export interface OpenCodeSessionInfo {
  sessionId: string;
  created: boolean;
}

export type OpenCodeProgressHandler = (status: string) => void;

export type PromptPart = { type: "text"; text: string };
