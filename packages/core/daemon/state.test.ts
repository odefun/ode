import { describe, expect, it } from "bun:test";
import { isRuntimeReadyAfter, type DaemonState, type RuntimeReadyMarker } from "./state";

function readyState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    managerPid: 10,
    runtimePid: 20,
    runtimeVersion: "2.0.4",
    status: "ready",
    readyMessage: "Ode is ready",
    lastReadyAt: 200,
    lastStartAt: 150,
    lastExitAt: null,
    lastExitCode: null,
    lastExitSignal: null,
    restartCount: 0,
    pendingUpgradeRestart: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe("isRuntimeReadyAfter", () => {
  const previous: RuntimeReadyMarker = { runtimePid: 20, lastReadyAt: 200 };

  it("rejects the stale ready state that existed before restart", () => {
    expect(isRuntimeReadyAfter(readyState(), previous)).toBe(false);
  });

  it("accepts a newly ready runtime generation", () => {
    expect(isRuntimeReadyAfter(readyState({ runtimePid: 21, lastReadyAt: 250 }), previous)).toBe(true);
  });

  it("requires both a new process and a newer ready timestamp", () => {
    expect(isRuntimeReadyAfter(readyState({ runtimePid: 21 }), previous)).toBe(false);
    expect(isRuntimeReadyAfter(readyState({ lastReadyAt: 250 }), previous)).toBe(false);
  });

  it("accepts the first ready runtime when none was previously running", () => {
    expect(isRuntimeReadyAfter(readyState(), { runtimePid: null, lastReadyAt: null })).toBe(true);
  });

  it("rejects incomplete ready state", () => {
    expect(isRuntimeReadyAfter(readyState({ status: "starting", readyMessage: null }), previous)).toBe(false);
  });
});
