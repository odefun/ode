import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildLiveStatusMessage } from "../../utils/status";

function rawEvent(timestamp: number, record: Record<string, unknown>) {
  return {
    timestamp,
    type: `kilo.raw.${String(record.type ?? "unknown")}`,
    data: {
      properties: {
        record,
      },
    },
  };
}

describe("kilo stream status parsing", () => {
  it("hydrates todos from current Kilo tool_use part state", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "tool_use",
        part: {
          type: "tool",
          tool: "todowrite",
          callID: "tool-1",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Inspect workspace", status: "in_progress" },
                { content: "Write report", status: "pending" },
              ],
            },
            title: "2 todos",
          },
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

    expect(state.todos).toEqual([
      { content: "Inspect workspace", status: "in_progress" },
      { content: "Write report", status: "pending" },
    ]);
    expect(text).toContain("**Plan**");
    expect(text).toContain("- [~] Inspect workspace");
    expect(text).toContain("- [ ] Write report");
  });
});
