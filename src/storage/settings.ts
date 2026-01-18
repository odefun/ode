import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { normalizeCwd } from "../config/env";

// Use XDG state directory for persistent data
const XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const ODE_STATE_DIR = join(XDG_STATE_HOME, "ode");
const SETTINGS_FILE = join(ODE_STATE_DIR, "settings.json");
const AGENTS_DIR = join(ODE_STATE_DIR, "agents");
const GH_CONFIG_DIR = process.env.GH_CONFIG_DIR || join(XDG_CONFIG_HOME, "gh");
const GH_HOSTS_FILENAME = "hosts.yml";
const GH_HOSTS_FILE = join(GH_CONFIG_DIR, GH_HOSTS_FILENAME);
const GH_USERS_DIR = join(ODE_STATE_DIR, "gh-users");

export interface ChannelSettings {
  customCwd?: string;
  threadSessions: Record<string, string>; // threadId -> sessionId
  agentOverrides?: {
    agent?: string;
    model?: string;
    provider?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  };
  activeThreads: Record<string, number>; // threadId -> timestamp
}

export interface PendingRestartMessage {
  channelId: string;
  messageTs: string;
  createdAt: number;
}

export interface Settings {
  channels: Record<string, ChannelSettings>;
  globalCwd: string;
  pendingRestartMessages?: PendingRestartMessage[];
  oauthState?: {
    state: string;
    channelId: string;
    threadId?: string;
    createdAt: number;
  };
}

let cachedSettings: Settings | null = null;

function ensureDataDir(): void {
  if (!existsSync(ODE_STATE_DIR)) {
    mkdirSync(ODE_STATE_DIR, { recursive: true });
  }
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

export function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  ensureDataDir();

  if (!existsSync(SETTINGS_FILE)) {
    cachedSettings = {
      channels: {},
      globalCwd: normalizeCwd(process.cwd()),
    };
    return cachedSettings;
  }

  try {
    const data = readFileSync(SETTINGS_FILE, "utf-8");
    cachedSettings = JSON.parse(data);
    const currentSettings = cachedSettings || {
      channels: {},
      globalCwd: normalizeCwd(process.cwd()),
    };
    if (!currentSettings.globalCwd) {
      currentSettings.globalCwd = normalizeCwd(process.cwd());
    } else {
      currentSettings.globalCwd = normalizeCwd(currentSettings.globalCwd);
    }
    cachedSettings = currentSettings;
    return currentSettings;
  } catch {
    cachedSettings = {
      channels: {},
      globalCwd: normalizeCwd(process.cwd()),
    };
    return cachedSettings;
  }
}

function normalizeChannelSettings(settings: ChannelSettings): ChannelSettings {
  const customCwd = settings.customCwd ? normalizeCwd(settings.customCwd) : undefined;
  if (customCwd === settings.customCwd) return settings;
  return { ...settings, customCwd };
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  cachedSettings = settings;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getPendingRestartMessages(): PendingRestartMessage[] {
  const settings = loadSettings();
  return settings.pendingRestartMessages ?? [];
}

export function addPendingRestartMessage(channelId: string, messageTs: string): void {
  const settings = loadSettings();
  const pending = settings.pendingRestartMessages ?? [];
  pending.push({ channelId, messageTs, createdAt: Date.now() });
  settings.pendingRestartMessages = pending;
  saveSettings(settings);
}

export function clearPendingRestartMessages(): void {
  const settings = loadSettings();
  if (!settings.pendingRestartMessages?.length) return;
  settings.pendingRestartMessages = [];
  saveSettings(settings);
}

export function getChannelSettings(channelId: string): ChannelSettings {
  const settings = loadSettings();
  if (!settings.channels[channelId]) {
    settings.channels[channelId] = {
      threadSessions: {},
      activeThreads: {},
    };
    saveSettings(settings);
  }
  // Migration: ensure threadSessions exists
  if (!settings.channels[channelId].threadSessions) {
    settings.channels[channelId].threadSessions = {};
    saveSettings(settings);
  }
  const normalized = normalizeChannelSettings(settings.channels[channelId]);
  if (normalized !== settings.channels[channelId]) {
    settings.channels[channelId] = normalized;
    saveSettings(settings);
  }
  return settings.channels[channelId];
}

export function updateChannelSettings(
  channelId: string,
  updates: Partial<ChannelSettings>
): void {
  const settings = loadSettings();
  const merged = {
    ...getChannelSettings(channelId),
    ...updates,
  };
  settings.channels[channelId] = normalizeChannelSettings(merged);
  saveSettings(settings);
}

export function getChannelCwd(channelId: string, defaultCwd: string): string {
  const channelSettings = getChannelSettings(channelId);
  return channelSettings.customCwd || defaultCwd;
}

export function setChannelCwd(channelId: string, cwd: string): void {
  // Clear thread sessions when cwd changes (sessions are project-scoped)
  updateChannelSettings(channelId, { customCwd: normalizeCwd(cwd), threadSessions: {} });
}

// Per-channel agents.md management
export function getChannelAgentsMd(channelId: string): string | null {
  const filePath = join(AGENTS_DIR, `${channelId}.md`);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function setChannelAgentsMd(channelId: string, content: string): void {
  ensureDataDir();
  const filePath = join(AGENTS_DIR, `${channelId}.md`);
  writeFileSync(filePath, content);
}

export function deleteChannelAgentsMd(channelId: string): void {
  const filePath = join(AGENTS_DIR, `${channelId}.md`);
  if (existsSync(filePath)) {
    const { unlinkSync } = require("fs");
    unlinkSync(filePath);
  }
}

export type AgentInstructionTarget = "plan" | "build";

function getAgentInstructionsFile(channelId: string, agent: AgentInstructionTarget): string {
  return join(AGENTS_DIR, `${channelId}.${agent}.md`);
}

export function getChannelAgentInstructions(
  channelId: string,
  agent: AgentInstructionTarget
): string | null {
  const filePath = getAgentInstructionsFile(channelId, agent);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

export function setChannelAgentInstructions(
  channelId: string,
  agent: AgentInstructionTarget,
  content: string
): void {
  ensureDataDir();
  const filePath = getAgentInstructionsFile(channelId, agent);
  writeFileSync(filePath, content);
}

export function deleteChannelAgentInstructions(
  channelId: string,
  agent: AgentInstructionTarget
): void {
  const filePath = getAgentInstructionsFile(channelId, agent);
  if (existsSync(filePath)) {
    const { unlinkSync } = require("fs");
    unlinkSync(filePath);
  }
}

// Session management (one session per thread)
export function getOpenCodeSession(channelId: string, threadId: string): string | null {
  const channelSettings = getChannelSettings(channelId);
  return channelSettings.threadSessions[threadId] || null;
}

export function setOpenCodeSession(channelId: string, threadId: string, sessionId: string): void {
  const channelSettings = getChannelSettings(channelId);
  channelSettings.threadSessions[threadId] = sessionId;
  updateChannelSettings(channelId, {
    threadSessions: channelSettings.threadSessions,
  });
}

export function clearOpenCodeSessions(channelId: string): void {
  updateChannelSettings(channelId, { threadSessions: {} });
}

// Thread tracking
export function markThreadActive(
  channelId: string,
  threadId: string
): void {
  const channelSettings = getChannelSettings(channelId);
  channelSettings.activeThreads[threadId] = Date.now();
  updateChannelSettings(channelId, {
    activeThreads: channelSettings.activeThreads,
  });
}

const ACTIVE_THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isThreadActive(channelId: string, threadId: string): boolean {
  const channelSettings = getChannelSettings(channelId);
  const timestamp = channelSettings.activeThreads[threadId];
  if (!timestamp) return false;
  // Consider threads active for 24 hours
  return Date.now() - timestamp < ACTIVE_THREAD_WINDOW_MS;
}

export interface ActiveThreadInfo {
  channelId: string;
  threadId: string;
  lastActiveAt: number;
}

export function getActiveThreads(): ActiveThreadInfo[] {
  const settings = loadSettings();
  const activeThreads: ActiveThreadInfo[] = [];

  for (const [channelId, channelSettings] of Object.entries(settings.channels)) {
    const threads = channelSettings.activeThreads ?? {};
    for (const [threadId, lastActiveAt] of Object.entries(threads)) {
      if (Date.now() - lastActiveAt < ACTIVE_THREAD_WINDOW_MS) {
        activeThreads.push({ channelId, threadId, lastActiveAt });
      }
    }
  }

  return activeThreads;
}

// OAuth state management
export function setOAuthState(
  state: string,
  channelId: string,
  threadId?: string
): void {
  const settings = loadSettings();
  settings.oauthState = {
    state,
    channelId,
    threadId,
    createdAt: Date.now(),
  };
  saveSettings(settings);
}

export function getOAuthState(): Settings["oauthState"] {
  const settings = loadSettings();
  return settings.oauthState;
}

export function clearOAuthState(): void {
  const settings = loadSettings();
  delete settings.oauthState;
  saveSettings(settings);
}

export interface GitHubAuthInfo {
  host: string;
  user?: string;
  gitProtocol?: string;
  hasToken: boolean;
}

export interface GitHubAuthRecord {
  host: string;
  user?: string;
  token: string;
  gitProtocol?: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export function normalizeGitHubHost(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const noProtocol = trimmed.replace(/^https?:\/\//, "");
  const host = noProtocol.split(/[/?#]/)[0];
  return host || null;
}

function ensureGitHubConfigDir(): void {
  if (!existsSync(GH_CONFIG_DIR)) {
    mkdirSync(GH_CONFIG_DIR, { recursive: true });
  }
}

function ensureGitHubUserDir(userId: string): void {
  const userDir = join(GH_USERS_DIR, userId);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
}

export function getGitHubUserConfigDir(userId: string): string {
  return join(GH_USERS_DIR, userId);
}

function getGitHubUserHostsFile(userId: string): string {
  return join(GH_USERS_DIR, userId, GH_HOSTS_FILENAME);
}

function parseGitHubHosts(contents: string): Record<string, Record<string, string>> {
  const hosts: Record<string, Record<string, string>> = {};
  let currentHost: string | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!line.startsWith(" ") && trimmed.endsWith(":")) {
      currentHost = trimmed.slice(0, -1).trim();
      if (currentHost) {
        hosts[currentHost] = hosts[currentHost] || {};
      }
      continue;
    }

    if (!currentHost) continue;
    const hostKey = currentHost;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1];
    if (!field) continue;
    hosts[hostKey] = hosts[hostKey] || {};
    hosts[hostKey][field] = match[2] ?? "";
  }

  return hosts;
}

function serializeGitHubHosts(hosts: Record<string, Record<string, string>>): string {
  const lines: string[] = [];
  for (const [host, entries] of Object.entries(hosts)) {
    lines.push(`${host}:`);
    for (const [key, value] of Object.entries(entries)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function readGitHubHosts(filePath: string): Record<string, Record<string, string>> {
  if (!existsSync(filePath)) return {};
  const contents = readFileSync(filePath, "utf-8");
  return parseGitHubHosts(contents);
}

function writeGitHubHosts(filePath: string, hosts: Record<string, Record<string, string>>): void {
  const dirPath = dirname(filePath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  writeFileSync(filePath, serializeGitHubHosts(hosts));
}

function getGitHubAuthFromFile(filePath: string, host: string): GitHubAuthInfo | null {
  if (!existsSync(filePath)) return null;
  const hosts = readGitHubHosts(filePath);
  const entry = hosts[host];
  if (!entry) return null;
  return {
    host,
    user: entry.user,
    gitProtocol: entry.git_protocol,
    hasToken: Boolean(entry.oauth_token),
  };
}

function getGitHubAuthRecordFromFile(filePath: string, host: string): GitHubAuthRecord | null {
  if (!existsSync(filePath)) return null;
  const hosts = readGitHubHosts(filePath);
  const entry = hosts[host];
  if (!entry?.oauth_token) return null;
  return {
    host,
    user: entry.user,
    token: entry.oauth_token,
    gitProtocol: entry.git_protocol,
  };
}

function saveGitHubAuthToFile(
  filePath: string,
  params: {
    host: string;
    user?: string;
    token: string;
    gitProtocol?: string;
  }
): void {
  const existing = readGitHubHosts(filePath);
  const entry = { ...(existing[params.host] || {}) };
  if (params.user) entry.user = params.user;
  entry.oauth_token = params.token;
  entry.git_protocol = params.gitProtocol || entry.git_protocol || "https";
  existing[params.host] = entry;
  writeGitHubHosts(filePath, existing);
}

export function getGitHubAuth(host = "github.com"): GitHubAuthInfo | null {
  return getGitHubAuthFromFile(GH_HOSTS_FILE, host);
}

export function getGitHubAuthForUser(
  userId: string,
  host = "github.com"
): GitHubAuthInfo | null {
  return getGitHubAuthFromFile(getGitHubUserHostsFile(userId), host);
}

export function getGitHubAuthRecord(host = "github.com"): GitHubAuthRecord | null {
  return getGitHubAuthRecordFromFile(GH_HOSTS_FILE, host);
}

export function getGitHubAuthRecordForUser(
  userId: string,
  host = "github.com"
): GitHubAuthRecord | null {
  return getGitHubAuthRecordFromFile(getGitHubUserHostsFile(userId), host);
}

export function activateGitHubAuthForUser(
  userId: string,
  host = "github.com"
): GitHubAuthInfo | null {
  const record = getGitHubAuthRecordForUser(userId, host) ?? getGitHubAuthRecord(host);
  if (!record) return null;
  saveGitHubAuth(record);
  return {
    host: record.host,
    user: record.user,
    gitProtocol: record.gitProtocol,
    hasToken: true,
  };
}

export function getGitIdentityForUser(
  userId: string,
  host = "github.com"
): GitIdentity | null {
  const record = getGitHubAuthRecordForUser(userId, host) ?? getGitHubAuthRecord(host);
  if (!record?.user) return null;
  return {
    name: record.user,
    email: `${record.user}@users.noreply.github.com`,
  };
}

export function saveGitHubAuth(params: {
  host: string;
  user?: string;
  token: string;
  gitProtocol?: string;
}): void {
  ensureGitHubConfigDir();
  saveGitHubAuthToFile(GH_HOSTS_FILE, params);
}

export function saveGitHubAuthForUser(params: {
  userId: string;
  host: string;
  user?: string;
  token: string;
  gitProtocol?: string;
}): void {
  ensureGitHubUserDir(params.userId);
  saveGitHubAuthToFile(getGitHubUserHostsFile(params.userId), params);
}
