import {
  createSlackApp,
  setupMessageHandlers,
  setupInteractiveHandlers,
  stopOAuthServer,
  recoverPendingRequests,
  initializeWorkspaceAuth,
  clearSlackAuthState,
  resetSlackState,
} from "@ode/ims";
import { type ChildProcess } from "child_process";
import { watchFile, unwatchFile } from "fs";
import { stopServer } from "@ode/agents";
import {
  getDefaultCwd,
  isLocalMode,
  getSlackAppToken,
  loadOdeConfig,
  invalidateOdeConfigCache,
  ODE_CONFIG_FILE,
  getUpdateConfig,
} from "@ode/config";
import { log } from "@ode/utils";
import { hasWebUiBuild, startLocalWebServer, stopLocalWebServer } from "./web/server";
import { checkForUpdate, isInstalledBinary, performUpgrade } from "./upgrade";
import packageJson from "../../package.json" with { type: "json" };

const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 9293;
const CONFIG_WATCH_INTERVAL_MS = 1000;
const CONFIG_WATCH_DEBOUNCE_MS = 500;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getLocalSettingsUrl(): string {
  const host = process.env.ODE_WEB_HOST?.trim() || DEFAULT_WEB_HOST;
  const port = parsePort(process.env.ODE_WEB_PORT?.trim(), DEFAULT_WEB_PORT);
  return `http://${host}:${port}/local-setting`;
}

let webDevServer: ChildProcess | null = null;
let slackApp: Awaited<ReturnType<typeof createSlackApp>> | null = null;
let slackAppToken: string | null = null;
let slackStarting = false;
let stopConfigWatcher: (() => void) | null = null;
let upgradeTimer: ReturnType<typeof setInterval> | null = null;
let upgradeInitialTimer: ReturnType<typeof setTimeout> | null = null;

function getLocalSlackAppToken(): string | null {
  try {
    const token = getSlackAppToken().trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function stopSlackRuntime(reason: string): Promise<void> {
  if (slackApp) {
    try {
      await slackApp.stop();
    } catch (error) {
      log.error("Failed to stop Slack app", { reason, error: String(error) });
    }
  }

  slackApp = null;
  slackAppToken = null;
  resetSlackState();
  log.info("Slack connection stopped", { reason });
}

async function startSlackRuntime(reason: string): Promise<void> {
  if (slackStarting || slackApp) return;

  if (isLocalMode()) {
    const token = getLocalSlackAppToken();
    if (!token) {
      log.warn("Slack app token missing", { mode: "local" });
      return;
    }
    slackAppToken = token;
  }

  slackStarting = true;
  try {
    clearSlackAuthState();
    await initializeWorkspaceAuth();
    const app = await createSlackApp();
    setupMessageHandlers();
    setupInteractiveHandlers();
    await app.start();
    slackApp = app;
    log.info("Slack connection ready", { reason });
  } catch (error) {
    log.warn("Slack connection failed", { reason, error: String(error) });
    await stopSlackRuntime("startup failed");
  } finally {
    slackStarting = false;
  }
}

async function refreshSlackRuntime(reason: string): Promise<void> {
  if (!isLocalMode()) return;
  invalidateOdeConfigCache();
  loadOdeConfig();
  updateAutoUpgradeScheduler(reason);

  const nextToken = getLocalSlackAppToken();
  if (!nextToken) {
    await stopSlackRuntime("missing app token");
    return;
  }

  if (!slackApp) {
    await startSlackRuntime(reason);
    return;
  }

  if (slackAppToken && slackAppToken !== nextToken) {
    await stopSlackRuntime("app token changed");
    await startSlackRuntime(reason);
    return;
  }

  clearSlackAuthState();
  await initializeWorkspaceAuth();
  log.info("Slack auth refreshed", { reason });
}

async function runAutoUpgradeCheck(reason: string): Promise<void> {
  if (!isInstalledBinary()) {
    log.info("Auto-upgrade skipped (non-installed binary)", { reason });
    return;
  }

  const currentVersion = packageJson.version ?? "0.0.0";
  try {
    const update = await checkForUpdate(currentVersion);
    if (!update.latestVersion) {
      log.info("Auto-upgrade check failed", { reason });
      return;
    }
    if (!update.isUpdateAvailable) {
      log.info("Auto-upgrade check complete (no update)", {
        reason,
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
      });
      return;
    }

    log.info("Auto-upgrade available", {
      reason,
      currentVersion: update.currentVersion,
      latestVersion: update.latestVersion,
    });
    await performUpgrade();
    log.info("Auto-upgrade complete", { latestVersion: update.latestVersion });
  } catch (error) {
    log.warn("Auto-upgrade failed", { reason, error: String(error) });
  }
}

function stopAutoUpgradeScheduler(): void {
  if (upgradeTimer) {
    clearInterval(upgradeTimer);
    upgradeTimer = null;
  }
  if (upgradeInitialTimer) {
    clearTimeout(upgradeInitialTimer);
    upgradeInitialTimer = null;
  }
}

function updateAutoUpgradeScheduler(reason: string): void {
  if (!isLocalMode()) return;
  const { autoUpgrade, checkIntervalMs } = getUpdateConfig();
  if (!autoUpgrade) {
    stopAutoUpgradeScheduler();
    log.info("Auto-upgrade disabled", { reason });
    return;
  }

  stopAutoUpgradeScheduler();
  const jitterMs = Math.floor(Math.random() * 5 * 60 * 1000);
  const initialDelayMs = Math.min(60 * 1000 + jitterMs, checkIntervalMs);
  upgradeInitialTimer = setTimeout(() => {
    upgradeInitialTimer = null;
    void runAutoUpgradeCheck("startup");
  }, initialDelayMs);

  upgradeTimer = setInterval(() => {
    void runAutoUpgradeCheck("scheduled");
  }, checkIntervalMs);
  log.info("Auto-upgrade scheduler running", { intervalMs: checkIntervalMs });
}

function startLocalConfigWatcher(): void {
  if (!isLocalMode()) return;
  if (stopConfigWatcher) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  watchFile(ODE_CONFIG_FILE, { interval: CONFIG_WATCH_INTERVAL_MS }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refreshSlackRuntime("config change");
    }, CONFIG_WATCH_DEBOUNCE_MS);
  });

  stopConfigWatcher = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    unwatchFile(ODE_CONFIG_FILE);
    stopConfigWatcher = null;
  };
}

async function main(): Promise<void> {
  log.info("Starting Ode...");

  let defaultCwd: string | null = null;
  try {
    defaultCwd = getDefaultCwd();
  } catch {
    defaultCwd = null;
  }
  log.info("Config loaded", { defaultCwd, mode: isLocalMode() ? "local" : "cloud" });

  loadOdeConfig();

  if (isLocalMode()) {
    startLocalWebServer();
    if (!hasWebUiBuild()) {
      log.info("Web UI build missing; configure via ~/.config/ode/ode.json");
    }
    startLocalConfigWatcher();
    updateAutoUpgradeScheduler("startup");
  }

  await startSlackRuntime("startup");

  if (slackApp) {
    log.info("Slack app created");
    log.info("Message handlers registered");
    log.info("Interactive handlers registered");
  }

  // Handle shutdown gracefully
  const shutdown = async (signal: string) => {
    log.info("Shutting down...", { signal });

    try {
      stopOAuthServer();
      await stopSlackRuntime("shutdown");
      if (webDevServer) {
        webDevServer.kill();
        webDevServer = null;
      }
      stopLocalWebServer();
      if (stopConfigWatcher) {
        stopConfigWatcher();
      }
      stopAutoUpgradeScheduler();
      await stopServer();
      log.info("Cleanup complete");
      process.exit(0);
    } catch (err) {
      log.error("Error during cleanup", { error: String(err) });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (slackApp) {
    // Give socket connection time to fully establish before recovery
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Recover any interrupted requests from previous run
    await recoverPendingRequests();

    log.info("Bot is running in Socket Mode");
  }

  log.info("Configure Ode settings at", { url: getLocalSettingsUrl() });
  log.info("Ode is ready! Waiting for messages...");
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err) });
  process.exit(1);
});
