#!/usr/bin/env bun

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import packageJson from "../../package.json" with { type: "json" };
import { getWebHost, getWebPort } from "@/config";
import { runDaemon } from "@/core/daemon/manager";
import { getDaemonLogPath } from "@/core/daemon/paths";
import { isProcessAlive, readDaemonState, type DaemonState } from "@/core/daemon/state";
import { runOnboarding } from "@/core/onboarding";
import { handleTaskCommand } from "@/core/cli-handlers/task";
import { handleCronCommand } from "@/core/cli-handlers/cron";
import { handlePrTrackerCommand } from "@/core/cli-handlers/pr-tracker";
import { handleSendCommand } from "@/core/cli-handlers/send";
import { handleMessagesCommand } from "@/core/cli-handlers/messages";
import { handleReactionCommand } from "@/core/cli-handlers/reaction";
import { isInstalledBinary, performUpgrade } from "@/core/upgrade";

const rawArgs = process.argv.slice(2);
const CURRENT_VERSION = packageJson.version ?? "0.0.0";
const CLI_ENTRY = new URL(import.meta.url).pathname;
const BUN_EXECUTABLE: string = process.argv[0] ?? process.execPath;
const EXECUTABLE_PATH: string = process.execPath;
const INSTALLED_BINARY = isInstalledBinary();
const READY_WAIT_MS = 2 * 60 * 1000;
const READY_POLL_MS = 500;
const STOP_WAIT_MS = 30 * 1000;
const STOP_POLL_MS = 500;
const DAEMON_SPAWN_THROTTLE_MS = 3000;
let lastDaemonSpawnAttemptAt = 0;

const foregroundRequested = rawArgs.includes("--foreground");
const args = foregroundRequested
  ? rawArgs.filter((arg) => arg !== "--foreground")
  : rawArgs;
const command = args[0];
const isOnboardingCommand = command === "onboarding" || command === "onboard" || command === "config";

function printHelp(): void {
  console.log(
    [
      "ode - OpenCode Slack bot",
      "",
      "Usage:",
      "  ode [--foreground]",
      "  ode help",
      "  ode status",
      "  ode log [--info|--error] [--tail [N]]",
      "  ode restart",
      "  ode stop",
      "  ode onboard",
      "  ode onboarding",
      "  ode config",
      "  ode task <subcommand>    # manage one-time scheduled tasks",
      "  ode cron <subcommand>    # manage recurring cron jobs",
      "  ode send <subcommand>    # upload files/images to a chat channel",
      "  ode messages <subcommand> # fetch thread messages",
      "  ode reaction <subcommand> # add reactions to messages",
      "  ode upgrade",
      "  ode --version",
      "",
      "Examples:",
      "  ode",
      "  ode status",
      "  ode log --error",
      "  ode log --tail 200",
      "  ode restart",
      "  ode stop",
      "  ode onboard",
      "  ode task create --time 2026-04-19T09:00:00+08:00 --channel C123 --message \"check deploy\"",
      "  ode task list",
      "  ode cron create --schedule \"*/30 * * * *\" --channel C123 --message \"heartbeat\"",
      "  ode cron list",
      "  ode send file ./screenshot.png --channel C123 --thread 1700000000.000001 --comment \"layout diff\"",
      "  ode messages get 1700000000.000001 --channel C123",
      "  ode reaction add 1700000000.000001 --channel C123 --emoji thumbsup",
      "  ode --foreground",
      "  ODE_WEB_HOST=0.0.0.0 ode #run ode process and expose setting UI",
    ].join("\n"),
  );
}

async function upgrade(): Promise<void> {
  if (!isInstalledBinary()) {
    console.error("ode upgrade must be run from the installed ode binary.");
    console.error("Install with: curl -fsSL https://raw.githubusercontent.com/odefun/ode/main/scripts/install.sh | bash");
    process.exit(1);
  }
  const { latestVersion } = await performUpgrade();
  if (latestVersion) {
    console.log(`ode upgraded (current version: ${latestVersion}).`);
    return;
  }

  console.log("ode upgraded.");
}

function getLocalSettingsUrl(): string {
  const host = getWebHost();
  const port = getWebPort();
  return `http://${host}:${port}/`;
}

function fallbackReadyMessage(): string {
  return `Ode is ready! Waiting for messages, setting UI is accessible at ${getLocalSettingsUrl()}`;
}

function extractSettingsUrl(readyMessage: string | null): string | null {
  if (!readyMessage) return null;
  const marker = "setting UI is accessible at ";
  const markerIndex = readyMessage.indexOf(marker);
  if (markerIndex === -1) return null;

  const url = readyMessage.slice(markerIndex + marker.length).trim();
  return url.length > 0 ? url : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function daemonState(): DaemonState {
  return readDaemonState();
}

function managerRunning(state: DaemonState = daemonState()): boolean {
  return isProcessAlive(state.managerPid);
}

function runtimeRunning(state: DaemonState = daemonState()): boolean {
  return isProcessAlive(state.runtimePid);
}

function ensureDaemonRunning(): void {
  const state = daemonState();
  if (managerRunning(state)) return;
  const now = Date.now();
  if (now - lastDaemonSpawnAttemptAt < DAEMON_SPAWN_THROTTLE_MS) return;
  lastDaemonSpawnAttemptAt = now;
  const child = spawn(
    INSTALLED_BINARY ? EXECUTABLE_PATH : BUN_EXECUTABLE,
    INSTALLED_BINARY ? ["daemon"] : [CLI_ENTRY, "daemon"],
    {
    detached: true,
    stdio: "ignore",
    },
  );
  child.unref();
}

async function waitForReadyMessage(timeoutMs: number): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = daemonState();
    if (state.status === "ready" && typeof state.readyMessage === "string" && state.readyMessage.length > 0 && managerRunning(state)) {
      return state.readyMessage;
    }
    if (!managerRunning(state)) {
      ensureDaemonRunning();
    }
    await delay(READY_POLL_MS);
  }
  return null;
}

async function waitForStopped(timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = daemonState();
    if (!managerRunning(state) && !runtimeRunning(state)) return true;
    await delay(STOP_POLL_MS);
  }
  return false;
}

async function startBackground(): Promise<void> {
  const state = daemonState();
  if (state.status === "ready" && state.readyMessage && managerRunning(state)) {
    console.log(fallbackReadyMessage());
    return;
  }
  ensureDaemonRunning();
  const readyMessage = await waitForReadyMessage(READY_WAIT_MS);
  if (readyMessage) {
    console.log(readyMessage);
    return;
  }
  console.log(`Ode daemon is still starting. Follow logs at ${getDaemonLogPath()}`);
}

function formatTimestamp(value: number | null): string {
  if (!value) return "n/a";
  return new Date(value).toLocaleString();
}

function resolveRuntimeVersion(state: DaemonState): string | null {
  if (typeof state.runtimeVersion === "string" && state.runtimeVersion.length > 0) {
    return state.runtimeVersion;
  }
  return null;
}

type LogFilterLevel = "all" | "info" | "error";

function parseLogFilterLevel(commandArgs: string[]): LogFilterLevel {
  if (commandArgs.includes("--error")) return "error";
  if (commandArgs.includes("--info")) return "info";
  return "all";
}

function parseLogTailLimit(commandArgs: string[]): number | null {
  const tailWithValue = commandArgs.find((arg) => arg.startsWith("--tail="));
  if (tailWithValue) {
    const rawValue = tailWithValue.slice("--tail=".length).trim();
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 200;
  }

  const tailIndex = commandArgs.indexOf("--tail");
  if (tailIndex < 0) return null;

  const nextArg = commandArgs[tailIndex + 1];
  if (!nextArg || nextArg.startsWith("--")) return 200;

  const parsed = Number(nextArg);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 200;
}

function lineMatchesLogLevel(line: string, level: LogFilterLevel): boolean {
  if (level === "all") return true;

  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as { level?: unknown };
      if (typeof parsed.level === "number") {
        if (level === "error") return parsed.level >= 50;
        return parsed.level >= 30;
      }
    } catch {
      // Ignore malformed JSON and use fallback matching.
    }
  }

  if (level === "error") {
    return line.toLowerCase().includes("error")
      || line.includes("Unhandled rejection")
      || line.includes("Uncaught exception");
  }

  return true;
}

function normalizeConsoleLevel(level: string): string {
  const upper = level.toUpperCase();
  if (upper === "WARNING") return "WARN";
  return upper;
}

function getPinoLevelLabel(level: unknown): string {
  if (typeof level === "string") {
    return normalizeConsoleLevel(level);
  }
  if (typeof level === "number") {
    if (level >= 60) return "FATAL";
    if (level >= 50) return "ERROR";
    if (level >= 40) return "WARN";
    if (level >= 30) return "INFO";
    if (level >= 20) return "DEBUG";
    return "TRACE";
  }
  return "INFO";
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatStructuredLogLine(parsed: Record<string, unknown>): string {
  const level = getPinoLevelLabel(parsed.level);
  const message = typeof parsed.msg === "string"
    ? parsed.msg
    : (typeof parsed.message === "string" ? parsed.message : "");
  const timestampValue = parsed.time;
  const timestamp = typeof timestampValue === "number"
    ? new Date(timestampValue).toISOString()
    : (typeof timestampValue === "string" ? timestampValue : new Date().toISOString());

  const details = Object.entries(parsed)
    .filter(([key]) => !["level", "time", "msg", "message", "pid", "hostname"].includes(key))
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");

  const suffix = details ? ` ${details}` : "";
  return `[${timestamp}] ${level}: ${message}${suffix}`.trim();
}

function formatConsoleBracketLine(line: string): string | null {
  const match = line.match(/^\[(trace|debug|info|warn|warning|error|fatal)\]:\s*(.+)$/i);
  if (!match) return null;
  const rawLevel = match[1] ?? "info";
  const rawPayload = match[2] ?? "";
  const level = normalizeConsoleLevel(rawLevel);
  const payload = rawPayload.trim();
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (Array.isArray(parsed)) {
      return `${level}: ${parsed.map((entry) => formatLogValue(entry)).join(" ")}`;
    }
    return `${level}: ${formatLogValue(parsed)}`;
  } catch {
    return `${level}: ${payload}`;
  }
}

function formatLogLineForDisplay(line: string): string {
  if (line.startsWith("{")) {
    try {
      return formatStructuredLogLine(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Fallback to the raw line if parsing fails.
    }
  }

  const consoleFormatted = formatConsoleBracketLine(line);
  if (consoleFormatted) return consoleFormatted;
  return line;
}

function showLogs(commandArgs: string[]): void {
  const logPath = getDaemonLogPath();
  if (!existsSync(logPath)) {
    console.log(`No daemon logs found yet at ${logPath}`);
    return;
  }

  const filterLevel = parseLogFilterLevel(commandArgs);
  const tailLimit = parseLogTailLimit(commandArgs);
  const content = readFileSync(logPath, "utf8");
  if (content.length === 0) {
    console.log(`Daemon log is empty at ${logPath}`);
    return;
  }

  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  const filtered = lines.filter((line) => lineMatchesLogLevel(line, filterLevel));
  const output = (tailLimit === null ? filtered : filtered.slice(-tailLimit)).map(formatLogLineForDisplay);

  if (output.length === 0) {
    console.log(`No ${filterLevel} logs found in ${logPath}`);
    return;
  }

  console.log(output.join("\n"));
}

async function showStatus(): Promise<void> {
  const state = daemonState();
  const daemonIsRunning = managerRunning(state);
  const runtimeVersion = daemonIsRunning ? resolveRuntimeVersion(state) : null;
  if (daemonIsRunning) {
    if (runtimeVersion) {
      console.log(`Version: ${runtimeVersion}`);
    } else {
      console.log("Version: unknown (running daemon does not report its version; restart recommended)");
    }
    if (!runtimeVersion || runtimeVersion !== CURRENT_VERSION) {
      console.log(`Installed Version: ${CURRENT_VERSION}`);
    }
  } else {
    console.log(`Version: ${CURRENT_VERSION}`);
  }
  console.log(`Daemon: ${daemonIsRunning ? "running" : "stopped"}`);
  if (state.pendingUpgradeRestart) {
    console.log(
      `Upgrade: pending restart since ${formatTimestamp(state.pendingUpgradeRestart.scheduledAt)} (${state.pendingUpgradeRestart.reason})`,
    );
  } else {
    console.log("Upgrade: none pending");
  }
  if (daemonIsRunning) {
    const settingsUrl = extractSettingsUrl(state.readyMessage) ?? getLocalSettingsUrl();
    console.log(`ode is running, setting UI is accessible at ${settingsUrl}`);
    return;
  }
  console.log("ode is installed but not running, can run it with ode");
}

async function restartDaemonCommand(): Promise<void> {
  const state = daemonState();
  if (!managerRunning(state)) {
    console.log("Daemon not running. Starting a new daemon instance...");
    ensureDaemonRunning();
    const ready = await waitForReadyMessage(READY_WAIT_MS);
    console.log(ready ?? `Restart requested. Follow logs at ${getDaemonLogPath()}`);
    return;
  }

  if (runtimeRunning(state) && state.runtimePid) {
    try {
      process.kill(state.runtimePid, "SIGTERM");
      console.log(`Sent shutdown signal to runtime (pid ${state.runtimePid}).`);
    } catch (error) {
      console.warn(`Failed to signal runtime (pid ${state.runtimePid}): ${String(error)}`);
    }
  } else {
    console.log("Runtime is not currently running; waiting for daemon to restart.");
  }

  const ready = await waitForReadyMessage(READY_WAIT_MS);
  console.log(ready ?? `Restart requested. Follow logs at ${getDaemonLogPath()}`);
}

async function stopDaemonCommand(): Promise<void> {
  const state = daemonState();
  const managerAlive = managerRunning(state);
  const runtimeAlive = runtimeRunning(state);

  if (!managerAlive && !runtimeAlive) {
    console.log("Daemon already stopped.");
    return;
  }

  if (managerAlive && state.managerPid) {
    try {
      process.kill(state.managerPid, "SIGTERM");
      console.log(`Sent shutdown signal to daemon (pid ${state.managerPid}).`);
    } catch (error) {
      console.warn(`Failed to signal daemon (pid ${state.managerPid}): ${String(error)}`);
    }
  }

  if (runtimeAlive && state.runtimePid) {
    try {
      process.kill(state.runtimePid, "SIGTERM");
      console.log(`Sent shutdown signal to runtime (pid ${state.runtimePid}).`);
    } catch (error) {
      console.warn(`Failed to signal runtime (pid ${state.runtimePid}): ${String(error)}`);
    }
  }

  const stopped = await waitForStopped(STOP_WAIT_MS);
  console.log(stopped ? "Daemon stopped." : `Stop requested. Follow logs at ${getDaemonLogPath()}`);
}

if (command === "help" || args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (command === "__runtime") {
  await import("./index");
  await new Promise(() => {});
}

if (command === "daemon") {
  await runDaemon();
  await new Promise(() => {});
}

if (args.includes("--version") || command === "version") {
  console.log(CURRENT_VERSION);
  process.exit(0);
}

if (command === "upgrade") {
  await upgrade();
  process.exit(0);
}

if (isOnboardingCommand) {
  await runOnboarding({ force: true });
  process.exit(0);
}

if (command === "status") {
  await showStatus();
  process.exit(0);
}

if (command === "log") {
  showLogs(args.slice(1));
  process.exit(0);
}

if (command === "restart") {
  await restartDaemonCommand();
  process.exit(0);
}

if (command === "stop") {
  await stopDaemonCommand();
  process.exit(0);
}

if (command === "start") {
  await startBackground();
  process.exit(0);
}

if (command === "task") {
  const code = await handleTaskCommand(args.slice(1));
  process.exit(code);
}

if (command === "cron") {
  const code = await handleCronCommand(args.slice(1));
  process.exit(code);
}

if (command === "pr-tracker" || command === "pr_tracker") {
  const code = await handlePrTrackerCommand(args.slice(1));
  process.exit(code);
}

if (command === "send") {
  const code = await handleSendCommand(args.slice(1));
  process.exit(code);
}

if (command === "messages") {
  const code = await handleMessagesCommand(args.slice(1));
  process.exit(code);
}

if (command === "reaction") {
  const code = await handleReactionCommand(args.slice(1));
  process.exit(code);
}

if (foregroundRequested) {
  await import("./index");
  await new Promise(() => {});
}

await startBackground();
