import { basename, dirname, join } from "path";
import { mkdtemp, chmod, copyFile, mkdir, rm, rename, symlink } from "fs/promises";
import { homedir, tmpdir } from "os";
import { createHash } from "crypto";
import { spawn } from "child_process";

const LATEST_RELEASE_URL = "https://api.github.com/repos/odefun/ode/releases/latest";
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/odefun/ode/releases/download";

type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string | null;
  isUpdateAvailable: boolean;
};

type LatestReleaseInfo = {
  tag: string;
  version: string | null;
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

async function fetchLatestReleaseInfo(): Promise<LatestReleaseInfo | null> {
  try {
    const latestResponse = await fetch(LATEST_RELEASE_URL);
    if (!latestResponse.ok) return null;
    const latest = (await latestResponse.json()) as { tag_name?: string };
    const tag = typeof latest.tag_name === "string" ? latest.tag_name.trim() : "";
    if (!tag) return null;
    return {
      tag,
      version: normalizeVersion(tag),
    };
  } catch {
    return null;
  }
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseSha256SumFile(content: string, assetName: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const hash = match[1]?.toLowerCase();
    const fileName = basename((match[2] ?? "").trim());
    if (fileName !== assetName) continue;
    return hash ?? null;
  }
  return null;
}

function resolveAsset(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin") {
    if (arch === "arm64") return "ode-darwin-arm64.zip";
    if (arch === "x64") return "ode-darwin-x64.zip";
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

function runCodesign(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolve({ code: -1, stderr }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function runProcess(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => resolve({ code: -1, stderr }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const normalizedCurrent = normalizeVersion(currentVersion) ?? "0.0.0";
  const latestRelease = await fetchLatestReleaseInfo();
  const latestVersion = latestRelease?.version ?? null;
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
  const latestRelease = await fetchLatestReleaseInfo();
  if (!latestRelease?.tag) {
    throw new Error("Failed to resolve latest release tag");
  }

  const latestVersion = latestRelease.version;
  const asset = resolveAsset();
  const downloadBaseUrl = `${RELEASE_DOWNLOAD_BASE_URL}/${encodeURIComponent(latestRelease.tag)}`;
  const binaryUrl = `${downloadBaseUrl}/${asset}`;
  const checksumsUrl = `${downloadBaseUrl}/SHA256SUMS`;

  const [binaryResponse, checksumsResponse] = await Promise.all([
    fetch(binaryUrl),
    fetch(checksumsUrl),
  ]);
  if (!binaryResponse.ok) {
    throw new Error(`Failed to download ${binaryUrl} (${binaryResponse.status})`);
  }
  if (!checksumsResponse.ok) {
    throw new Error(`Failed to download ${checksumsUrl} (${checksumsResponse.status})`);
  }

  const [data, checksumsContent] = await Promise.all([
    binaryResponse.arrayBuffer().then((buf) => new Uint8Array(buf)),
    checksumsResponse.text(),
  ]);
  const expectedHash = parseSha256SumFile(checksumsContent, asset);
  if (!expectedHash) {
    throw new Error(`SHA256SUMS missing entry for ${asset}`);
  }
  const actualHash = sha256Hex(data);
  if (actualHash !== expectedHash) {
    throw new Error(`Checksum mismatch for ${asset}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ode-upgrade-"));
  const tempPath = join(tempDir, asset);
  await Bun.write(tempPath, data);
  if (process.platform === "darwin") {
    try {
      await installMacAppUpgrade(tempPath, tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return { latestVersion };
  }
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

async function installMacAppUpgrade(archivePath: string, tempDir: string): Promise<void> {
  const extracted = join(tempDir, "extracted");
  await mkdir(extracted, { recursive: true });
  const unpacked = await runProcess("/usr/bin/ditto", ["-x", "-k", archivePath, extracted]);
  if (unpacked.code !== 0) throw new Error(`Failed to unpack Ode.app: ${unpacked.stderr.trim()}`);
  const sourceApp = join(extracted, "Ode.app");
  const verified = await runCodesign(["--verify", "--deep", "--strict", sourceApp]);
  if (verified.code !== 0) throw new Error(`Ode.app signature verification failed: ${verified.stderr.trim()}`);

  const marker = `${process.platform === "darwin" ? "/Ode.app/Contents/Resources/ode" : ""}`;
  const currentExec = process.execPath;
  const markerIndex = currentExec.indexOf(marker);
  const destination = markerIndex >= 0
    ? currentExec.slice(0, markerIndex + "/Ode.app".length)
    : join(homedir(), "Applications", "Ode.app");
  const destinationDir = dirname(destination);
  const staged = join(destinationDir, `.Ode.app.installing-${process.pid}`);
  const backup = join(destinationDir, `.Ode.app.backup-${process.pid}`);
  await mkdir(destinationDir, { recursive: true });
  await rm(staged, { recursive: true, force: true });
  const copied = await runProcess("/usr/bin/ditto", [sourceApp, staged]);
  if (copied.code !== 0) throw new Error(`Failed to stage Ode.app: ${copied.stderr.trim()}`);

  let backedUp = false;
  try {
    if (await Bun.file(join(destination, "Contents", "Info.plist")).exists()) {
      await rm(backup, { recursive: true, force: true });
      await rename(destination, backup);
      backedUp = true;
    }
    await rename(staged, destination);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (!(await Bun.file(join(destination, "Contents", "Info.plist")).exists()) && backedUp) {
      await rename(backup, destination);
    }
    throw error;
  }

  if (markerIndex < 0) {
    // Migrate legacy standalone installs to the single Ode.app bundle while
    // preserving the command path the user already has on PATH.
    const nextLink = `${currentExec}.new`;
    await rm(nextLink, { force: true });
    await symlink(join(destination, "Contents", "Resources", "ode"), nextLink);
    await rename(nextLink, currentExec);
  }
}
