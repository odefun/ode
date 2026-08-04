import { basename } from "node:path";

export function getOdeComputerMcpCommand(): string[] {
  const override = process.env.ODE_COMPUTER_MCP_COMMAND?.trim();
  if (override) {
    const parsed = JSON.parse(override) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string") || parsed.length === 0) {
      throw new Error("ODE_COMPUTER_MCP_COMMAND must be a JSON array of command strings");
    }
    return parsed;
  }

  const executableName = basename(process.execPath).toLowerCase();
  if (!executableName.startsWith("bun") && !executableName.startsWith("node")) {
    return [process.execPath, "computer", "mcp"];
  }
  const cliEntry = new URL("../core/cli.ts", import.meta.url).pathname;
  return [process.execPath, cliEntry, "computer", "mcp"];
}
