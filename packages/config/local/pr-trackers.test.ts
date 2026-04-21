import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { invalidateOdeConfigCache, ODE_CONFIG_FILE } from "./ode-store";
import type { GitHubRepo } from "@/utils/git-remote";
import {
  clearPrTrackersForTests,
  closePrTrackerDatabaseForTests,
  DEFAULT_PR_POLL_INTERVAL_SEC,
  DEFAULT_PR_PROMPT_TEMPLATE,
  deletePrTracker,
  getPrTrackerById,
  getPrTrackerSettings,
  listDuePrTrackers,
  listPrTrackerEvents,
  listPrTrackers,
  listProcessedEventIds,
  markPrTrackerPolled,
  recordPrTrackerEvent,
  scanPrTrackers,
  setPrTrackerCursor,
  updatePrTracker,
  updatePrTrackerSettings,
} from "./pr-trackers";

let tempDir: string;
let originalConfigEnv: string | undefined;
let originalConfigContent: string | null;
let originalConfigExisted: boolean;

function writeTestOdeConfig(channels: Array<{ id: string; name: string; cwd?: string }>): void {
  const config = {
    user: {},
    workspaces: [
      {
        id: "ws-test",
        name: "Test Workspace",
        type: "slack",
        channelDetails: channels.map((c) => ({
          id: c.id,
          name: c.name,
          ...(c.cwd ? { workingDirectory: c.cwd } : {}),
        })),
      },
    ],
  };
  fs.mkdirSync(path.dirname(ODE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(ODE_CONFIG_FILE, JSON.stringify(config));
  invalidateOdeConfigCache();
}

/** Make a deterministic probe that returns a fixed repo for a given cwd. */
function makeProbe(
  mapping: Record<string, GitHubRepo | null>,
): (cwd: string) => GitHubRepo | null {
  return (cwd: string) => {
    if (cwd in mapping) return mapping[cwd] ?? null;
    return null;
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-pr-trackers-test-"));
  originalConfigEnv = process.env.ODE_INBOX_DB_FILE;
  process.env.ODE_INBOX_DB_FILE = path.join(tempDir, "inbox.db");

  originalConfigExisted = fs.existsSync(ODE_CONFIG_FILE);
  originalConfigContent = originalConfigExisted
    ? fs.readFileSync(ODE_CONFIG_FILE, "utf-8")
    : null;

  writeTestOdeConfig([
    { id: "C_DEV", name: "dev", cwd: "/tmp/repos/ode" },
    { id: "C_WEB", name: "web", cwd: "/tmp/repos/web-ui" },
    { id: "C_EMPTY", name: "empty" },
  ]);

  closePrTrackerDatabaseForTests();
  clearPrTrackersForTests();
});

afterEach(() => {
  closePrTrackerDatabaseForTests();
  if (originalConfigEnv === undefined) {
    delete process.env.ODE_INBOX_DB_FILE;
  } else {
    process.env.ODE_INBOX_DB_FILE = originalConfigEnv;
  }

  try {
    if (originalConfigExisted && originalConfigContent !== null) {
      fs.writeFileSync(ODE_CONFIG_FILE, originalConfigContent);
    } else {
      fs.rmSync(ODE_CONFIG_FILE, { force: true });
    }
  } catch {
    // Best effort.
  }
  invalidateOdeConfigCache();

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort.
  }
});

describe("pr-trackers settings", () => {
  test("returns defaults on first access", () => {
    const settings = getPrTrackerSettings();
    expect(settings.defaultPollIntervalSec).toBe(DEFAULT_PR_POLL_INTERVAL_SEC);
    expect(settings.defaultPromptTemplate).toBe(DEFAULT_PR_PROMPT_TEMPLATE);
    expect(settings.defaultGithubToken).toBe("");
  });

  test("updates persist", () => {
    updatePrTrackerSettings({
      defaultPollIntervalSec: 600,
      defaultGithubToken: " ghp_abc ",
    });
    const settings = getPrTrackerSettings();
    expect(settings.defaultPollIntervalSec).toBe(600);
    expect(settings.defaultGithubToken).toBe("ghp_abc");
  });

  test("rejects too-short poll interval", () => {
    expect(() => updatePrTrackerSettings({ defaultPollIntervalSec: 30 })).toThrow();
  });
});

describe("pr-trackers scan", () => {
  test("inserts rows for channels with GitHub remotes", () => {
    const probe = makeProbe({
      "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" },
      "/tmp/repos/web-ui": { host: "github.com", owner: "anomalyco", repo: "web-ui" },
    });
    const result = scanPrTrackers(probe);
    expect(result.inserted).toBe(2);
    expect(result.scanned).toBe(2); // C_EMPTY has no cwd → not scanned

    const trackers = listPrTrackers();
    expect(trackers).toHaveLength(2);
    expect(trackers.every((t) => !t.enabled)).toBe(true);
    expect(trackers.every((t) => t.missingSince === null)).toBe(true);
    expect(trackers.map((t) => t.repoName).sort()).toEqual(["ode", "web-ui"]);
  });

  test("skips channels whose cwd has no GitHub remote", () => {
    const probe = makeProbe({
      "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" },
      "/tmp/repos/web-ui": null,
    });
    scanPrTrackers(probe);
    const trackers = listPrTrackers();
    expect(trackers).toHaveLength(1);
    expect(trackers[0]!.repoName).toBe("ode");
  });

  test("idempotent: rescanning doesn't create duplicates", () => {
    const probe = makeProbe({
      "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" },
    });
    scanPrTrackers(probe);
    const first = listPrTrackers();
    scanPrTrackers(probe);
    const second = listPrTrackers();
    expect(second.map((t) => t.id)).toEqual(first.map((t) => t.id));
  });

  test("marks trackers missing when remote disappears", () => {
    const probe = makeProbe({
      "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" },
    });
    scanPrTrackers(probe);
    expect(listPrTrackers()[0]!.missingSince).toBeNull();

    const empty = makeProbe({});
    const result = scanPrTrackers(empty);
    expect(result.markedMissing).toBe(1);
    expect(listPrTrackers()[0]!.missingSince).not.toBeNull();
  });

  test("reactivates a previously-missing tracker when remote comes back", () => {
    const probe = makeProbe({
      "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" },
    });
    scanPrTrackers(probe);
    scanPrTrackers(makeProbe({}));
    expect(listPrTrackers()[0]!.missingSince).not.toBeNull();

    const result = scanPrTrackers(probe);
    expect(result.reactivated).toBe(1);
    expect(listPrTrackers()[0]!.missingSince).toBeNull();
  });
});

describe("pr-trackers enable/update", () => {
  test("enabling a scanned tracker does not require any extra config", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const tracker = listPrTrackers()[0]!;
    const updated = updatePrTracker(tracker.id, { enabled: true });
    expect(updated.enabled).toBe(true);
  });

  test("first enable snaps last_polled_at to now so we don't backfill", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const tracker = listPrTrackers()[0]!;
    expect(tracker.lastPolledAt).toBeNull();

    const before = Date.now();
    const updated = updatePrTracker(tracker.id, {
      enabled: true,
    });
    const after = Date.now();

    expect(updated.enabled).toBe(true);
    expect(updated.lastPolledAt).not.toBeNull();
    expect(updated.lastPolledAt!).toBeGreaterThanOrEqual(before);
    expect(updated.lastPolledAt!).toBeLessThanOrEqual(after);
  });

  test("disabling then re-enabling preserves the poll cursor", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    const enabled = updatePrTracker(id, { enabled: true });
    const originalCursor = enabled.lastPolledAt!;

    updatePrTracker(id, { enabled: false });
    // Simulate time passing + a successful poll.
    markPrTrackerPolled(id, { success: true, pollCompletedAt: originalCursor + 10_000 });
    const afterPoll = getPrTrackerById(id)!;
    expect(afterPoll.lastPolledAt).toBe(originalCursor + 10_000);

    const reEnabled = updatePrTracker(id, { enabled: true });
    expect(reEnabled.lastPolledAt).toBe(originalCursor + 10_000);
  });

  test("cannot enable a tracker whose source repo is missing", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    scanPrTrackers(makeProbe({}));
    const id = listPrTrackers()[0]!.id;
    expect(() =>
      updatePrTracker(id, { enabled: true })
    ).toThrow(/missing/);
  });

  test("deletePrTracker removes the row and its events", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    recordPrTrackerEvent({
      trackerId: id,
      prNumber: 1,
      eventType: "comment",
      githubEventId: "c1",
    });
    deletePrTracker(id);
    expect(listPrTrackers()).toHaveLength(0);
    expect(listPrTrackerEvents(id)).toHaveLength(0);
  });
});

describe("pr-trackers due selection", () => {
  test("enabled trackers with stale cursor are due", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    updatePrTracker(id, { enabled: true, pollIntervalSec: 60 });
    // Simulate a very old last-poll timestamp.
    markPrTrackerPolled(id, { success: true, pollCompletedAt: 0 });
    const due = listDuePrTrackers(Date.now());
    expect(due.map((t) => t.id)).toContain(id);
  });

  test("recently polled trackers are not due", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    updatePrTracker(id, { enabled: true, pollIntervalSec: 1800 });
    markPrTrackerPolled(id, { success: true });
    expect(listDuePrTrackers(Date.now())).toHaveLength(0);
  });

  test("disabled trackers are never due", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    expect(listDuePrTrackers(Date.now())).toHaveLength(0);
  });
});

describe("pr-trackers events", () => {
  test("recordPrTrackerEvent dedupes on (tracker, type, event_id)", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;

    expect(
      recordPrTrackerEvent({ trackerId: id, prNumber: 1, eventType: "comment", githubEventId: "c1" })
    ).toBe(true);
    expect(
      recordPrTrackerEvent({ trackerId: id, prNumber: 1, eventType: "comment", githubEventId: "c1" })
    ).toBe(false);
    // Different type, same id → new row.
    expect(
      recordPrTrackerEvent({ trackerId: id, prNumber: 1, eventType: "review", githubEventId: "c1" })
    ).toBe(true);
  });

  test("listProcessedEventIds finds only previously-recorded ids", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    recordPrTrackerEvent({ trackerId: id, prNumber: 1, eventType: "comment", githubEventId: "c1" });
    recordPrTrackerEvent({ trackerId: id, prNumber: 1, eventType: "comment", githubEventId: "c2" });

    const seen = listProcessedEventIds(id, "comment", ["c1", "c2", "c3"]);
    expect(Array.from(seen).sort()).toEqual(["c1", "c2"]);
  });
});

describe("pr-trackers poll cursor semantics", () => {
  test("markPrTrackerPolled(success) advances last_polled_at", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    const before = Date.now();
    markPrTrackerPolled(id, { success: true });
    const after = Date.now();
    const tracker = getPrTrackerById(id)!;
    expect(tracker.lastPolledAt!).toBeGreaterThanOrEqual(before);
    expect(tracker.lastPolledAt!).toBeLessThanOrEqual(after);
    expect(tracker.lastSuccessAt!).toBeGreaterThanOrEqual(before);
    expect(tracker.lastError).toBeNull();
  });

  test("markPrTrackerPolled(failure) leaves last_polled_at untouched", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    // Seed an initial success so we can observe that the next failure
    // doesn't move the cursor.
    markPrTrackerPolled(id, { success: true, pollCompletedAt: 1_000_000 });
    const anchor = getPrTrackerById(id)!.lastPolledAt;
    expect(anchor).toBe(1_000_000);

    markPrTrackerPolled(id, { success: false, errorMessage: "boom" });
    const after = getPrTrackerById(id)!;
    expect(after.lastPolledAt).toBe(1_000_000); // unchanged
    expect(after.lastError).toBe("boom");
  });

  test("setPrTrackerCursor writes the cursor verbatim", () => {
    scanPrTrackers(
      makeProbe({ "/tmp/repos/ode": { host: "github.com", owner: "anomalyco", repo: "ode" } })
    );
    const id = listPrTrackers()[0]!.id;
    setPrTrackerCursor(id, 42_000);
    expect(getPrTrackerById(id)!.lastPolledAt).toBe(42_000);
  });
});
