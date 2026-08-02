import { describe, expect, it } from "bun:test";
import { buildStatusMessageByProvider, type StatusRequest } from "./status";
import type { SessionMessageState } from "./session-inspector";

describe("status message formatting", () => {
  const request: StatusRequest = {
    channelId: "C1",
    threadId: "T1",
    statusMessageTs: "S1",
    startedAt: Date.now() - 60_000,
    currentText: "",
  };

  it("shows waiting subagent hint after threshold", () => {
    const state: SessionMessageState = {
      sessionTitle: "Goose is running...",
      phaseStatus: "Running tool: subagent",
      currentText: "",
      tools: [
        {
          id: "tool-1",
          name: "subagent",
          status: "running",
          metadata: { startedAtMs: Date.now() - 35_000 },
        },
      ],
      todos: [],
      startedAt: Date.now() - 60_000,
    };

    const text = buildStatusMessageByProvider("goose", request, "/tmp/repo", state, "medium");
    expect(text).toContain("Waiting for subagent output");
  });

  it("keeps regular running status before threshold", () => {
    const state: SessionMessageState = {
      sessionTitle: "Goose is running...",
      phaseStatus: "Running tool: subagent",
      currentText: "",
      tools: [
        {
          id: "tool-1",
          name: "subagent",
          status: "running",
          metadata: { startedAtMs: Date.now() - 5_000 },
        },
      ],
      todos: [],
      startedAt: Date.now() - 60_000,
    };

    const text = buildStatusMessageByProvider("goose", request, "/tmp/repo", state, "medium");
    expect(text).toContain("*Running tool: subagent*");
    expect(text).not.toContain("Waiting for subagent output");
  });

  it("recognizes OpenCode task tools as subagents", () => {
    const state: SessionMessageState = {
      sessionTitle: "OpenCode is running...",
      phaseStatus: "Running tool: task",
      currentText: "Inspecting packages",
      tools: [
        {
          id: "tool-task",
          name: "task",
          title: "Audit repo state vs docs",
          status: "running",
          metadata: { startedAtMs: Date.now() - 40_000 },
        },
      ],
      todos: [],
      startedAt: Date.now() - 60_000,
    };

    const text = buildStatusMessageByProvider("opencode", request, "/tmp/repo", state, "medium");
    expect(text).toContain("Waiting for subagent: Audit repo state vs docs");
    expect(text).toContain("Inspecting packages");
  });
});
