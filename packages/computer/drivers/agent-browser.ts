import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ComputerArtifact } from "../types";
import { runJsonCommand } from "../process";

type AgentBrowserResponse = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string | null;
};

export class AgentBrowserDriver {
  readonly sessionName: string;

  constructor(
    contextId: string,
    private readonly executable: string,
    private readonly timeoutMs: number,
    private readonly headed: boolean,
    private readonly profile: string,
  ) {
    const digest = createHash("sha256").update(contextId).digest("hex").slice(0, 20);
    this.sessionName = `ode-${digest}`;
  }

  private async call(args: string[], timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const globalArgs = ["--session", this.sessionName];
    if (this.headed) globalArgs.push("--headed");
    if (this.profile) globalArgs.push("--profile", this.profile);
    globalArgs.push("--json", ...args);
    const response = await runJsonCommand<AgentBrowserResponse>(this.executable, globalArgs, { timeoutMs });
    if (response.success !== true) throw new Error(response.error || "agent-browser command failed");
    return response.data ?? {};
  }

  navigate(url: string): Promise<Record<string, unknown>> {
    return this.call(["open", url]);
  }

  async observe(options: {
    interactive: boolean;
    includeUrls: boolean;
    screenshot: boolean;
    fullPage: boolean;
  }): Promise<{ data: Record<string, unknown>; artifacts: ComputerArtifact[] }> {
    const args = ["snapshot"];
    if (options.interactive) args.push("-i");
    if (options.includeUrls) args.push("-u");
    const data = await this.call(args);
    const artifacts: ComputerArtifact[] = [];
    if (options.screenshot) {
      const path = join(tmpdir(), `ode-browser-${randomUUID()}.png`);
      const screenshotArgs = ["screenshot"];
      if (options.fullPage) screenshotArgs.push("--full");
      screenshotArgs.push(path);
      const screenshot = await this.call(screenshotArgs);
      const resolvedPath = typeof screenshot.path === "string" ? screenshot.path : path;
      artifacts.push({ path: resolvedPath, mimeType: "image/png", kind: "screenshot" });
    }
    return { data, artifacts };
  }

  act(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(input.action);
    const target = typeof input.target === "string" ? input.target : undefined;
    const value = typeof input.value === "string" ? input.value : undefined;
    let args: string[];
    switch (action) {
      case "click": args = ["click", required(target, "target")]; break;
      case "double_click": args = ["dblclick", required(target, "target")]; break;
      case "fill": args = ["fill", required(target, "target"), required(value, "value")]; break;
      case "type": args = ["type", required(target, "target"), required(value, "value")]; break;
      case "press": args = ["press", requiredString(input.key, "key")]; break;
      case "select": {
        const values = Array.isArray(input.values) ? input.values.filter((item): item is string => typeof item === "string") : [];
        args = ["select", required(target, "target"), ...nonEmpty(values, "values")];
        break;
      }
      case "hover": args = ["hover", required(target, "target")]; break;
      case "scroll": args = ["scroll", requiredString(input.direction, "direction"), String(input.amount ?? 500)]; break;
      case "upload": {
        const paths = Array.isArray(input.paths) ? input.paths.filter((item): item is string => typeof item === "string") : [];
        args = ["upload", required(target, "target"), ...nonEmpty(paths, "paths")];
        break;
      }
      default: throw new Error(`Unsupported browser action: ${action}`);
    }
    return this.call(args);
  }

  inspect(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const property = String(input.property);
    const target = typeof input.target === "string" ? input.target : undefined;
    switch (property) {
      case "title": return this.call(["get", "title"]);
      case "url": return this.call(["get", "url"]);
      case "text": return this.call(["get", "text", required(target, "target")]);
      case "html": return this.call(["get", "html", required(target, "target")]);
      case "value": return this.call(["get", "value", required(target, "target")]);
      case "count": return this.call(["get", "count", required(target, "target")]);
      case "attribute": return this.call(["get", "attr", required(target, "target"), requiredString(input.attribute, "attribute")]);
      default: throw new Error(`Unsupported browser property: ${property}`);
    }
  }

  wait(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const condition = String(input.condition);
    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 10_000;
    const value = typeof input.value === "string" ? input.value : undefined;
    switch (condition) {
      case "time": return this.call(["wait", String(timeoutMs)], timeoutMs + 2_000);
      case "text": return this.call(["wait", "--text", required(value, "value")], timeoutMs);
      case "url": return this.call(["wait", "--url", required(value, "value")], timeoutMs);
      case "load": return this.call(["wait", "--load", value || "networkidle"], timeoutMs);
      default: throw new Error(`Unsupported wait condition: ${condition}`);
    }
  }

  currentUrl(): Promise<Record<string, unknown>> {
    return this.call(["get", "url"]);
  }

  close(): Promise<Record<string, unknown>> {
    return this.call(["close"]);
  }
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  return required(typeof value === "string" ? value : undefined, name);
}

function nonEmpty(values: string[], name: string): string[] {
  if (values.length === 0) throw new Error(`${name} must not be empty`);
  return values;
}
