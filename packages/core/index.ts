import {
  createSlackApp,
  setupMessageHandlers,
  setupInteractiveHandlers,
  stopOAuthServer,
  recoverPendingRequestsAcrossPlatforms,
  initializeWorkspaceAuth,
  clearSlackAuthState,
  resetSlackState,
  startDiscordRuntime,
  stopDiscordRuntime,
  startLarkRuntime,
  stopLarkRuntime,
  deliveryStats,
} from "@/ims";
import { type ChildProcess } from "child_process";
import { watchFile, unwatchFile } from "fs";
import { stopAllServers } from "@/agents";
import {
  getDefaultCwd,
  isLocalMode,
  getSlackAppTokens,
  getWebHost,
  getWebPort,
  loadOdeConfig,
  invalidateOdeConfigCache,
  ODE_CONFIG_FILE,
  getUpdateConfig,
} from "@/config";
import { log } from "@/utils";
import { hasWebUiBuild, startLocalWebServer, stopLocalWebServer } from "./web/server";
import { markRuntimeReady, scheduleUpgradeRestart } from "@/core/daemon/control";
import { checkForUpdate, isInstalledBinary, performUpgrade } from "./upgrade";
import { runOnboardingIfNeeded } from "./onboarding";
import { startCronJobScheduler, stopCronJobScheduler } from "@/core/cron/scheduler";
import { startTaskScheduler, stopTaskScheduler } from "@/core/tasks/scheduler";
import {
  startPrTrackerScheduler,
  stopPrTrackerScheduler,
} from "@/core/pr-tracker/scheduler";
import { initSentry, shutdownSentry } from "@/core/observability/sentry";
import packageJson from "../../package.json" with { type: "json" };

const CONFIG_WATCH_INTERVAL_MS = 1000;
const CONFIG_WATCH_DEBOUNCE_MS = 500;
const CURRENT_VERSION = packageJson.version ?? "0.0.0";

function getLocalSettingsUrl(): string {
  const host = getWebHost();
  const port = getWebPort();
  return `http://${host}:${port}/`;
}

let webDevServer: ChildProcess | null = null;
let slackApps: Array<Awaited<ReturnType<typeof createSlackApp>>> = [];
let slackAppTokens: string[] = [];
let slackStarting = false;
let stopConfigWatcher: (() => void) | null = null;
let upgradeTimer: ReturnType<typeof setInterval> | null = null;
let upgradeInitialTimer: ReturnType<typeof setTimeout> | null = null;

function getLocalSlackAppTokens(): string[] {
  try {
    const tokens = getSlackAppTokens()
      .map((entry) => entry.token.trim())
      .filter((token) => token.length > 0);
    return Array.from(new Set(tokens));
  } catch {
    return [];
  }
}

async function stopSlackRuntime(reason: string): Promise<void> {
  for (const app of slackApps) {
    try {
      await app.stop();
    } catch (error) {
      log.error("Failed to stop Slack app", { reason, error: String(error) });
    }
  }

  slackApps = [];
  slackAppTokens = [];
  resetSlackState();
  log.debug("Slack connections stopped", { reason });
}

async function startSlackRuntime(reason: string): Promise<void> {
  if (slackStarting || slackApps.length > 0) return;

  if (isLocalMode()) {
    const tokens = getLocalSlackAppTokens();
    if (tokens.length === 0) {
      log.warn("Slack app token missing", { mode: "local" });
      return;
    }
  }

  slackStarting = true;
  try {
    const appTokens = getLocalSlackAppTokens();
    if (appTokens.length === 0) return;

    clearSlackAuthState();
    await initializeWorkspaceAuth();
    slackApps = [];
    for (const appToken of appTokens) {
      const app = await createSlackApp(appToken);
      slackApps.push(app);
    }
    slackAppTokens = appTokens;
    setupMessageHandlers();
    setupInteractiveHandlers();
    for (const app of slackApps) {
      await app.start();
    }
    log.debug("Slack connections ready", { reason, count: slackApps.length });
  } catch (error) {
    log.warn("Slack connection failed", { reason, error: String(error) });
    await stopSlackRuntime("startup failed");
  } finally {
    slackStarting = false;
  }
}

async function refreshNonSlackRuntimes(reason: string): Promise<void> {
  await stopDiscordRuntime("config change");
  await startDiscordRuntime(reason);
  await stopLarkRuntime("config change");
  await startLarkRuntime(reason);
}

async function refreshSlackRuntime(reason: string): Promise<void> {
  if (!isLocalMode()) return;
  invalidateOdeConfigCache();
  loadOdeConfig();
  updateAutoUpgradeScheduler(reason);

  const nextTokens = getLocalSlackAppTokens();
  if (nextTokens.length === 0) {
    await stopSlackRuntime("missing app token");
    await refreshNonSlackRuntimes(reason);
    return;
  }

  if (slackApps.length === 0) {
    await startSlackRuntime(reason);
    await refreshNonSlackRuntimes(reason);
    return;
  }

  const runningTokens = new Set(slackAppTokens);
  const nextTokenSet = new Set(nextTokens);
  const changed = runningTokens.size !== nextTokenSet.size
    || Array.from(nextTokenSet).some((token) => !runningTokens.has(token));

  if (changed) {
    await stopSlackRuntime("app token set changed");
    await startSlackRuntime(reason);
    await refreshNonSlackRuntimes(reason);
    return;
  }

  clearSlackAuthState();
  await initializeWorkspaceAuth();
  log.debug("Slack auth refreshed", { reason, appCount: slackApps.length });

  await refreshNonSlackRuntimes(reason);
}

async function runAutoUpgradeCheck(reason: string): Promise<void> {
  if (!isInstalledBinary()) {
    log.debug("Auto-upgrade skipped (non-installed binary)", { reason });
    return;
  }

  try {
    const update = await checkForUpdate(CURRENT_VERSION);
    if (!update.latestVersion) {
      log.debug("Auto-upgrade check failed", { reason });
      return;
    }
    if (!update.isUpdateAvailable) {
      log.debug("Auto-upgrade check complete (no update)", {
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
    scheduleUpgradeRestart("auto-upgrade");
    log.info("Auto-upgrade complete", {
      latestVersion: update.latestVersion,
      restartScheduled: true,
    });
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
    log.debug("Auto-upgrade disabled", { reason });
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
  log.debug("Auto-upgrade scheduler running", { intervalMs: checkIntervalMs });
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
  initSentry({ release: `ode@${CURRENT_VERSION}` });

  let defaultCwd: string | null = null;
  try {
    defaultCwd = getDefaultCwd();
  } catch {
    defaultCwd = null;
  }
  log.debug("Config loaded", { defaultCwd, mode: "local" });

  loadOdeConfig();
  await runOnboardingIfNeeded();

  if (isLocalMode()) {
    startLocalWebServer();
    if (!hasWebUiBuild()) {
      log.info("Web UI build missing; configure via ~/.config/ode/ode.json");
    }
    startLocalConfigWatcher();
    updateAutoUpgradeScheduler("startup");
  }

  await startSlackRuntime("startup");
  await startDiscordRuntime("startup");
  await startLarkRuntime("startup");
  startCronJobScheduler();
  startTaskScheduler();
  startPrTrackerScheduler();

  if (slackApps.length > 0) {
    log.debug("Slack app created");
    log.debug("Message handlers registered");
    log.debug("Interactive handlers registered");
  }

  // Handle shutdown gracefully
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      log.debug("Shutdown already in progress, ignoring signal", { signal });
      return;
    }
    shuttingDown = true;
    log.debug("Shutting down...", { signal });

    try {
      stopCronJobScheduler();
      stopTaskScheduler();
      stopPrTrackerScheduler();
      stopOAuthServer();
      await stopSlackRuntime("shutdown");
      await stopDiscordRuntime("shutdown");
      await stopLarkRuntime("shutdown");
      if (webDevServer) {
        webDevServer.kill();
        webDevServer = null;
      }
      stopLocalWebServer();
      if (stopConfigWatcher) {
        stopConfigWatcher();
      }
      stopAutoUpgradeScheduler();
      await stopAllServers();
      try {
        const dumpPath = deliveryStats.dumpToFileSync();
        log.info("Delivery stats snapshot written", { dumpPath });
      } catch (err) {
        log.warn("Failed to write delivery stats snapshot on shutdown", {
          error: String(err),
        });
      }
      await shutdownSentry();
      log.debug("Cleanup complete");
      process.exit(0);
    } catch (err) {
      log.error("Error during cleanup", { error: String(err) });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Give connections time to establish before recovery
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Recover any interrupted requests from previous run
  await recoverPendingRequestsAcrossPlatforms();

  if (slackApps.length > 0) {
    log.debug("Bot is running in Socket Mode");
  }

  const readyMessage = `Ode is ready! Waiting for messages, setting UI is accessible at ${getLocalSettingsUrl()}`;
  console.log(readyMessage);
  markRuntimeReady(readyMessage, CURRENT_VERSION);
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err) });
  process.exit(1);
});
