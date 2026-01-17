#!/usr/bin/env bun
/**
 * MCP Server for Slack tools
 * Exposes Slack functionality to OpenCode via the Model Context Protocol
 */

import * as readline from "readline";

// Types for MCP protocol
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Get Slack client from environment or .env file
let SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// If not in env, try to load from .env file
if (!SLACK_BOT_TOKEN) {
  try {
    const envPath = "/root/ode/.env";
    const envContent = require("fs").readFileSync(envPath, "utf-8");
    const match = envContent.match(/^SLACK_BOT_TOKEN=(.+)$/m);
    if (match) {
      SLACK_BOT_TOKEN = match[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // Ignore file read errors
  }
}

async function slackApiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN not set");
  }

  // Convert body to form-urlencoded (Slack API prefers this)
  const formBody = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // JSON stringify arrays and objects (like blocks)
      const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
      formBody.append(key, strValue);
    }
  }

  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
  });

  const data = await response.json() as { ok: boolean; error?: string; needed?: string };
  if (!data.ok) {
    const detail = data.needed ? ` (needed: ${data.needed})` : "";
    throw new Error(`Slack API error: ${data.error}${detail}`);
  }

  return data;
}

// Tool definitions - names without prefix since OpenCode adds server name prefix
const tools: Tool[] = [
  {
    name: "get_thread_messages",
    description: "Get messages from a Slack thread. Use this to see what was discussed earlier in the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "The Slack channel ID" },
        thread_ts: { type: "string", description: "The thread timestamp" },
        limit: { type: "number", description: "Max messages to retrieve (default 20)" },
      },
      required: ["channel", "thread_ts"],
    },
  },
  {
    name: "ask_user",
    description: "Ask the user a question with button options. Use this when you need user input or confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "The Slack channel ID" },
        thread_ts: { type: "string", description: "The thread timestamp" },
        question: { type: "string", description: "The question to ask the user" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "List of options (2-5 buttons)",
        },
      },
      required: ["channel", "thread_ts", "question", "options"],
    },
  },
  {
    name: "add_reaction",
    description: "Add an emoji reaction to a message",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "The Slack channel ID" },
        timestamp: { type: "string", description: "The message timestamp" },
        emoji: { type: "string", description: "Emoji name without colons (e.g., 'thumbsup')" },
      },
      required: ["channel", "timestamp", "emoji"],
    },
  },
  {
    name: "get_user_info",
    description: "Get information about a Slack user",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "The Slack user ID (e.g., U12345)" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "post_message",
    description: "Post a message to the current thread",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "The Slack channel ID" },
        thread_ts: { type: "string", description: "The thread timestamp" },
        text: { type: "string", description: "The message text" },
      },
      required: ["channel", "thread_ts", "text"],
    },
  },
];

// Tool execution
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "get_thread_messages": {
      const { channel, thread_ts, limit = 20 } = args as { channel: string; thread_ts: string; limit?: number };

      if (!channel || !thread_ts) {
        throw new Error(`Missing required parameters: channel=${channel}, thread_ts=${thread_ts}`);
      }

      const data = await slackApiCall("conversations.replies", {
        channel,
        ts: thread_ts,
        limit,
      }) as { messages?: Array<{ user?: string; text?: string; ts?: string }> };

      const messages = data.messages || [];
      const formatted = messages.map((m, i) => {
        const user = m.user ? `<@${m.user}>` : "unknown";
        return `[${i + 1}] ${user}: ${m.text || "(no text)"}`;
      }).join("\n");

      return formatted || "No messages found";
    }

    case "ask_user": {
      const { channel, thread_ts, question, options } = args as {
        channel: string;
        thread_ts: string;
        question: string;
        options: string[];
      };

      if (!options || options.length < 2 || options.length > 5) {
        throw new Error("Options must have 2-5 items");
      }

      const buttons = options.map((opt, i) => ({
        type: "button",
        text: { type: "plain_text", text: opt },
        action_id: `user_choice_${i}`,
        value: opt,
      }));

      await slackApiCall("chat.postMessage", {
        channel,
        thread_ts,
        text: question,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: question },
          },
          {
            type: "actions",
            block_id: "user_choice",
            elements: buttons,
          },
        ],
      });

      return "Question posted with buttons. The user's response will come in their next message.";
    }

    case "add_reaction": {
      const { channel, timestamp, emoji } = args as { channel: string; timestamp: string; emoji: string };

      await slackApiCall("reactions.add", {
        channel,
        timestamp,
        name: emoji.replace(/:/g, ""),
      });

      return `Added :${emoji}: reaction`;
    }

    case "get_user_info": {
      const { user_id } = args as { user_id: string };

      const data = await slackApiCall("users.info", {
        user: user_id,
      }) as { user?: { name?: string; real_name?: string; profile?: { display_name?: string; email?: string } } };

      const user = data.user;
      if (!user) return "User not found";

      return `User: ${user.real_name || user.name || user_id}
Display name: ${user.profile?.display_name || "(none)"}
Email: ${user.profile?.email || "(hidden)"}`;
    }

    case "post_message": {
      const { channel, thread_ts, text } = args as { channel: string; thread_ts: string; text: string };

      await slackApiCall("chat.postMessage", {
        channel,
        thread_ts,
        text,
      });

      return "Message posted";
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP message handler
async function handleMessage(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "ode-slack-mcp",
              version: "1.0.0",
            },
            capabilities: {
              tools: {},
            },
          },
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools },
        };

      case "tools/call": {
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
        const result = await executeTool(name, args || {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result }],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// Main loop - read JSON-RPC from stdin, write to stdout
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await handleMessage(request);
      console.log(JSON.stringify(response));
    } catch (err) {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }));
    }
  }
}

main().catch(console.error);
