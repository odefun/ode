import { basename, dirname, join } from "path";
import { mkdtemp, chmod, copyFile, rm, rename } from "fs/promises";
import { tmpdir } from "os";

const LATEST_RELEASE_URL = "https://api.github.com/repos/odefun/ode/releases/latest";
const DOWNLOAD_BASE_URL = "https://github.com/odefun/ode/releases/latest/download";

type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  isUpdateAvailable: boolean;
};

function normalizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim().replace(/^v/, "");
  if (!trimmed) return null;
  return trimmed.split("-")[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const aValue = Number.isFinite(aParts[i]) ? (aParts[i] as number) : 0;
    const bValue = Number.isFinite(bParts[i]) ? (bParts[i] as number) : 0;
    if (aValue > bValue) return 1;
    if (aValue < bValue) return -1;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const latestResponse = await fetch(LATEST_RELEASE_URL);
    if (!latestResponse.ok) return null;
    const latest = (await latestResponse.json()) as { tag_name?: string };
    return normalizeVersion(latest.tag_name ?? null);
  } catch {
    return null;
  }
}

function resolveAsset(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    if (arch === "arm64") return "ode-darwin-arm64";
    if (arch === "x64") return "ode-darwin-x64";
  }

  if (platform === "linux") {
    if (arch === "x64") return "ode-linux-x64";
  }

  if (platform === "win32") {
    if (arch === "x64") return "ode-windows-x64.exe";
  }

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

export function isInstalledBinary(): boolean {
  const execName = basename(process.execPath);
  return execName === "ode" || execName === "ode.exe";
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const normalizedCurrent = normalizeVersion(currentVersion) ?? "0.0.0";
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return {
      currentVersion: normalizedCurrent,
      latestVersion: null,
      isUpdateAvailable: false,
    };
  }

  return {
    currentVersion: normalizedCurrent,
    latestVersion,
    isUpdateAvailable: compareVersions(latestVersion, normalizedCurrent) > 0,
  };
}

export async function performUpgrade(): Promise<{ latestVersion: string | null }> {
  const latestVersion = await fetchLatestVersion();
  const asset = resolveAsset();
  const url = `${DOWNLOAD_BASE_URL}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ode-upgrade-"));
  const tempPath = join(tempDir, asset);
  const data = new Uint8Array(await response.arrayBuffer());
  await Bun.write(tempPath, data);
  if (process.platform !== "win32") {
    await chmod(tempPath, 0o755);
  }

  try {
    const execPath = process.execPath;
    try {
      await copyFile(tempPath, execPath);
    } catch (error) {
      if (process.platform === "win32") throw error;
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ETXTBSY" && code !== "EBUSY") throw error;

      const execDir = dirname(execPath);
      const swapPath = join(execDir, `${basename(execPath)}.new`);
      await rm(swapPath, { force: true });
      await copyFile(tempPath, swapPath);
      await chmod(swapPath, 0o755);
      await rename(swapPath, execPath);
    }

    if (process.platform !== "win32") {
      await chmod(execPath, 0o755);
    }
  } catch (error) {
    console.error("Failed to replace the existing ode binary.");
    console.error("Try running with elevated permissions or reinstall to a writable directory.");
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return { latestVersion };
}
