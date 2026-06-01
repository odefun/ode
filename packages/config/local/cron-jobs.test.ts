import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { invalidateOdeConfigCache, ODE_CONFIG_FILE } from "./ode-store";
import {
  CRON_BACKFILL_WINDOW_MS,
  clearCronJobsForTests,
  closeCronJobDatabaseForTests,
  createCronJob,
  disableCronJob,
  getCronJobById,
  markCronJobCompleted,
  markCronJobFailed,
  markCronJobRunning,
  patchCronJob,
  reconcileInterruptedCronJobs,
} from "./cron-jobs";

// Storage-level tests for cron-jobs mirror the pattern used in tasks.test.ts:
// we swap ODE_INBOX_DB_FILE to a per-test tempdir so nothing touches the
// user's real inbox.db, and we stub ode.json so channel lookups succeed.

let tempDir: string;
let originalConfigEnv: string | undefined;
let originalConfigContent: string | null;
let originalConfigExisted: boolean;

function writeTestOdeConfig(): void {
  const config = {
    user: {},
    workspaces: [
      {
        id: "ws-test",
        name: "Test Workspace",
        type: "slack",
        channelDetails: [{ id: "C_TEST", name: "general" }],
      },
    ],
  };
  fs.mkdirSync(path.dirname(ODE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(ODE_CONFIG_FILE, JSON.stringify(config));
  invalidateOdeConfigCache();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-cron-jobs-test-"));
  originalConfigEnv = process.env.ODE_INBOX_DB_FILE;
  process.env.ODE_INBOX_DB_FILE = path.join(tempDir, "inbox.db");

  originalConfigExisted = fs.existsSync(ODE_CONFIG_FILE);
  originalConfigContent = originalConfigExisted
    ? fs.readFileSync(ODE_CONFIG_FILE, "utf-8")
    : null;
  writeTestOdeConfig();

  closeCronJobDatabaseForTests();
  clearCronJobsForTests();
});

afterEach(() => {
  closeCronJobDatabaseForTests();
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

function makeRunningJob(
  overrides: { title?: string; triggeredAtMs?: number } = {},
) {
  const job = createCronJob({
    title: overrides.title ?? "test-job",
    cronExpression: "*/5 * * * *",
    channelId: "C_TEST",
    messageText: "heartbeat",
  });
  // Stamp the row as "currently running". We call the real helper so the
  // test exercises the same SQL the scheduler uses for manual runs.
  markCronJobRunning(job.id, overrides.triggeredAtMs ?? Date.now());
  return job;
}

describe("reconcileInterruptedCronJobs", () => {
  test("schedules a backfill when last_triggered_at is within the window", () => {
    const now = Date.now();
    const job = makeRunningJob({
      triggeredAtMs: now - 30_000, // 30s ago — fresh
    });

    const entries = reconcileInterruptedCronJobs(now);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: job.id,
      action: "backfill_scheduled",
    });

    // The row's status must still be cleared out of `running`, otherwise the
    // backfill's own `markCronJobRunning` is fine but the transient state
    // between reconcile and backfill would still look zombie-ish.
    const after = getCronJobById(job.id)!;
    expect(after.lastRunStatus).toBe("failed");
    expect(after.lastError).toMatch(/runtime_interrupted/);
  });

  test("clears without backfill when last_triggered_at is outside the window", () => {
    const now = Date.now();
    const job = makeRunningJob({
      triggeredAtMs: now - (CRON_BACKFILL_WINDOW_MS + 60_000),
    });

    const entries = reconcileInterruptedCronJobs(now);
    expect(entries[0]).toMatchObject({
      id: job.id,
      action: "failed_stale",
    });
    expect(getCronJobById(job.id)?.lastRunStatus).toBe("failed");
    expect(getCronJobById(job.id)?.lastError).toMatch(/missed window/);
  });

  test("clears without backfill when last_triggered_at is null", () => {
    // Defensive: a row could in theory enter 'running' without a
    // triggered_at (e.g. a bad manual write). We treat it as stale.
    const job = createCronJob({
      title: "null-trigger",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "hello",
    });
    // Forcibly put it into 'running' with a NULL last_triggered_at.
    const dbFile = process.env.ODE_INBOX_DB_FILE!;
    const rawDb = new Database(dbFile);
    rawDb
      .query(
        "UPDATE cron_jobs SET last_run_status = 'running', last_triggered_at = NULL WHERE id = ?",
      )
      .run(job.id);
    rawDb.close();

    const entries = reconcileInterruptedCronJobs(Date.now());
    expect(entries[0]?.action).toBe("failed_stale");
    expect(getCronJobById(job.id)?.lastRunStatus).toBe("failed");
  });

  test("leaves idle / success / failed jobs alone", () => {
    const idle = createCronJob({
      title: "idle",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "idle",
    });
    const succeeded = createCronJob({
      title: "ok",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "ok",
    });
    markCronJobRunning(succeeded.id, Date.now() - 5_000);
    markCronJobCompleted(succeeded.id);
    const failed = createCronJob({
      title: "nope",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "nope",
    });
    markCronJobRunning(failed.id, Date.now() - 5_000);
    markCronJobFailed(failed.id, "previous error");

    const entries = reconcileInterruptedCronJobs(Date.now());
    expect(entries).toHaveLength(0);
    expect(getCronJobById(idle.id)?.lastRunStatus).toBe("idle");
    expect(getCronJobById(succeeded.id)?.lastRunStatus).toBe("success");
    // `failed` preserves its original error message — reconcile doesn't
    // stomp on legitimate failures.
    expect(getCronJobById(failed.id)?.lastError).toBe("previous error");
  });

  test("is idempotent: second pass is a no-op", () => {
    const job = makeRunningJob({ triggeredAtMs: Date.now() - 30_000 });
    const first = reconcileInterruptedCronJobs();
    expect(first).toHaveLength(1);
    const second = reconcileInterruptedCronJobs();
    expect(second).toHaveLength(0);
    // The row remains `failed` from the first pass.
    expect(getCronJobById(job.id)?.lastRunStatus).toBe("failed");
  });
});

describe("disableCronJob", () => {
  test("flips enabled to false and reports the transition", () => {
    const job = createCronJob({
      title: "to-disable",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "hi",
    });
    expect(getCronJobById(job.id)?.enabled).toBe(true);

    const changed = disableCronJob(job.id);
    expect(changed).toBe(true);
    expect(getCronJobById(job.id)?.enabled).toBe(false);
  });

  test("returns false when the row is already disabled (idempotent)", () => {
    const job = createCronJob({
      title: "already-off",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "hi",
      enabled: false,
    });
    const changed = disableCronJob(job.id);
    expect(changed).toBe(false);
    expect(getCronJobById(job.id)?.enabled).toBe(false);
  });

  test("returns false when the row does not exist", () => {
    expect(disableCronJob("does-not-exist")).toBe(false);
  });

  test("succeeds even when the row's channel was removed from local config", () => {
    // This is the scenario `disableCronJob` exists to solve:
    // a cron job points at a channel that has since been removed from
    // ode.json. `patchCronJob` would throw via `getChannelSnapshot`, but
    // the direct-SQL `disableCronJob` must still flip `enabled` to false
    // so the scheduler stops firing the row.
    const job = createCronJob({
      title: "stale-channel",
      cronExpression: "*/5 * * * *",
      channelId: "C_TEST",
      messageText: "hi",
    });

    // Drop the channel from the on-disk config so getChannelSnapshot fails.
    const emptyConfig = {
      user: {},
      workspaces: [
        {
          id: "ws-test",
          name: "Test Workspace",
          type: "slack",
          channelDetails: [], // C_TEST is gone
        },
      ],
    };
    fs.writeFileSync(ODE_CONFIG_FILE, JSON.stringify(emptyConfig));
    invalidateOdeConfigCache();

    // Sanity check: patchCronJob blows up because it re-validates the
    // channel before writing. This is exactly the bug Codex flagged on
    // PR #211 and is the reason we route around it.
    expect(() => patchCronJob(job.id, { enabled: false })).toThrow(
      /Channel not found/i,
    );
    expect(getCronJobById(job.id)?.enabled).toBe(true);

    // disableCronJob bypasses channel resolution entirely.
    expect(disableCronJob(job.id)).toBe(true);
    expect(getCronJobById(job.id)?.enabled).toBe(false);
  });
});
