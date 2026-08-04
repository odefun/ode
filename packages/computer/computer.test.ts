import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getOdeComputerMcpCommand } from "./command";
import { sanitizeDashboardConfig } from "@/config/dashboard-config";
import {
  assertAllowedApp,
  assertAllowedOrigin,
  browserActionNeedsApproval,
  desktopActionNeedsApproval,
} from "./policy";
import { getComputerDynamicToolSpecs, parseComputerToolInput } from "./tools";
import { isComputerProviderSupported } from "./types";

describe("Ode Computer policy", () => {
  it("migrates the legacy Peekaboo desktop defaults to the single Ode.app identity", () => {
    const config = sanitizeDashboardConfig({
      computerGateway: {
        enabled: true,
        desktopDriver: "peekaboo",
        desktopExecutable: "peekaboo",
      },
    });
    expect(config.computerGateway.desktopDriver).toBe("ode");
    expect(config.computerGateway.desktopExecutable).toBe("ode");
  });

  it("preserves an explicitly empty origin allowlist as fail-closed", () => {
    const config = sanitizeDashboardConfig({
      workspaces: [{
        id: "workspace",
        channelDetails: [{
          id: "channel",
          name: "#computer",
          computerUse: { allowedOrigins: [] },
        }],
      }],
    });
    expect(config.workspaces[0]?.channelDetails[0]?.computerUse?.allowedOrigins).toEqual([]);
  });

  it("enforces origin allowlists without accepting lookalike hosts", () => {
    expect(assertAllowedOrigin("https://example.com/docs", ["https://example.com"]).hostname).toBe("example.com");
    expect(assertAllowedOrigin("http://localhost:4173/", ["http://localhost:*"]).port).toBe("4173");
    expect(() => assertAllowedOrigin("https://example.com.evil.test", ["https://example.com"])).toThrow("not allowed");
    expect(() => assertAllowedOrigin("file:///tmp/private", ["*"])).toThrow("protocol");
  });

  it("enforces desktop app allowlists", () => {
    expect(assertAllowedApp("ChatGPT", ["Chat*"])).toBe("ChatGPT");
    expect(() => assertAllowedApp("Terminal", ["ChatGPT"])).toThrow("not allowed");
    expect(() => assertAllowedApp(undefined, ["ChatGPT"])).toThrow("app is required");
  });

  it("requires approval for consequential and sensitive browser actions", () => {
    const snapshot = {
      revision: "b:1:test",
      refs: {
        submit: { role: "button", name: "Submit order" },
        search: { role: "textbox", name: "Search" },
        password: { role: "textbox", name: "Password" },
      },
    };
    expect(browserActionNeedsApproval({ action: "click", target: "@submit" }, snapshot, "consequential")).toBe(true);
    expect(browserActionNeedsApproval({ action: "click", target: "@search" }, snapshot, "consequential")).toBe(false);
    expect(browserActionNeedsApproval({ action: "fill", target: "@password" }, snapshot, "consequential")).toBe(true);
    expect(browserActionNeedsApproval({ action: "click", target: "@search" }, snapshot, "always")).toBe(true);
    expect(browserActionNeedsApproval({ action: "upload" }, snapshot, "never")).toBe(false);
    expect(browserActionNeedsApproval({ action: "click", target: "@missing" }, snapshot, "consequential")).toBe(true);
    expect(browserActionNeedsApproval({ action: "click", target: "button:has-text('Place order')" }, snapshot, "consequential")).toBe(true);
  });

  it("fails safe for desktop mutations", () => {
    expect(desktopActionNeedsApproval({ action: "scroll" }, undefined, "consequential")).toBe(false);
    expect(desktopActionNeedsApproval({ action: "click", target: "B1" }, undefined, "consequential")).toBe(true);
    expect(desktopActionNeedsApproval({ action: "click", target: "B1" }, undefined, "never")).toBe(false);
  });
});

describe("Ode Computer tool contracts", () => {
  it("limits product bindings to the three supported providers", () => {
    expect(isComputerProviderSupported("opencode")).toBe(true);
    expect(isComputerProviderSupported("claudecode")).toBe(true);
    expect(isComputerProviderSupported("codex")).toBe(true);
    expect(isComputerProviderSupported("kimi")).toBe(false);
  });

  it("applies defaults and rejects malformed actions", () => {
    expect(parseComputerToolInput("browser_observe", {})).toEqual({
      interactive: true,
      includeUrls: true,
      screenshot: false,
      fullPage: false,
    });
    expect(() => parseComputerToolInput("browser_act", { action: "click", revision: "" })).toThrow();
    expect(() => parseComputerToolInput("unknown", {})).toThrow("Unknown Ode Computer tool");
  });

  it("exports all provider-neutral JSON schemas", () => {
    const specs = getComputerDynamicToolSpecs();
    expect(specs).toHaveLength(8);
    expect(specs.map((spec) => spec.name)).toContain("desktop_observe");
    expect(specs.every((spec) => spec.inputSchema.type === "object")).toBe(true);
  });
});

describe("Ode Computer MCP proxy", () => {
  let fakeGateway: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    fakeGateway?.stop(true);
    fakeGateway = undefined;
  });

  it("exposes tools over stdio and forwards an authenticated invocation", async () => {
    let received: Record<string, unknown> | undefined;
    fakeGateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        received = await request.json() as Record<string, unknown>;
        return Response.json({ ok: true, result: { ok: true, data: { forwarded: true } } });
      },
    });

    const [command, ...args] = getOdeComputerMcpCommand();
    const transport = new StdioClientTransport({
      command: command!,
      args,
      cwd: process.cwd(),
      env: {
        ODE_COMPUTER_CONTEXT_ID: "test-context",
        ODE_COMPUTER_GATEWAY_URL: `http://127.0.0.1:${fakeGateway.port}`,
        ODE_COMPUTER_GATEWAY_TOKEN: "test-token",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "ode-computer-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(8);
      const result = await client.callTool({
        name: "computer_session",
        arguments: { action: "status", surface: "all" },
      });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: "text", text: "{\n  \"forwarded\": true\n}" }]);
      expect(received).toEqual({
        contextId: "test-context",
        name: "computer_session",
        input: { action: "status", surface: "all" },
      });
    } finally {
      await client.close();
    }
  }, 15_000);
});
