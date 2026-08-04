import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, runJsonCommand, type CommandResult } from "./process";

export const ODE_DESKTOP_EXECUTABLE = "ode";
export const ODE_APP_BUNDLE_ID = "fun.ode.app";

export type OdeAppLocation = {
  appPath: string;
  servicePath: string;
  cliPath: string;
};

export function findOdeApp(): OdeAppLocation | null {
  if (process.platform !== "darwin") return null;
  const candidates = [
    process.env.ODE_APP_PATH?.trim(),
    join(homedir(), "Applications", "Ode.app"),
    "/Applications/Ode.app",
  ].filter((value): value is string => Boolean(value));
  for (const appPath of candidates) {
    const servicePath = join(appPath, "Contents", "MacOS", "Ode Computer Service");
    if (!existsSync(servicePath)) continue;
    return {
      appPath,
      servicePath,
      cliPath: join(appPath, "Contents", "Resources", "ode"),
    };
  }
  return null;
}

export function requireOdeApp(): OdeAppLocation {
  const location = findOdeApp();
  if (location) return location;
  throw new Error("Ode.app is not installed. Run `ode computer setup` to install and authorize desktop control.");
}

export function findBundledAgentBrowser(): string | null {
  const app = findOdeApp();
  if (!app) return null;
  const executable = join(app.appPath, "Contents", "Resources", "agent-browser");
  return existsSync(executable) ? executable : null;
}

export function resolveAgentBrowserExecutable(configured: string): string {
  return findBundledAgentBrowser() ?? configured;
}

export function isOdeDesktopExecutable(executable: string): boolean {
  return executable === ODE_DESKTOP_EXECUTABLE;
}

export async function runOdeDesktopCommand<T extends Record<string, unknown>>(
  args: string[],
  options: { timeoutMs: number },
): Promise<T> {
  const location = requireOdeApp();
  const command = args[0] ?? "";
  if (command !== "permissions" && command !== "open-settings") {
    const packagedCli = process.execPath.includes("/Ode.app/Contents/Resources/ode");
    return await runJsonCommand<T>(location.servicePath, args, {
      timeoutMs: options.timeoutMs,
      env: packagedCli ? undefined : { ODE_COMPUTER_DEV_ALLOW_UNVERIFIED: "1" },
    });
  }
  const responseDir = await mkdtemp(join(tmpdir(), "ode-computer-response-"));
  const responsePath = join(responseDir, "response.json");
  try {
    await runCommand("/usr/bin/open", [
      "-n",
      location.appPath,
      "--args",
      ...args,
      "--response-file",
      responsePath,
    ], { timeoutMs: Math.min(options.timeoutMs, 15_000) });

    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const text = await readFile(responsePath, "utf8");
        try {
          return JSON.parse(text) as T;
        } catch (error) {
          throw new Error(`Ode Computer Service returned invalid JSON: ${String(error)}; output=${text.slice(0, 1_000)}`);
        }
      }
      await Bun.sleep(100);
    }
    throw new Error(`Ode Computer Service timed out after ${options.timeoutMs}ms`);
  } finally {
    await rm(responseDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function getOdeDesktopVersion(): Promise<CommandResult> {
  const location = requireOdeApp();
  return await runCommand(location.servicePath, ["--version"], { timeoutMs: 10_000 });
}
