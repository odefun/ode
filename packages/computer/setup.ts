import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { getComputerGatewayConfig, setComputerGatewayConfig } from "@/config";
import { runCommand, runJsonCommand } from "./process";
import {
  findOdeApp,
  findBundledAgentBrowser,
  getOdeDesktopVersion,
  resolveAgentBrowserExecutable,
  runOdeDesktopCommand,
  type OdeAppLocation,
} from "./ode-app";

const AGENT_BROWSER_VERSION = "0.33.2";
const RELEASE_BASE_URL = "https://github.com/odefun/ode/releases/download";

type DriverState = {
  installed: boolean;
  executable?: string;
  version?: string;
  ready: boolean;
  error?: string;
  details?: Record<string, unknown>;
};

export type ComputerSetupStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  browser: DriverState;
  desktop: DriverState & {
    appPath?: string;
    bundleIdentifier: "fun.ode.app";
    permissions?: Array<Record<string, unknown>>;
  };
  ready: boolean;
};

type ServiceResponse = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { message?: string } | string;
};

export async function getComputerSetupStatus(): Promise<ComputerSetupStatus> {
  const config = getComputerGatewayConfig();
  const browserExecutable = resolveAgentBrowserExecutable(config.browserExecutable);
  const browser: DriverState = {
    installed: false,
    executable: browserExecutable,
    ready: false,
  };
  try {
    const version = await runCommand(browserExecutable, ["--version"], { timeoutMs: 10_000 });
    browser.installed = true;
    browser.version = version.stdout.trim();
    const details = await runJsonCommand<Record<string, unknown>>(
      browserExecutable,
      ["doctor", "--offline", "--quick", "--json"],
      { timeoutMs: 30_000 },
    );
    browser.details = details;
    browser.ready = driverReportReady(details);
  } catch (error) {
    browser.error = errorMessage(error);
  }

  const desktop: ComputerSetupStatus["desktop"] = {
    installed: false,
    ready: false,
    bundleIdentifier: "fun.ode.app",
  };
  const app = findOdeApp();
  if (app) {
    desktop.installed = true;
    desktop.appPath = app.appPath;
    desktop.executable = app.servicePath;
    try {
      const version = await getOdeDesktopVersion();
      desktop.version = (version.stdout || version.stderr).trim();
      const response = await runOdeDesktopCommand<ServiceResponse>(["permissions", "--json"], { timeoutMs: 15_000 });
      if (response.success !== true) throw new Error(serviceError(response));
      const data = response.data ?? {};
      desktop.details = data;
      desktop.permissions = Array.isArray(data.permissions)
        ? data.permissions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        : [];
      desktop.ready = data.allGranted === true;
    } catch (error) {
      desktop.error = errorMessage(error);
    }
  } else if (process.platform === "darwin") {
    desktop.error = "Ode.app is not installed";
  } else {
    desktop.error = "Desktop control is available on macOS only";
  }

  return {
    platform: process.platform,
    supported: process.platform === "darwin",
    browser,
    desktop,
    ready: browser.ready && desktop.ready,
  };
}

export async function setupComputerGateway(options: {
  browser?: boolean;
  desktop?: boolean;
  requestPermissions?: boolean;
  reinstallApp?: boolean;
} = {}): Promise<ComputerSetupStatus> {
  const includeBrowser = options.browser !== false;
  const includeDesktop = options.desktop !== false;
  if (includeDesktop) {
    if (process.platform !== "darwin") throw new Error("Ode desktop control requires macOS 15 or newer");
    await ensureOdeAppInstalled(options.reinstallApp === true);
    if (options.requestPermissions !== false) {
      await requestComputerPermissions();
    }
  }
  if (includeBrowser) await ensureAgentBrowser();
  setComputerGatewayConfig((config) => ({
    ...config,
    enabled: true,
    desktopDriver: "ode",
    desktopExecutable: "ode",
  }));
  return await getComputerSetupStatus();
}

export async function requestComputerPermissions(): Promise<Record<string, unknown>> {
  const response = await runOdeDesktopCommand<ServiceResponse>(
    ["permissions", "request", "--json"],
    { timeoutMs: 30_000 },
  );
  if (response.success !== true) throw new Error(serviceError(response));
  return response.data ?? {};
}

export async function openComputerPermissionSettings(kind: "screen-recording" | "accessibility"): Promise<void> {
  const response = await runOdeDesktopCommand<ServiceResponse>(
    ["open-settings", kind, "--json"],
    { timeoutMs: 15_000 },
  );
  if (response.success !== true) throw new Error(serviceError(response));
}

export async function runComputerSelfTest(): Promise<Record<string, unknown>> {
  const path = join(tmpdir(), `ode-computer-self-test-${Date.now()}.png`);
  const response = await runOdeDesktopCommand<ServiceResponse>(
    ["self-test", "--path", path, "--json"],
    { timeoutMs: 30_000 },
  );
  if (response.success !== true) throw new Error(serviceError(response));
  return response.data ?? {};
}

async function ensureAgentBrowser(): Promise<string> {
  const bundled = findBundledAgentBrowser();
  if (bundled) {
    await chmod(bundled, 0o755);
    await runCommand(bundled, ["install"], { timeoutMs: 5 * 60_000 });
    setComputerGatewayConfig((current) => ({ ...current, browserExecutable: bundled }));
    return bundled;
  }
  const config = getComputerGatewayConfig();
  try {
    await runCommand(config.browserExecutable, ["--version"], { timeoutMs: 10_000 });
    await runCommand(config.browserExecutable, ["install"], { timeoutMs: 5 * 60_000 });
    return config.browserExecutable;
  } catch {
    // Continue with Ode's user-local installation.
  }
  const prefix = join(homedir(), ".local", "share", "ode", "computer");
  const executable = join(prefix, "node_modules", ".bin", "agent-browser");
  if (!existsSync(executable)) {
    await mkdir(prefix, { recursive: true });
    await runCommand("npm", ["install", "--prefix", prefix, `agent-browser@${AGENT_BROWSER_VERSION}`], {
      timeoutMs: 5 * 60_000,
    });
  }
  await runCommand(executable, ["install"], { timeoutMs: 5 * 60_000 });
  await chmod(executable, 0o755);
  setComputerGatewayConfig((current) => ({ ...current, browserExecutable: executable }));
  return executable;
}

async function ensureOdeAppInstalled(force = false): Promise<OdeAppLocation> {
  const existing = findOdeApp();
  if (existing && !force) return existing;
  const sourceRoot = join(import.meta.dir, "..", "..");
  const buildScript = join(sourceRoot, "scripts", "build-ode-app.sh");
  if (existsSync(buildScript)) {
    const output = await mkdtemp(join(tmpdir(), "ode-app-build-"));
    try {
      await runCommand(buildScript, [output], { timeoutMs: 10 * 60_000 });
      await installAppBundle(join(output, "Ode.app"));
    } finally {
      await rm(output, { recursive: true, force: true }).catch(() => undefined);
    }
    const installed = findOdeApp();
    if (installed) return installed;
  }
  await downloadAndInstallOdeApp();
  const installed = findOdeApp();
  if (!installed) throw new Error("Ode.app installation completed but the Computer Service was not found");
  return installed;
}

async function downloadAndInstallOdeApp(): Promise<void> {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  if (!arch) throw new Error(`Unsupported macOS architecture: ${process.arch}`);
  const version = packageJson.version ?? "0.0.0";
  const asset = `ode-darwin-${arch}.zip`;
  const base = `${RELEASE_BASE_URL}/v${encodeURIComponent(version)}`;
  const [archiveResponse, checksumsResponse] = await Promise.all([
    fetch(`${base}/${asset}`),
    fetch(`${base}/SHA256SUMS`),
  ]);
  if (!archiveResponse.ok) throw new Error(`Unable to download ${asset} (${archiveResponse.status})`);
  if (!checksumsResponse.ok) throw new Error(`Unable to download release checksums (${checksumsResponse.status})`);
  const [archive, sums] = await Promise.all([
    archiveResponse.arrayBuffer().then((value) => new Uint8Array(value)),
    checksumsResponse.text(),
  ]);
  const expected = checksumFor(sums, asset);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) throw new Error(`Checksum verification failed for ${asset}`);

  const extractDir = await mkdtemp(join(tmpdir(), "ode-app-download-"));
  const archivePath = join(extractDir, asset);
  await Bun.write(archivePath, archive);
  try {
    await runCommand("/usr/bin/ditto", ["-x", "-k", archivePath, extractDir], { timeoutMs: 60_000 });
    await installAppBundle(join(extractDir, "Ode.app"));
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function installAppBundle(source: string): Promise<void> {
  if (!existsSync(source)) throw new Error(`Ode.app was not found at ${source}`);
  const applications = join(homedir(), "Applications");
  const destination = join(applications, "Ode.app");
  const staged = join(applications, `.Ode.app.installing-${process.pid}`);
  const backup = join(applications, `.Ode.app.backup-${process.pid}`);
  await mkdir(applications, { recursive: true });
  await rm(staged, { recursive: true, force: true });
  await runCommand("/usr/bin/ditto", [source, staged], { timeoutMs: 60_000 });
  await runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged], { timeoutMs: 30_000 });
  let backedUp = false;
  try {
    if (existsSync(destination)) {
      await rm(backup, { recursive: true, force: true });
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(staged, destination);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(destination) && backedUp && existsSync(backup)) await rename(backup, destination);
    throw error;
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
}

function driverReportReady(report: Record<string, unknown>): boolean {
  if (report.ok === false || report.success === false) return false;
  if (report.ok === true || report.success === true) return true;
  const checks = Array.isArray(report.checks) ? report.checks : [];
  return checks.length === 0 || checks.every((check) => {
    if (!check || typeof check !== "object") return true;
    const record = check as Record<string, unknown>;
    return record.ok !== false && record.status !== "failed" && record.status !== "error";
  });
}

function checksumFor(content: string, asset: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && basename(match[2]?.trim() ?? "") === asset) return match[1]?.toLowerCase() ?? null;
  }
  return null;
}

function serviceError(response: ServiceResponse): string {
  return typeof response.error === "string" ? response.error : response.error?.message ?? "Ode Computer Service failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
