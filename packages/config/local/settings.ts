import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { writeFile } from "fs/promises";
import {
  setChannelCwd as setChannelCwdInConfig,
} from "./ode";
import { loadSession, updateSessionIdForThread } from "./sessions";
import type { AgentProviderId } from "@/shared/agent-provider";

const readFileSync = fs.readFileSync;
const mkdirSync = fs.mkdirSync;
const join = typeof path.join === "function" ? path.join : (...parts: string[]) => parts.join("/");
const homedir = typeof os.homedir === "function" ? os.homedir : () => "";

const ODE_CONFIG_DIR = join(homedir(), ".config", "ode");
const SETTINGS_FILE = join(ODE_CONFIG_DIR, "settings.json");
const SETTINGS_SAVE_DEBOUNCE_MS = 1000;

export interface ChannelSettings {
  threadSessions: Record<string, string>; // threadId -> sessionId
  activeThreads: Record<string, number>; // threadId -> timestamp
}

export interface PendingRestartMessage {
  channelId: string;
  messageTs: string;
  createdAt: number;
}

export interface Settings {
  channels: Record<string, ChannelSettings>;
  pendingRestartMessages?: PendingRestartMessage[];
}

let cachedSettings: Settings | null = null;
let pendingSettingsWriteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSettingsSnapshot: Settings | null = null;
let settingsWriteChain: Promise<void> = Promise.resolve();

function ensureDataDir(): void {
  mkdirSync(ODE_CONFIG_DIR, { recursive: true });
}

export function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  ensureDataDir();
  const emptySettings: Settings = { channels: {} };

  try {
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const rawChannels = parsed.channels ?? {};
    const normalizedChannels: Record<string, ChannelSettings> = {};

    for (const [channelId, settings] of Object.entries(rawChannels)) {
      normalizedChannels[channelId] = normalizeChannelSettings(
        settings as ChannelSettings
      );
    }

    cachedSettings = {
      ...emptySettings,
      ...parsed,
      channels: normalizedChannels,
    };
    return cachedSettings;
  } catch {
    cachedSettings = emptySettings;
    return cachedSettings;
  }
}

function normalizeChannelSettings(settings: ChannelSettings): ChannelSettings {
  const hasThreadSessions = Boolean(settings.threadSessions);
  const hasActiveThreads = Boolean(settings.activeThreads);
  if (hasThreadSessions && hasActiveThreads) return settings;
  return {
    ...settings,
    threadSessions: settings.threadSessions ?? {},
    activeThreads: settings.activeThreads ?? {},
  };
}

export function saveSettings(settings: Settings): void {
  ensureDataDir();
  const normalizedChannels: Record<string, ChannelSettings> = {};
  for (const [channelId, channelSettings] of Object.entries(settings.channels ?? {})) {
    normalizedChannels[channelId] = normalizeChannelSettings(channelSettings);
  }
  cachedSettings = {
    ...settings,
    channels: normalizedChannels,
  };

  pendingSettingsSnapshot = structuredClone(cachedSettings);
  if (pendingSettingsWriteTimer) {
    clearTimeout(pendingSettingsWriteTimer);
    pendingSettingsWriteTimer = null;
  }

  pendingSettingsWriteTimer = setTimeout(() => {
    pendingSettingsWriteTimer = null;
    const snapshot = pendingSettingsSnapshot;
    if (!snapshot) return;
    pendingSettingsSnapshot = null;
    const payload = JSON.stringify(snapshot, null, 2);
    settingsWriteChain = settingsWriteChain
      .catch(() => undefined)
      .then(async () => {
        await writeFile(SETTINGS_FILE, payload, "utf-8");
      })
      .catch(() => undefined);
  }, SETTINGS_SAVE_DEBOUNCE_MS);
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

  const existing = settings.channels[channelId] ?? {
    threadSessions: {},
    activeThreads: {},
  };
  const merged = {
    ...existing,
    ...updates,
  };
  settings.channels[channelId] = normalizeChannelSettings(merged);
  saveSettings(settings);
}

export function setChannelCwd(channelId: string, cwd: string): void {
  // Clear thread sessions when cwd changes (sessions are project-scoped)
  setChannelCwdInConfig(channelId, cwd);
  updateChannelSettings(channelId, { threadSessions: {} });
}

// Session management (one session per thread)
export function getThreadSessionId(
  channelId: string,
  threadId: string,
  providerId?: AgentProviderId
): string | null {
  const session = loadSession(channelId, threadId);
  if (!session?.sessionId) return null;
  if (providerId && session.providerId !== providerId) {
    return null;
  }
  return session.sessionId;
}

export function setThreadSessionId(channelId: string, threadId: string, sessionId: string): void {
  updateSessionIdForThread(channelId, threadId, sessionId);
}

export function clearThreadSessions(channelId: string): void {
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
