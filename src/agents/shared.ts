import {
  getChannelAgentsMd,
  getChannelAgentInstructions,
} from "../storage/settings";
import type { OpenCodeMessageContext, OpenCodeOptions, PromptPart, SlackContext } from "./types";

export function buildSlackSystemPrompt(slack?: SlackContext): string {
  const lines = [
    "COMMUNICATION STYLE:",
    "- Be concise and conversational - this is chat, not documentation",
    "- Use short paragraphs, avoid walls of text",
    "- Get straight to the point",
    "",
    "MESSAGE BREVITY:",
    "- Prefer short results over step-by-step narration",
    "- Skip tool call labels like ':arrow_forward: bash'",
    "- If listing tasks, keep it compact",
    "",
    "PROGRESS CHECKLIST:",
    "- Share a short checklist of what you're doing",
    "- Mention searches once with a result count if known",
    "- List edits with the file path and a brief why",
    "",
    "SLACK CONTEXT:",
  ];

  if (slack) {
    lines.push(`- Channel: ${slack.channelId}`);
    lines.push(`- Thread: ${slack.threadId}`);
    lines.push(`- User: <@${slack.userId}>`);
  }

  lines.push("");
  lines.push("SLACK ACTIONS:");
  if (slack?.hasCustomSlackTool) {
    lines.push("- Use `ode_action` tool for Slack actions (messages, reactions, thread history, questions, uploads).");
  } else {
    const baseUrl = slack?.odeSlackApiUrl ?? "<ODE_ACTION_API_URL>";
    lines.push("- Use bash + curl to call the Ode Slack API.");
    lines.push(`- Endpoint: ${baseUrl}/action`);
    lines.push("- Payload: {\"action\":\"post_message\",\"channelId\":\"...\",\"threadId\":\"...\",\"messageId\":\"...\",\"text\":\"...\"}");
  }
  lines.push("- Supported actions: post_message, add_reaction, get_thread_messages, ask_user, get_user_info, upload_file.");
  lines.push("- Required fields: channelId; threadId for thread actions; messageId for reactions; userId for get_user_info.");
  lines.push("- You can use any tool available via bash, curl");
  lines.push("");
  lines.push("IMPORTANT: Your text output is automatically posted to Slack.");
  lines.push("- When asking the user to choose options, you can send an ask_user Slack action, do NOT also output text - the buttons are enough.");
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
