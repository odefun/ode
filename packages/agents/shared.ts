import type { AgentInput, OpenCodeMessageContext, OpenCodeOptions, PromptPart, SlackContext } from "./types";
import { renderAgentInputAsText } from "@/shared/agent-protocol";

export function buildSystemPrompt(slack?: SlackContext): string {
  if (!slack) return "";

  const platform = slack.platform ?? "slack";
  const lines = [
    "ODE RUNTIME CONTEXT:",
    `- Platform: ${platform}`,
    `- Channel: ${slack.channelId}`,
    `- Thread: ${slack.threadId}`,
    `- User: ${slack.userId}`,
    `- GitHub token available: ${slack.hasGitHubToken ? "yes" : "no"}`,
    "",
    "ODE CLI CAPABILITIES:",
    "- The `ode` binary is how you interact with the current IM thread outside of plain text output.",
    "- These commands auto-detect Slack / Discord / Lark from the `--channel` value; do not call platform APIs directly.",
    "- Upload files or screenshots: `ode send file <path> --channel <channelId> --thread <threadId> [--comment \"...\"] [--filename <name>] [--title <text>]`.",
    "- If the user asks for a screenshot, image, rendered design, or other local file, save it to the system temp folder and upload it with `ode send file` to the current thread.",
    "- Read thread messages: `ode messages get <threadId> --channel <channelId> [--limit N] [--json]`.",
    "- React to a message: `ode reaction add <messageId> --channel <channelId> --emoji <thumbsup|eyes|ok_hand> [--thread <threadId>]`.",
    "- Schedule one-time follow-up work: `ode task create --time <ISO8601> --channel <channelId> --message \"<prompt>\" [--thread <threadId>] [--agent <agentId>] [--run-now]`.",
    "- Schedule recurring work: `ode cron create --schedule \"<5-field cron>\" --channel <channelId> --message \"<prompt>\" [--title <title>] [--disabled] [--run-now]`.",
  ];

  const channelSystemMessage = slack.channelSystemMessage?.trim();
  if (channelSystemMessage) {
    lines.push("", "CHANNEL SYSTEM MESSAGE:", channelSystemMessage);
  }

  return lines.join("\n");
}

export function buildPromptParts(
  _channelId: string,
  input: AgentInput,
  _options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): PromptPart[] {
  const parts: PromptPart[] = [];

  if (context?.threadHistory) {
    parts.push({
      type: "text",
      text: `<thread-history>\n${context.threadHistory}\n</thread-history>`,
    });
  }

  parts.push(...input.parts);

  return parts;
}

export function buildPromptText(parts: PromptPart[]): string {
  return renderAgentInputAsText({ parts });
}

export function buildSystemWrappedPrompt(systemPrompt: string, prompt: string): string {
  const trimmedSystemPrompt = systemPrompt.trim();
  if (!trimmedSystemPrompt) return prompt;
  return `<system-prompt>\n${trimmedSystemPrompt}\n</system-prompt>\n\n${prompt}`;
}
