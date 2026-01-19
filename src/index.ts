import {
  setupMessageHandlers,
  setupSlashCommands,
  setupInteractiveHandlers,
  stopOAuthServer,
  recoverPendingRequests,
  initializeWorkspaceApps,
  startAllWorkspaces,
  stopAllWorkspaces,
} from "./slack";
import { spawn } from "child_process";
import { stopServer } from "./agents";
import { loadEnv } from "./config";
import { log } from "./logger";

async function main(): Promise<void> {
  log.info("Starting Ode...");

  // Load and validate environment
  const env = loadEnv();
  log.info("Config loaded", { logLevel: env.LOG_LEVEL, defaultCwd: env.DEFAULT_CWD });

  // Initialize all workspace apps (from env + database)
  const workspaceApps = await initializeWorkspaceApps();
  log.info("Initialized workspace apps", { count: workspaceApps.length });

  // Setup handlers for each workspace
  for (const workspaceApp of workspaceApps) {
    setupMessageHandlers(workspaceApp);
    log.info("Message handlers registered", { workspace: workspaceApp.workspaceName });
  }

  // Setup slash commands and interactive handlers for all workspaces
  for (const workspaceApp of workspaceApps) {
    setupSlashCommands(workspaceApp.app);
    setupInteractiveHandlers(workspaceApp.app);
    log.info("Slash commands and interactive handlers registered", {
      workspace: workspaceApp.workspaceName,
    });
  }

  // Handle shutdown gracefully
  const shutdown = async (signal: string) => {
    log.info("Shutting down...", { signal });

    try {
      stopOAuthServer();
      await stopServer();
      await stopAllWorkspaces();
      log.info("Cleanup complete");
      process.exit(0);
    } catch (err) {
      log.error("Error during cleanup", { error: String(err) });
      process.exit(1);
    }
  };

  let restartScheduled = false;
  const scheduleRestart = (signal: string) => {
    if (restartScheduled) return;
    restartScheduled = true;

    const delayMs = 3000;
    log.info("Restart signal received", { signal, delayMs });

    setTimeout(async () => {
      log.info("Restarting Ode process", { delayMs });
      const child = spawn("bash", ["/root/ode/restart.sh"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      await shutdown("restart");
    }, delayMs);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGUSR2", () => scheduleRestart("SIGUSR2"));

  // Start all workspace apps
  await startAllWorkspaces();
  log.info("All bots running in Socket Mode", { workspaces: workspaceApps.length });

  // Give socket connection time to fully establish before recovery
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Recover any interrupted requests from previous run
  await recoverPendingRequests();

  log.info("Ode is ready! Waiting for messages...", {
    workspaces: workspaceApps.map((w) => w.workspaceName),
  });
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err) });
  process.exit(1);
});
