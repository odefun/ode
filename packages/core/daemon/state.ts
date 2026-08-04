import { readFileSync, writeFileSync } from "fs";
import { getDaemonStatePath, ensureDaemonDir } from "./paths";

export type DaemonStatus = "stopped" | "starting" | "ready" | "restarting" | "error";

export interface PendingUpgradeRestart {
  reason: string;
  scheduledAt: number;
}

export interface DaemonState {
  managerPid: number | null;
  runtimePid: number | null;
  runtimeVersion: string | null;
  status: DaemonStatus;
  readyMessage: string | null;
  lastReadyAt: number | null;
  lastStartAt: number | null;
  lastExitAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  restartCount: number;
  pendingUpgradeRestart: PendingUpgradeRestart | null;
  createdAt: number;
  updatedAt: number;
}

export type RuntimeReadyMarker = Pick<DaemonState, "runtimePid" | "lastReadyAt">;

export function isRuntimeReadyAfter(state: DaemonState, marker: RuntimeReadyMarker): boolean {
  if (state.status !== "ready" || !state.readyMessage || !state.runtimePid || !state.lastReadyAt) {
    return false;
  }
  if (marker.runtimePid !== null && state.runtimePid === marker.runtimePid) {
    return false;
  }
  if (marker.lastReadyAt !== null && state.lastReadyAt <= marker.lastReadyAt) {
    return false;
  }
  return true;
}

function createDefaultState(): DaemonState {
  const now = Date.now();
  return {
    managerPid: null,
    runtimePid: null,
    runtimeVersion: null,
    status: "stopped",
    readyMessage: null,
    lastReadyAt: null,
    lastStartAt: null,
    lastExitAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    restartCount: 0,
    pendingUpgradeRestart: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeState(state: Partial<DaemonState>): DaemonState {
  const defaults = createDefaultState();
  const pending = state.pendingUpgradeRestart;
  const normalizedPending: PendingUpgradeRestart | null = pending && typeof pending === "object"
    ? {
        reason: typeof pending.reason === "string" && pending.reason.length > 0 ? pending.reason : "auto-upgrade",
        scheduledAt: typeof pending.scheduledAt === "number" && Number.isFinite(pending.scheduledAt)
          ? pending.scheduledAt
          : Date.now(),
      }
    : null;

  const restartCount = typeof state.restartCount === "number" && Number.isFinite(state.restartCount)
    ? state.restartCount
    : defaults.restartCount;

  return {
    managerPid: typeof state.managerPid === "number" ? state.managerPid : defaults.managerPid,
    runtimePid: typeof state.runtimePid === "number" ? state.runtimePid : defaults.runtimePid,
    runtimeVersion: typeof state.runtimeVersion === "string" ? state.runtimeVersion : defaults.runtimeVersion,
    status: state.status ?? defaults.status,
    readyMessage: typeof state.readyMessage === "string" ? state.readyMessage : defaults.readyMessage,
    lastReadyAt: typeof state.lastReadyAt === "number" ? state.lastReadyAt : defaults.lastReadyAt,
    lastStartAt: typeof state.lastStartAt === "number" ? state.lastStartAt : defaults.lastStartAt,
    lastExitAt: typeof state.lastExitAt === "number" ? state.lastExitAt : defaults.lastExitAt,
    lastExitCode: typeof state.lastExitCode === "number" ? state.lastExitCode : defaults.lastExitCode,
    lastExitSignal: typeof state.lastExitSignal === "string" ? state.lastExitSignal : defaults.lastExitSignal,
    restartCount,
    pendingUpgradeRestart: normalizedPending,
    createdAt: typeof state.createdAt === "number" ? state.createdAt : defaults.createdAt,
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : defaults.updatedAt,
  };
}

export function readDaemonState(): DaemonState {
  ensureDaemonDir();
  try {
    const raw = readFileSync(getDaemonStatePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonState>;
    return normalizeState(parsed);
  } catch {
    const defaults = createDefaultState();
    writeFileSync(getDaemonStatePath(), JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

export function writeDaemonState(next: DaemonState): DaemonState {
  ensureDaemonDir();
  const normalized: DaemonState = {
    ...next,
    updatedAt: Date.now(),
  };
  writeFileSync(getDaemonStatePath(), JSON.stringify(normalized, null, 2));
  return normalized;
}

export function patchDaemonState(patch: Partial<DaemonState>): DaemonState {
  const current = readDaemonState();
  return writeDaemonState({
    ...current,
    ...patch,
  });
}

export function updateDaemonState(updater: (state: DaemonState) => DaemonState): DaemonState {
  const current = readDaemonState();
  const next = updater(current);
  return writeDaemonState(next);
}

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
