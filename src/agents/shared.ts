import {
  getChannelAgentsMd,
  getChannelAgentInstructions,
} from "../storage/settings";
import type { OpenCodeMessageContext, OpenCodeOptions, PromptPart, SlackContext } from "./types";

export function buildSlackSystemPrompt(slack?: SlackContext): string {
  return '';
  const lines = [
    "You are running as a Slack bot. Keep these behaviors in mind:",
    "",
    "COMMUNICATION STYLE:",
    "- Be concise and conversational - this is chat, not documentation",
    "- Use short paragraphs, avoid walls of text",
    "- Skip unnecessary preamble like 'I'll help you with that'",
    "- Get straight to the point",
    "",
    "MESSAGE BREVITY:",
    "- Keep replies to 1-3 short lines when possible",
    "- Prefer short results over step-by-step narration",
    "- Skip tool call labels like ':arrow_forward: bash'",
    "- If listing tasks, keep it compact",
    "",
    "PROGRESS CHECKLIST:",
    "- Share a short checklist of what you're doing",
    "- Mention searches once with a result count if known",
    "- Do not list file reads",
    "- List edits with the file path and a brief why",
    "- Avoid raw tool names or bare file paths",
    "",
    "SLACK CONTEXT:",
  ];

  if (slack) {
    lines.push(`- Channel: ${slack.channelId}`);
    lines.push(`- Thread: ${slack.threadId}`);
    lines.push(`- User: <@${slack.userId}>`);
  }

  lines.push("");
  lines.push("SLACK TOOLS (via MCP) - use these when appropriate:");
  lines.push("- slack_ask_user: Show buttons to get user input or confirmation");
  lines.push("- slack_get_thread_messages: Get earlier messages in this thread");
  lines.push("- slack_add_reaction: React to a message with an emoji");
  lines.push("- slack_get_user_info: Look up info about a Slack user");
  lines.push("");
  lines.push("IMPORTANT: Your text output is automatically posted to Slack.");
  lines.push("- If you use slack_ask_user, do NOT also output text - the buttons are enough.");
  lines.push("- Only output text OR use a messaging tool, never both.");
  lines.push("");
  lines.push("FORMATTING:");
  lines.push("- Slack uses *bold* and _italic_ (not **bold** or *italic*)");
  lines.push("- Use ` for inline code and ``` for code blocks");
  lines.push("- Keep responses readable on mobile screens");
  lines.push("");
  lines.push("TASK LISTS:");
  lines.push("- When sharing tasks, put each item on its own line");
  lines.push("- Use four states: ☐ not started, 🔄 in progress, ✅ done, 🚫 cancelled");
  lines.push("- If you include a task list, keep it at the top of the response");

  return lines.join("\n");
}

export function buildPromptParts(
  channelId: string,
  message: string,
  options?: OpenCodeOptions,
  context?: OpenCodeMessageContext
): PromptPart[] {
  const parts: PromptPart[] = [];

  const agent = options?.agent;
  const agentsMd = getChannelAgentsMd(channelId);
  const agentInstructions =
    agent === "plan" || agent === "build"
      ? getChannelAgentInstructions(channelId, agent)
      : null;
  const combinedInstructions = [agentsMd, agentInstructions]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n\n");

  if (combinedInstructions) {
    parts.push({
      type: "text",
      text: `<channel-instructions>\n${combinedInstructions}\n</channel-instructions>`,
    });
  }

  if (context?.threadHistory) {
    parts.push({
      type: "text",
      text: `<thread-history>\n${context.threadHistory}\n</thread-history>`,
    });
  }

  parts.push({ type: "text", text: message });

  return parts;
}

export function buildPromptText(parts: PromptPart[]): string {
  return parts.map((part) => part.text).join("\n\n");
}
