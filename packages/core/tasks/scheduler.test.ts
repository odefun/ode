import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { invalidateOdeConfigCache, ODE_CONFIG_FILE } from "@/config/local/ode-store";
import type { TaskRecord } from "@/config/local/tasks";
import { deleteSession, saveSession } from "@/config/local/sessions";
import { resolveTaskAgentProvider } from "./scheduler";

// Scheduler-level tests for pure helpers. We swap the user's real
// ~/.config/ode/ode.json for a deterministic fixture and restore it on
// teardown so these tests never touch production config.
//
// Persisted sessions under ~/.config/ode/sessions are written via
// saveSession and cleaned up in afterEach by deleting every (channelId,
// threadId) pair we created. This mirrors what other scheduler/runtime
// tests in the repo do.

let originalConfigExisted: boolean;
let originalConfigContent: string | null;
const createdSessionKeys: Array<{ channelId: string; threadId: string }> = [];

function writeTestConfig(agentProviderForC1: string | undefined): void {
  const config = {
    user: {},
    workspaces: [
      {
        id: "ws-test",
        name: "Test Workspace",
        type: "slack",
        channelDetails: [
          {
            id: "C_CODEX_CHANNEL",
            name: "codex-room",
            ...(agentProviderForC1 !== undefined ? { agentProvider: agentProviderForC1 } : {}),
          },
          // Channel with no agentProvider set — getChannelAgentProvider falls
          // back to "opencode" as the global default.
          { id: "C_DEFAULT_CHANNEL", name: "default-room" },
        ],
      },
    ],
  };
  fs.mkdirSync(path.dirname(ODE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(ODE_CONFIG_FILE, JSON.stringify(config));
  invalidateOdeConfigCache();
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    title: "test",
    scheduledAt: Date.now(),
    platform: "slack",
    workspaceId: "ws-test",
    workspaceName: "Test Workspace",
    channelId: "C_CODEX_CHANNEL",
    channelName: "codex-room",
    threadId: null,
    messageText: "hi",
    agent: null,
    status: "pending",
    lastError: null,
    triggeredAt: null,
    completedAt: null,
    retryCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function seedSession(
  channelId: string,
  threadId: string,
  providerId: "opencode" | "claudecode" | "codex" | "kimi" | "kiro" | "kilo" | "qwen" | "goose" | "gemini",
): void {
  const now = Date.now();
  saveSession(
    {
      sessionId: `sess-${providerId}-${now}`,
      providerId,
      platform: "slack",
      channelId,
      threadId,
      workingDirectory: "/tmp",
      threadOwnerUserId: "U_TEST",
      participantBotIds: [],
      createdAt: now,
      lastActivityAt: now,
      lastActivityBotId: "test",
    },
    { immediate: true },
  );
  createdSessionKeys.push({ channelId, threadId });
}

beforeEach(() => {
  originalConfigExisted = fs.existsSync(ODE_CONFIG_FILE);
  originalConfigContent = originalConfigExisted ? fs.readFileSync(ODE_CONFIG_FILE, "utf-8") : null;
  createdSessionKeys.length = 0;
});

afterEach(() => {
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

  // Clean up any session files we seeded.
  for (const key of createdSessionKeys) {
    try {
      deleteSession(key.channelId, key.threadId);
    } catch {
      // Best effort.
    }
  }
  createdSessionKeys.length = 0;
});

describe("resolveTaskAgentProvider", () => {
  test("prefers task.agent when it is a known provider id (no anchored thread)", () => {
    writeTestConfig("codex");
    const task = makeTask({ threadId: null, agent: "claudecode" });
    expect(resolveTaskAgentProvider(task)).toBe("claudecode");
  });

  test("falls back to channel agent when task.agent is null", () => {
    writeTestConfig("codex");
    const task = makeTask({ channelId: "C_CODEX_CHANNEL", threadId: null, agent: null });
    expect(resolveTaskAgentProvider(task)).toBe("codex");
  });

  test("falls back to channel agent when task.agent is an unknown string", () => {
    // Defense-in-depth: createTask rejects bad values at write time, but a
    // legacy or manually-edited row should not break the scheduler tick.
    writeTestConfig("codex");
    const task = makeTask({
      channelId: "C_CODEX_CHANNEL",
      threadId: null,
      agent: "no-such-agent",
    });
    expect(resolveTaskAgentProvider(task)).toBe("codex");
  });

  test("falls back to 'opencode' when neither task nor channel specify one", () => {
    // C_DEFAULT_CHANNEL has no agentProvider field, so
    // getChannelAgentProvider returns the global default.
    writeTestConfig(undefined);
    const task = makeTask({
      channelId: "C_DEFAULT_CHANNEL",
      threadId: null,
      agent: null,
    });
    expect(resolveTaskAgentProvider(task)).toBe("opencode");
  });

  test("anchored thread wins over task.agent override", () => {
    // Thread has an existing claudecode session. Even though the task asks
    // for codex and the channel defaults to kimi, we honour the thread to
    // preserve its conversation context.
    writeTestConfig("kimi");
    const channelId = "C_CODEX_CHANNEL";
    const threadId = "T_ANCHOR_THREAD";
    seedSession(channelId, threadId, "claudecode");
    const task = makeTask({
      channelId,
      threadId,
      agent: "codex",
    });
    expect(resolveTaskAgentProvider(task)).toBe("claudecode");
  });

  test("anchored thread without a persisted session falls back to override then channel", () => {
    // threadId is set but we never seeded a session — resolver must not
    // pretend the thread has one, and should continue down the normal
    // fallback chain.
    writeTestConfig("kimi");
    const task = makeTask({
      channelId: "C_CODEX_CHANNEL",
      threadId: "T_NEW_THREAD_NO_SESSION",
      agent: "goose",
    });
    expect(resolveTaskAgentProvider(task)).toBe("goose");
  });
});
