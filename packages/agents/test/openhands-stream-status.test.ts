import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildLiveStatusMessage } from "../../utils/status";

function rawEvent(timestamp: number, record: Record<string, unknown>) {
  return {
    timestamp,
    type: `openhands.raw.${String(record.kind ?? "unknown")}`,
    data: {
      properties: {
        record,
      },
    },
  };
}

describe("openhands stream status parsing", () => {
  it("recognizes OpenHands system prompt setup records", () => {
    const state = buildSessionMessageState([rawEvent(Date.now(), {
      kind: "SystemPromptEvent",
      source: "agent",
    })]);

    expect(state.phaseStatus).toBe("Preparing OpenHands context");
  });

  it("renders startup progress while the CLI buffers JSON output", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "start",
        model: "anthropic/claude-sonnet-4-5-20250929",
        prompt: "Inspect the repo and identify live status tests to add.",
      }),
      rawEvent(now + 15_000, {
        type: "progress",
        model: "anthropic/claude-sonnet-4-5-20250929",
        prompt: "Inspect the repo and identify live status tests to add.",
        elapsedMs: 15_000,
      }),
    ]);

    expect(state.model).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(state.phaseStatus).toContain("Waiting for OpenHands output");
  });

  it("renders ActionEvent and ObservationEvent as tool lifecycle", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        kind: "ActionEvent",
        source: "agent",
        reasoning_content: "I should inspect the runtime entry point.",
        summary: "View core runtime entry point",
        tool_call_id: "tool-1",
        tool_name: "file_editor",
        tool_call: {
          id: "tool-1",
          name: "file_editor",
          arguments: "{\"command\":\"view\",\"path\":\"/tmp/repo/packages/core/index.ts\"}",
        },
        action: {
          command: "view",
          path: "/tmp/repo/packages/core/index.ts",
        },
      }),
      rawEvent(now + 1, {
        kind: "ObservationEvent",
        tool_call_id: "tool-1",
        observation: {
          is_error: false,
          content: [{ type: "text", text: "export async function startOde() {}" }],
        },
      }),
    ]);

    expect(state.thinkingText).toBe("I should inspect the runtime entry point.");
    expect(state.tools[0]?.name).toBe("file_editor");
    expect(state.tools[0]?.status).toBe("completed");
    expect(state.tools[0]?.title).toBe("View core runtime entry point");
    expect(state.phaseStatus).toBe("Finished tool: file_editor - View core runtime entry point");
  });

  it("renders tool call titles from function arguments", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        kind: "message",
        source: "agent",
        llm_message: {
          role: "assistant",
          content: [{ type: "text", text: "I will inspect package metadata." }],
          tool_calls: [
            {
              id: "call-1",
              function: {
                name: "read",
                arguments: "{\"path\":\"/tmp/repo/package.json\"}",
              },
            },
          ],
        },
      }),
    ]);

    const text = buildLiveStatusMessage(
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt: now,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "medium"
    );

    expect(state.tools[0]?.title).toBe("/tmp/repo/package.json");
    expect(text).toContain("Running tool: read - /tmp/repo/package.json");
    expect(text).toContain("`read` package.json");
  });
});
