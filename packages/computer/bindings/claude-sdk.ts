import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { computerGateway } from "../gateway";
import { COMPUTER_TOOL_DEFINITIONS } from "../tools";
import type { ComputerToolResult } from "../types";

export function createClaudeComputerMcpServer(contextId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "ode-computer",
    version: "1.0.0",
    alwaysLoad: true,
    instructions: "Use these tools for local browser or macOS UI work. Observe before acting and always reuse the exact fresh revision returned by the latest observation.",
    tools: COMPUTER_TOOL_DEFINITIONS.map((definition) => tool(
      definition.name,
      definition.description,
      definition.shape,
      async (input) => toClaudeToolResult(await computerGateway.invoke(contextId, definition.name, input)),
      { alwaysLoad: true },
    )),
  });
}
async function toClaudeToolResult(result: ComputerToolResult): Promise<{
  isError?: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
}> {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [{
    type: "text",
    text: JSON.stringify(result.data ?? { ok: result.ok, error: result.error }, null, 2),
  }];
  for (const artifact of result.artifacts ?? []) {
    const file = Bun.file(artifact.path);
    if (!(await file.exists())) continue;
    content.push({
      type: "image",
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      mimeType: artifact.mimeType,
    });
  }
  return { isError: !result.ok, content };
}
