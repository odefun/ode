import { describe, expect, it } from "bun:test";
import { buildStatusMessageForAgent } from "../runtime/status-message";
import type { AgentAdapter, StatusMessageRequest } from "../types";
import type { SessionMessageState } from "@/utils/session-inspector";

function makeRequest(): StatusMessageRequest {
  return {
    sessionId: "claude_session",
    channelId: "C123",
    threadId: "T123",
    statusMessageTs: "S123",
    startedAt: Date.now() - 5_000,
    currentText: "",
  };
}

function makeState(): SessionMessageState {
  return {
    sessionTitle: "ClaudeCode",
    phaseStatus: "Thinking",
    currentText: "Draft response",
    tools: [],
    todos: [],
    startedAt: Date.now() - 5_000,
  };
}

describe("buildStatusMessageForAgent", () => {
  it("uses shared provider renderer for Slack updates", () => {
    const agent = {
      getProviderForSession: () => "claudecode",
      buildStatusMessage: () => "custom status",
    } as unknown as AgentAdapter;

    const text = buildStatusMessageForAgent({
      agent,
      request: makeRequest(),
      workingPath: "/tmp/project",
      state: makeState(),
      statusMessageFormat: "medium",
    });

    expect(text).toContain("*ClaudeCode*");
    expect(text).not.toBe("custom status");
  });

  it("uses provider fallback header when title is missing", () => {
    const agent = {
      getProviderForSession: () => "codex",
      buildStatusMessage: () => "custom status",
    } as unknown as AgentAdapter;

    const text = buildStatusMessageForAgent({
      agent,
      request: makeRequest(),
      workingPath: "/tmp/project",
      state: {
        ...makeState(),
        sessionTitle: undefined,
      },
      statusMessageFormat: "medium",
    });

    expect(text).toContain("*Codex is running...*");
  });

  it("uses fallback header for opencode when title is missing", () => {
    const agent = {
      getProviderForSession: () => "opencode",
      buildStatusMessage: () => "custom status",
    } as unknown as AgentAdapter;

    const text = buildStatusMessageForAgent({
      agent,
      request: makeRequest(),
      workingPath: "/tmp/project",
      state: {
        ...makeState(),
        sessionTitle: undefined,
      },
      statusMessageFormat: "medium",
    });

    expect(text).toContain("*OpenCode is running...*");
    expect(text).toContain("*Thinking*");
  });

  it("keeps title visible when model and agent are present", () => {
    const agent = {
      getProviderForSession: () => "opencode",
      buildStatusMessage: () => "custom status",
    } as unknown as AgentAdapter;

    const text = buildStatusMessageForAgent({
      agent,
      request: makeRequest(),
      workingPath: "/tmp/project",
      state: {
        ...makeState(),
        sessionTitle: "Refactor session queue",
        model: "gpt-5.3-codex",
        agent: "build",
      },
      statusMessageFormat: "medium",
    });

    expect(text).toContain("*Refactor session queue*");
    expect(text).toContain("gpt-5.3-codex");
    expect(text).toContain("build");
  });
});
