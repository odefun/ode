import { App } from "@slack/bolt";
import { loadEnv } from "../config";
import { getAllBotTokens, type WorkspaceToken } from "../db";
import { log } from "../logger";

export interface WorkspaceApp {
  app: App;
  botToken: string;
  workspaceName: string;
  botUserId?: string;
}

// Map of bot token -> WorkspaceApp
const workspaceApps = new Map<string, WorkspaceApp>();

/**
 * Creates a Slack App instance for a specific workspace
 */
function createWorkspaceApp(botToken: string, workspaceName: string): WorkspaceApp {
  const env = loadEnv();

  const app = new App({
    token: botToken,
    signingSecret: env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: env.SLACK_APP_TOKEN,
  });

  return {
    app,
    botToken,
    workspaceName,
  };
}

/**
 * Initialize all workspace apps from database + env
 */
export async function initializeWorkspaceApps(): Promise<WorkspaceApp[]> {
  const env = loadEnv();
  const apps: WorkspaceApp[] = [];

  // Start with the env bot token
  const envBotToken = env.SLACK_BOT_TOKEN;
  const envWorkspaceApp = createWorkspaceApp(envBotToken, "default (env)");
  workspaceApps.set(envBotToken, envWorkspaceApp);
  apps.push(envWorkspaceApp);
  log.info("Created Slack app for workspace", { workspace: "default (env)" });

  // Fetch additional tokens from database
  const dbTokens = await getAllBotTokens();

  for (const tokenRecord of dbTokens) {
    // Skip if it's the same as env token
    if (tokenRecord.botToken === envBotToken) {
      log.debug("Skipping database token (same as env)", {
        workspace: tokenRecord.workspaceName,
      });
      continue;
    }

    // Skip if already added
    if (workspaceApps.has(tokenRecord.botToken)) {
      log.debug("Skipping duplicate token", {
        workspace: tokenRecord.workspaceName,
      });
      continue;
    }

    const workspaceName = tokenRecord.workspaceName || `workspace-${apps.length}`;
    const workspaceApp = createWorkspaceApp(tokenRecord.botToken, workspaceName);
    workspaceApps.set(tokenRecord.botToken, workspaceApp);
    apps.push(workspaceApp);
    log.info("Created Slack app for workspace", { workspace: workspaceName });
  }

  log.info("Initialized all workspace apps", { count: apps.length });
  return apps;
}

/**
 * Get all initialized workspace apps
 */
export function getWorkspaceApps(): WorkspaceApp[] {
  return Array.from(workspaceApps.values());
}

/**
 * Get a workspace app by bot token
 */
export function getWorkspaceApp(botToken: string): WorkspaceApp | undefined {
  return workspaceApps.get(botToken);
}

/**
 * Start all workspace apps
 */
export async function startAllWorkspaces(): Promise<void> {
  const apps = getWorkspaceApps();

  for (const workspaceApp of apps) {
    try {
      await workspaceApp.app.start();
      log.info("Started Slack app for workspace", {
        workspace: workspaceApp.workspaceName,
      });
    } catch (err) {
      log.error("Failed to start Slack app for workspace", {
        workspace: workspaceApp.workspaceName,
        error: String(err),
      });
    }
  }
}

/**
 * Stop all workspace apps
 */
export async function stopAllWorkspaces(): Promise<void> {
  const apps = getWorkspaceApps();

  for (const workspaceApp of apps) {
    try {
      await workspaceApp.app.stop();
      log.info("Stopped Slack app for workspace", {
        workspace: workspaceApp.workspaceName,
      });
    } catch (err) {
      log.error("Failed to stop Slack app for workspace", {
        workspace: workspaceApp.workspaceName,
        error: String(err),
      });
    }
  }

  workspaceApps.clear();
}

/**
 * Set the bot user ID for a workspace (called after auth.test)
 */
export function setWorkspaceBotUserId(botToken: string, botUserId: string): void {
  const workspaceApp = workspaceApps.get(botToken);
  if (workspaceApp) {
    workspaceApp.botUserId = botUserId;
  }
}

/**
 * Get workspace name by bot token
 */
export function getWorkspaceName(botToken: string): string {
  const workspaceApp = workspaceApps.get(botToken);
  return workspaceApp?.workspaceName || "unknown";
}
