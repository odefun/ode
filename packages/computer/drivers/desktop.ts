import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ComputerArtifact } from "../types";
import { runOdeDesktopCommand } from "../ode-app";

type OdeDesktopResponse = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { message?: string } | string;
};

export class OdeDesktopDriver {
  constructor(private readonly timeoutMs: number) {}

  private async call(args: string[], timeoutMs = this.timeoutMs): Promise<Record<string, unknown>> {
    const commandArgs = [...args, "--json", "--no-remote"];
    const response = await runOdeDesktopCommand<OdeDesktopResponse>(commandArgs, { timeoutMs });
    if (response.success !== true) {
      const error = typeof response.error === "string" ? response.error : response.error?.message;
      throw new Error(error || "Ode desktop command failed");
    }
    return response.data ?? {};
  }

  permissions(): Promise<Record<string, unknown>> {
    return this.call(["permissions"]);
  }

  async observe(options: { app: string; annotate: boolean; screenshot: boolean }): Promise<{
    data: Record<string, unknown>;
    artifacts: ComputerArtifact[];
  }> {
    const path = join(tmpdir(), `ode-desktop-${randomUUID()}.png`);
    const args = ["see", "--app", options.app, "--timeout-seconds", String(Math.max(20, Math.ceil(this.timeoutMs / 1_000)))];
    if (options.annotate) args.push("--annotate");
    if (options.screenshot) args.push("--path", path);
    const raw = await this.call(args, this.timeoutMs + 5_000);
    const elements = Array.isArray(raw.ui_elements)
      ? raw.ui_elements.filter((item) => item && typeof item === "object").slice(0, 250)
      : [];
    const data = { ...raw, ui_elements: elements };
    const artifacts: ComputerArtifact[] = [];
    const screenshotPath = typeof raw.screenshot_annotated === "string"
      ? raw.screenshot_annotated
      : typeof raw.screenshot_raw === "string"
        ? raw.screenshot_raw
        : options.screenshot
          ? path
          : undefined;
    if (screenshotPath) artifacts.push({ path: screenshotPath, mimeType: "image/png", kind: "screenshot" });
    return { data, artifacts };
  }

  async act(input: Record<string, unknown>, snapshotId: string): Promise<Record<string, unknown>> {
    const action = String(input.action);
    const app = requiredString(input.app, "app");
    const target = typeof input.target === "string" ? input.target : undefined;
    const common = ["--app", app, "--snapshot", snapshotId];
    let args: string[];
    switch (action) {
      case "click":
        args = ["click", "--on", required(target, "target"), ...common];
        break;
      case "double_click":
        args = ["click", "--on", required(target, "target"), "--double", ...common];
        break;
      case "type":
        if (target) await this.call(["click", "--on", target, ...common]);
        return this.call(["type", requiredString(input.value, "value"), ...common]);
      case "press":
        args = ["press", requiredString(input.key, "key"), ...common];
        break;
      case "hotkey": {
        const keys = Array.isArray(input.keys) ? input.keys.filter((item): item is string => typeof item === "string") : [];
        if (keys.length === 0) throw new Error("keys must not be empty");
        args = ["hotkey", "--keys", keys.join(","), ...common];
        break;
      }
      case "scroll":
        args = [
          "scroll",
          "--direction", requiredString(input.direction, "direction"),
          "--amount", String(input.amount ?? 5),
          ...(target ? ["--on", target] : []),
          ...common,
        ];
        break;
      case "launch_app":
        return await this.call(["app", "launch", app, "--wait-until-ready"]);
      case "open_url":
        return await this.call(["open", requiredString(input.url, "url"), "--app", app, "--wait-until-ready"]);
      default:
        throw new Error(`Unsupported desktop action: ${action}`);
    }
    return await this.call(args);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  return required(typeof value === "string" ? value : undefined, name);
}
