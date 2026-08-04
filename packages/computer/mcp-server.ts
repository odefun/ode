import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { COMPUTER_TOOL_DEFINITIONS } from "./tools";
import { COMPUTER_GATEWAY_ENV } from "./gateway";
import type { ComputerToolResult } from "./types";

type GatewayResponse = {
  ok?: boolean;
  result?: ComputerToolResult;
  error?: string;
};

export async function runComputerMcpServerFromEnv(): Promise<void> {
  const contextId = process.env[COMPUTER_GATEWAY_ENV.contextId]?.trim();
  const gatewayUrl = process.env[COMPUTER_GATEWAY_ENV.url]?.trim();
  const token = process.env[COMPUTER_GATEWAY_ENV.token]?.trim();
  if (!contextId || !gatewayUrl || !token) {
    throw new Error("Ode Computer MCP is missing its private gateway context");
  }

  const server = new McpServer({ name: "ode-computer", version: "1.0.0" });
  for (const definition of COMPUTER_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.shape,
      },
      async (input) => {
        try {
          const response = await fetch(`${gatewayUrl}/invoke`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ contextId, name: definition.name, input }),
          });
          const payload = await response.json() as GatewayResponse;
          if (!response.ok || payload.ok !== true || !payload.result) {
            throw new Error(payload.error || `Gateway request failed with ${response.status}`);
          }
          return await toMcpResult(payload.result);
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          };
        }
      },
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // `connect()` only starts the transport. The Ode CLI exits explicitly after a
  // command handler returns, so keep this hidden stdio command alive until its
  // parent provider closes stdin.
  await new Promise<void>((resolve) => {
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      resolve();
      return;
    }
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  });
  await server.close();
}

async function toMcpResult(result: ComputerToolResult): Promise<{
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
