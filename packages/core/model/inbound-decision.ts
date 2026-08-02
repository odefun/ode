export type InboundIgnoreReason =
  | "self_message"
  | "not_mentioned_and_inactive"
  | "not_thread_owner"
  | "empty_text";

export type InboundDecision =
  | { kind: "ignore"; reason: InboundIgnoreReason }
  | { kind: "stop" }
  | { kind: "message"; text: string; input: AgentInput };
import type { AgentInput } from "@/shared/agent-protocol";
