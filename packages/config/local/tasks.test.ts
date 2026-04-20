import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { invalidateOdeConfigCache, ODE_CONFIG_FILE } from "./ode-store";
import {
  cancelTask,
  clearTasksForTests,
  closeTaskDatabaseForTests,
  createTask,
  deleteTask,
  getTaskById,
  listDueTasks,
  listTasks,
  markTaskCompleted,
  markTaskFailed,
  markTaskTriggered,
  MAX_TASK_AUTO_RETRIES,
  reconcileInterruptedTasks,
  TASK_RECENT_STALENESS_WINDOW_MS,
  updateTask,
} from "./tasks";

// We reuse the real `~/.config/ode/ode.json` path (resolved at module load)
// but swap its contents for test fixtures and restore them on teardown.
// The inbox SQLite DB is redirected to a temp dir via ODE_INBOX_DB_FILE so
// test data never touches the user's real inbox.db.
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
        channelDetails: [
          { id: "C_TEST", name: "general" },
          { id: "C_OTHER", name: "random" },
        ],
      },
    ],
  };
  fs.mkdirSync(path.dirname(ODE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(ODE_CONFIG_FILE, JSON.stringify(config));
  invalidateOdeConfigCache();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ode-tasks-test-"));
  originalConfigEnv = process.env.ODE_INBOX_DB_FILE;
  process.env.ODE_INBOX_DB_FILE = path.join(tempDir, "inbox.db");

  originalConfigExisted = fs.existsSync(ODE_CONFIG_FILE);
  originalConfigContent = originalConfigExisted ? fs.readFileSync(ODE_CONFIG_FILE, "utf-8") : null;
  writeTestOdeConfig();

  closeTaskDatabaseForTests();
  clearTasksForTests();
});

afterEach(() => {
  closeTaskDatabaseForTests();
  if (originalConfigEnv === undefined) {
    delete process.env.ODE_INBOX_DB_FILE;
  } else {
    process.env.ODE_INBOX_DB_FILE = originalConfigEnv;
  }

  // Restore the real ode.json so the user's config isn't left in a test state.
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

describe("tasks storage", () => {
  test("createTask persists fields and resolves channel snapshot", () => {
    const scheduledAt = Date.now() + 60_000;
    const task = createTask({
      title: "Check deploy",
      scheduledAt,
      channelId: "C_TEST",
      threadId: "1234.5678",
      messageText: "Check deployment status",
      agent: "opencode",
    });

    expect(task.id).toBeTruthy();
    expect(task.title).toBe("Check deploy");
    expect(task.scheduledAt).toBe(scheduledAt);
    expect(task.platform).toBe("slack");
    expect(task.workspaceId).toBe("ws-test");
    expect(task.workspaceName).toBe("Test Workspace");
    expect(task.channelId).toBe("C_TEST");
    expect(task.channelName).toBe("general");
    expect(task.threadId).toBe("1234.5678");
    expect(task.agent).toBe("opencode");
    expect(task.status).toBe("pending");
    expect(task.lastError).toBeNull();
  });

  test("createTask rejects unknown channel", () => {
    expect(() =>
      createTask({
        title: "x",
        scheduledAt: Date.now() + 1000,
        channelId: "C_UNKNOWN",
        messageText: "hi",
      }),
    ).toThrow(/Channel not found/);
  });

  test("createTask normalizes seconds-valued scheduledAt to milliseconds", () => {
    const seconds = Math.floor(Date.now() / 1000) + 60;
    const task = createTask({
      title: "s",
      scheduledAt: seconds,
      channelId: "C_TEST",
      messageText: "hi",
    });
    expect(task.scheduledAt).toBe(seconds * 1000);
  });

  test("listDueTasks returns only pending tasks at or before now", () => {
    const now = Date.now();
    const past = createTask({
      title: "past",
      scheduledAt: now - 10_000,
      channelId: "C_TEST",
      messageText: "a",
    });
    const future = createTask({
      title: "future",
      scheduledAt: now + 60_000,
      channelId: "C_TEST",
      messageText: "b",
    });

    const due = listDueTasks(now);
    expect(due.map((t) => t.id)).toContain(past.id);
    expect(due.map((t) => t.id)).not.toContain(future.id);
  });

  test("markTaskTriggered is atomic: first caller wins, second caller is no-op", () => {
    const task = createTask({
      title: "race",
      scheduledAt: Date.now() - 1000,
      channelId: "C_TEST",
      messageText: "race me",
    });

    const first = markTaskTriggered(task.id);
    const second = markTaskTriggered(task.id);
    expect(first).toBe(true);
    expect(second).toBe(false);

    const updated = getTaskById(task.id);
    expect(updated?.status).toBe("running");
    expect(updated?.triggeredAt).not.toBeNull();
  });

  test("markTaskCompleted and markTaskFailed set terminal status", () => {
    const a = createTask({ title: "ok", scheduledAt: Date.now(), channelId: "C_TEST", messageText: "x" });
    const b = createTask({ title: "err", scheduledAt: Date.now(), channelId: "C_TEST", messageText: "y" });
    markTaskTriggered(a.id);
    markTaskCompleted(a.id);
    markTaskTriggered(b.id);
    markTaskFailed(b.id, "boom");

    expect(getTaskById(a.id)?.status).toBe("success");
    expect(getTaskById(b.id)?.status).toBe("failed");
    expect(getTaskById(b.id)?.lastError).toBe("boom");
  });

  test("cancelTask also rescues running tasks stuck after a crash", () => {
    // Pending -> cancelled is the usual happy path.
    const task = createTask({ title: "c", scheduledAt: Date.now() + 60_000, channelId: "C_TEST", messageText: "hi" });
    expect(cancelTask(task.id)).toBe(true);
    expect(getTaskById(task.id)?.status).toBe("cancelled");
    // Second cancel is a no-op.
    expect(cancelTask(task.id)).toBe(false);

    // Running tasks are also cancellable: a runtime crash can leave a row
    // in `running` forever, and `cancelTask` now lets the user reclaim it
    // via the UI / CLI without having to `delete` the row outright.
    const running = createTask({ title: "r", scheduledAt: Date.now(), channelId: "C_TEST", messageText: "r" });
    markTaskTriggered(running.id);
    expect(cancelTask(running.id)).toBe(true);
    expect(getTaskById(running.id)?.status).toBe("cancelled");
    expect(getTaskById(running.id)?.completedAt).not.toBeNull();

    // Terminal rows (success / failed / already cancelled) stay put.
    const done = createTask({ title: "d", scheduledAt: Date.now(), channelId: "C_TEST", messageText: "d" });
    markTaskTriggered(done.id);
    markTaskCompleted(done.id);
    expect(cancelTask(done.id)).toBe(false);
    expect(getTaskById(done.id)?.status).toBe("success");
  });

  test("updateTask rejects edits on non-pending tasks", () => {
    const task = createTask({ title: "u", scheduledAt: Date.now() + 60_000, channelId: "C_TEST", messageText: "hi" });
    markTaskTriggered(task.id);
    expect(() => updateTask(task.id, { title: "nope" })).toThrow(/pending/);
  });

  test("updateTask preserves unspecified fields", () => {
    const task = createTask({
      title: "u2",
      scheduledAt: Date.now() + 60_000,
      channelId: "C_TEST",
      threadId: "T1",
      messageText: "original",
      agent: "opencode",
    });
    const updated = updateTask(task.id, { messageText: "new text" });
    expect(updated.messageText).toBe("new text");
    expect(updated.title).toBe(task.title);
    expect(updated.channelId).toBe("C_TEST");
    expect(updated.threadId).toBe("T1");
    expect(updated.agent).toBe("opencode");
    expect(updated.scheduledAt).toBe(task.scheduledAt);
  });

  test("deleteTask removes the record", () => {
    const task = createTask({ title: "d", scheduledAt: Date.now(), channelId: "C_TEST", messageText: "x" });
    deleteTask(task.id);
    expect(getTaskById(task.id)).toBeNull();
  });

  test("listTasks orders running first, then pending by scheduled time", () => {
    const now = Date.now();
    const later = createTask({ title: "later", scheduledAt: now + 120_000, channelId: "C_TEST", messageText: "l" });
    const sooner = createTask({ title: "sooner", scheduledAt: now + 60_000, channelId: "C_TEST", messageText: "s" });
    const runningTask = createTask({ title: "running", scheduledAt: now, channelId: "C_TEST", messageText: "r" });
    markTaskTriggered(runningTask.id);

    const list = listTasks();
    expect(list[0]?.id).toBe(runningTask.id);
    const pendingOrder = list.filter((t) => t.status === "pending").map((t) => t.id);
    expect(pendingOrder).toEqual([sooner.id, later.id]);
  });

  test("createTask rejects unsupported agent ids", () => {
    expect(() =>
      createTask({
        title: "bad-agent",
        scheduledAt: Date.now() + 60_000,
        channelId: "C_TEST",
        messageText: "hi",
        agent: "not-a-real-agent",
      }),
    ).toThrow(/Unsupported agent/);
  });

  test("createTask normalizes agent casing and accepts known ids", () => {
    const task = createTask({
      title: "case",
      scheduledAt: Date.now() + 60_000,
      channelId: "C_TEST",
      messageText: "hi",
      agent: "Codex",
    });
    expect(task.agent).toBe("codex");
  });

  test("createTask treats empty agent string as null (channel default)", () => {
    const task = createTask({
      title: "default",
      scheduledAt: Date.now() + 60_000,
      channelId: "C_TEST",
      messageText: "hi",
      agent: "   ",
    });
    expect(task.agent).toBeNull();
  });

  test("updateTask rejects unsupported agent ids", () => {
    const task = createTask({
      title: "u-agent",
      scheduledAt: Date.now() + 60_000,
      channelId: "C_TEST",
      messageText: "hi",
      agent: "opencode",
    });
    expect(() => updateTask(task.id, { agent: "claude-code-beta" })).toThrow(/Unsupported agent/);
    expect(getTaskById(task.id)?.agent).toBe("opencode");
  });
});

describe("reconcileInterruptedTasks", () => {
  test("requeues a recently triggered running task and bumps retry_count", () => {
    const now = Date.now();
    const task = createTask({
      title: "recent",
      scheduledAt: now - 30_000, // 30s ago — well within the staleness window
      channelId: "C_TEST",
      messageText: "go",
    });
    markTaskTriggered(task.id);
    expect(getTaskById(task.id)?.status).toBe("running");

    const entries = reconcileInterruptedTasks(now);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: task.id,
      action: "requeued",
      retryCount: 1,
    });

    const after = getTaskById(task.id)!;
    expect(after.status).toBe("pending");
    expect(after.triggeredAt).toBeNull();
    expect(after.retryCount).toBe(1);
    expect(after.lastError).toMatch(/runtime_interrupted/);
  });

  test("requeues future-scheduled tasks regardless of absolute elapsed time", () => {
    // A task whose scheduledAt is still in the future should always be
    // re-queued: the restart happened before its intended firing time, so
    // the user's original intent is untouched.
    const now = Date.now();
    const task = createTask({
      title: "future",
      scheduledAt: now + 60 * 60_000, // one hour from now
      channelId: "C_TEST",
      messageText: "later",
    });
    markTaskTriggered(task.id);

    const entries = reconcileInterruptedTasks(now);
    expect(entries[0]?.action).toBe("requeued");
    expect(getTaskById(task.id)?.status).toBe("pending");
  });

  test("fails a stale interrupted task outside the staleness window", () => {
    const now = Date.now();
    const task = createTask({
      title: "stale",
      scheduledAt: now - (TASK_RECENT_STALENESS_WINDOW_MS + 60_000),
      channelId: "C_TEST",
      messageText: "too late",
    });
    markTaskTriggered(task.id);

    const entries = reconcileInterruptedTasks(now);
    expect(entries[0]).toMatchObject({
      id: task.id,
      action: "failed_stale",
      retryCount: 0,
    });
    const after = getTaskById(task.id)!;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
    expect(after.lastError).toMatch(/too stale/);
    expect(after.completedAt).not.toBeNull();
  });

  test("enforces MAX_TASK_AUTO_RETRIES to prevent crash loops", () => {
    // A task that already bounced MAX times must terminate, even if it's
    // otherwise fresh — we assume something about it is crashing the runtime.
    const now = Date.now();
    const task = createTask({
      title: "looping",
      scheduledAt: now - 30_000,
      channelId: "C_TEST",
      messageText: "crash me",
    });
    markTaskTriggered(task.id);
    // Pretend the previous reconcile already bumped retry_count to the cap.
    // We reach into the DB directly because there's no public API for
    // setting retryCount (it's only incremented by reconcile itself).
    const dbFile = process.env.ODE_INBOX_DB_FILE!;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const rawDb = new Database(dbFile);
    rawDb.query("UPDATE tasks SET retry_count = ? WHERE id = ?").run(
      MAX_TASK_AUTO_RETRIES,
      task.id,
    );
    rawDb.close();

    const entries = reconcileInterruptedTasks(now);
    expect(entries[0]).toMatchObject({
      id: task.id,
      action: "failed_retry_cap",
      retryCount: MAX_TASK_AUTO_RETRIES,
    });
    expect(getTaskById(task.id)?.status).toBe("failed");
    expect(getTaskById(task.id)?.lastError).toMatch(/retry cap/);
  });

  test("leaves non-running tasks alone (pending / success / failed / cancelled)", () => {
    const now = Date.now();
    const pending = createTask({ title: "p", scheduledAt: now - 1000, channelId: "C_TEST", messageText: "p" });
    const done = createTask({ title: "d", scheduledAt: now - 1000, channelId: "C_TEST", messageText: "d" });
    markTaskTriggered(done.id);
    markTaskCompleted(done.id);
    const cancelled = createTask({ title: "c", scheduledAt: now + 60_000, channelId: "C_TEST", messageText: "c" });
    cancelTask(cancelled.id);

    const entries = reconcileInterruptedTasks(now);
    expect(entries).toHaveLength(0);
    expect(getTaskById(pending.id)?.status).toBe("pending");
    expect(getTaskById(done.id)?.status).toBe("success");
    expect(getTaskById(cancelled.id)?.status).toBe("cancelled");
  });

  test("is idempotent: a second run is a no-op once rows are terminal", () => {
    const now = Date.now();
    const fresh = createTask({ title: "f", scheduledAt: now - 30_000, channelId: "C_TEST", messageText: "f" });
    const stale = createTask({ title: "s", scheduledAt: now - (TASK_RECENT_STALENESS_WINDOW_MS + 60_000), channelId: "C_TEST", messageText: "s" });
    markTaskTriggered(fresh.id);
    markTaskTriggered(stale.id);

    const first = reconcileInterruptedTasks(now);
    expect(first).toHaveLength(2);
    const second = reconcileInterruptedTasks(now);
    // Fresh task was re-queued to pending; stale task is terminal. Neither
    // is still `running`, so the second pass has nothing to do.
    expect(second).toHaveLength(0);
  });
});
