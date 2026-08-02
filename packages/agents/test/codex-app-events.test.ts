import { describe, expect, it } from "bun:test";
import {
  createCodexAppEventState,
  isKnownCodexAppNotificationMethod,
  normalizeCodexAppNotification,
  type CodexAppSessionEvent,
} from "../codex/app-events";
import {
  CODEX_SERVER_REQUEST_METHODS,
  getCodexServerRequestFallback,
  isKnownCodexServerRequestMethod,
} from "../codex/app-server";
import { buildSessionMessageState, type SessionEvent } from "../../utils/session-inspector";

function sessionEvents(events: CodexAppSessionEvent[], startedAt = Date.now()): SessionEvent[] {
  return events.map((event, index) => ({
    timestamp: startedAt + index,
    type: event.type,
    data: {
      properties: event.type === "message.part.updated"
        ? {
            ...event.properties,
            part: {
              ...(event.properties.part as Record<string, unknown>),
              sessionID: "ode-session",
            },
          }
        : event.properties,
    },
  }));
}

describe("Codex app-server event normalization", () => {
  it("keeps child thread output and completion out of the parent conversation", () => {
    const state = createCodexAppEventState();
    state.rootThreadId = "thread_root";
    const normalized: CodexAppSessionEvent[] = [];

    normalized.push(...normalizeCodexAppNotification(state, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread_root", turnId: "turn_root", itemId: "root_msg", delta: "Delegating now." },
    }));
    normalized.push(...normalizeCodexAppNotification(state, {
      method: "item/completed",
      params: {
        threadId: "thread_root",
        turnId: "turn_root",
        item: {
          type: "subAgentActivity",
          id: "spawn_1",
          kind: "started",
          agentThreadId: "thread_child",
          agentPath: "/root/package_identity",
        },
      },
    }));

    const childText = normalizeCodexAppNotification(state, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread_child", turnId: "turn_child", itemId: "child_msg", delta: "ode 0.2.0" },
    });
    const childTurn = normalizeCodexAppNotification(state, {
      method: "turn/completed",
      params: { threadId: "thread_child", turn: { id: "turn_child", status: "completed" } },
    });
    normalized.push(...childText, ...childTurn);

    expect(childText).toEqual([]);
    expect(childTurn.map((event) => event.type)).toEqual(["message.part.updated"]);
    expect(childTurn.some((event) => event.type === "session.status")).toBe(false);

    const renderedState = buildSessionMessageState(sessionEvents(normalized), { provider: "codex" });
    expect(renderedState.currentText).toBe("Delegating now.");
    expect(renderedState.phaseStatus).not.toBe("Waiting");
    expect(renderedState.tools).toHaveLength(1);
    expect(renderedState.tools[0]?.name).toBe("subagent");
    expect(renderedState.tools[0]?.title).toBe("package_identity");
    expect(renderedState.tools[0]?.status).toBe("completed");
  });

  it("normalizes root status, usage, retries, command deltas, plans, and diffs", () => {
    const state = createCodexAppEventState();
    state.rootThreadId = "thread_root";
    const events: CodexAppSessionEvent[] = [];
    events.push(...normalizeCodexAppNotification(state, {
      method: "thread/status/changed",
      params: { threadId: "thread_root", status: { type: "active", activeFlags: [] } },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread_root",
        turnId: "turn_root",
        tokenUsage: {
          total: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 10,
            outputTokens: 30,
            reasoningOutputTokens: 5,
          },
        },
      },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "error",
      params: { threadId: "thread_root", turnId: "turn_root", willRetry: true, error: { message: "stream reset" } },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "item/started",
      params: {
        threadId: "thread_root",
        turnId: "turn_root",
        item: { type: "commandExecution", id: "cmd_1", command: "bun test", cwd: "/tmp/repo", status: "inProgress" },
      },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread_root", turnId: "turn_root", itemId: "cmd_1", delta: "1 pass\n" },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "item/plan/delta",
      params: { threadId: "thread_root", turnId: "turn_root", itemId: "plan_1", delta: "Inspect tests" },
    }));
    events.push(...normalizeCodexAppNotification(state, {
      method: "turn/diff/updated",
      params: { threadId: "thread_root", turnId: "turn_root", diff: "diff --git a/a.ts b/a.ts" },
    }));

    const renderedState = buildSessionMessageState(sessionEvents(events), { provider: "codex" });
    expect(renderedState.tokenUsage?.total).toBe(120);
    expect(renderedState.tools.find((tool) => tool.id === "cmd_1")?.output).toBe("1 pass\n");
    expect(renderedState.tools.some((tool) => tool.id === "codex-diff:turn_root")).toBe(true);
    expect(events.some((event) => event.type === "session.status"
      && JSON.stringify(event.properties).includes("Retrying"))).toBe(false);
    expect(events.some((event) => event.type === "session.status"
      && JSON.stringify(event.properties).includes("retry"))).toBe(true);
  });

  it("detects future notification drift", () => {
    expect(isKnownCodexAppNotificationMethod("thread/tokenUsage/updated")).toBe(true);
    expect(isKnownCodexAppNotificationMethod("thread/futureProtocol/changed")).toBe(false);
  });

  it("renders unsupported server requests as an actionable integration status", () => {
    const state = createCodexAppEventState();
    state.rootThreadId = "thread_root";
    const events = normalizeCodexAppNotification(state, {
      method: "ode/serverRequest/failed",
      params: {
        threadId: "thread_root",
        requestMethod: "future/request",
        protocolKnown: false,
        message: "Ode does not support server request future/request",
      },
    });
    expect(events).toEqual([{
      type: "session.status",
      properties: { status: "Codex integration update required: future/request" },
    }]);
  });
});

describe("Codex app-server request fallbacks", () => {
  it("declines interactive MCP elicitation without breaking the protocol", () => {
    expect(getCodexServerRequestFallback("mcpServer/elicitation/request")).toEqual({
      kind: "result",
      result: { action: "decline", content: null, _meta: null },
    });
  });

  it("returns a failed dynamic tool result instead of method-not-found", () => {
    const fallback = getCodexServerRequestFallback("item/tool/call");
    expect(fallback.kind).toBe("result");
    if (fallback.kind === "result") {
      expect(fallback.result.success).toBe(false);
    }
  });

  it("never auto-approves command or file changes", () => {
    expect(getCodexServerRequestFallback("item/commandExecution/requestApproval")).toEqual({
      kind: "result",
      result: { decision: "decline" },
    });
    expect(getCodexServerRequestFallback("item/fileChange/requestApproval")).toEqual({
      kind: "result",
      result: { decision: "decline" },
    });
    expect(getCodexServerRequestFallback("execCommandApproval")).toEqual({
      kind: "result",
      result: { decision: { denied: { rejection: "Ode did not receive explicit user approval." } } },
    });
  });

  it("handles every request in the currently generated Codex protocol surface", () => {
    for (const method of CODEX_SERVER_REQUEST_METHODS) {
      expect(isKnownCodexServerRequestMethod(method)).toBe(true);
      const fallback = getCodexServerRequestFallback(method, 1_785_665_000_000);
      if (fallback.kind === "error") {
        expect(fallback.error.code).not.toBe(-32601);
      }
    }
    expect(getCodexServerRequestFallback("currentTime/read", 1_785_665_000_000)).toEqual({
      kind: "result",
      result: { currentTimeAt: 1_785_665_000 },
    });
  });

  it("keeps unknown requests explicit", () => {
    expect(isKnownCodexServerRequestMethod("future/request")).toBe(false);
    expect(getCodexServerRequestFallback("future/request")).toEqual({
      kind: "error",
      error: { code: -32601, message: "Ode does not support server request future/request" },
    });
  });
});
