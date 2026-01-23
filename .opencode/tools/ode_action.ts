import { tool } from "@opencode-ai/plugin";
import { z } from "zod";

const ActionArgs = z.object({
  action: z.string().describe("Action name (e.g. post_message, add_reaction)"),
  channelId: z.string().describe("Slack channel ID"),
  threadId: z.string().optional().describe("Slack thread timestamp"),
  messageId: z.string().optional().describe("Slack message timestamp"),
  text: z.string().optional().describe("Message text"),
  emoji: z.string().optional().describe("Emoji name or :emoji:"),
  question: z.string().optional().describe("Question text"),
  options: z.array(z.string()).optional().describe("Button labels (2-5)"),
  limit: z.number().optional().describe("Thread history limit"),
  filePath: z.string().optional().describe("Absolute path to file for upload"),
  filename: z.string().optional().describe("Optional filename override"),
  title: z.string().optional().describe("Optional file title"),
  initialComment: z.string().optional().describe("Optional file comment"),
  userId: z.string().optional().describe("Slack user ID"),
});

export default tool({
  description: "Call Ode action API (Slack, future IM actions)",
  args: ActionArgs.shape,
  async execute(args) {
    const baseUrl =
      process.env.ODE_ACTION_API_URL ||
      "http://127.0.0.1:3030";
    const token = process.env.ODE_ACTION_API_TOKEN;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${baseUrl}/action`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Ode action failed (${response.status}): ${raw}`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
});
