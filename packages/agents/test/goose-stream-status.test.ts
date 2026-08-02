import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildLiveStatusMessage } from "../../utils/status";

function rawEvent(timestamp: number, record: Record<string, unknown>) {
  return {
    timestamp,
    type: `goose.raw.${String(record.type ?? "unknown")}`,
    data: {
      properties: {
        record,
      },
    },
  };
}

describe("goose stream status parsing", () => {
  it("tracks tool lifecycle and text deltas", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { filePath: "README.md" },
          },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      }),
      rawEvent(now + 2, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "done" },
        },
      }),
    ]);

    expect(state.tools[0]?.name).toBe("Read");
    expect(state.tools[0]?.status).toBe("completed");
    expect(state.currentText).toBe("done");
    expect(state.phaseStatus).toBe("Drafting response");
  });

  it("renders goose snake_case tool details in live status", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-2",
            name: "read_file",
            input: { absolute_path: "/tmp/repo/README.md" },
          },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
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

    expect(text).toContain("`read` README.md");
  });

  it("parses Goose message schema with toolRequest/toolResponse", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "message",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "Hel" }],
        },
      }),
      rawEvent(now + 1, {
        type: "message",
        message: {
          id: "m2",
          role: "assistant",
          content: [{ type: "text", text: "lo" }],
        },
      }),
      rawEvent(now + 2, {
        type: "message",
        message: {
          id: "m3",
          role: "assistant",
          content: [{
            type: "toolRequest",
            id: "call-1",
            toolCall: {
              status: "success",
              value: {
                name: "read_file",
                arguments: { absolute_path: "/tmp/repo/README.md" },
              },
            },
          }],
        },
      }),
      rawEvent(now + 3, {
        type: "message",
        message: {
          id: "m4",
          role: "user",
          content: [{
            type: "toolResponse",
            id: "call-1",
            toolResult: {
              status: "success",
              value: {
                isError: false,
                content: [{ type: "text", text: "ok" }],
              },
            },
          }],
        },
      }),
      rawEvent(now + 4, {
        type: "message",
        message: {
          id: "m5",
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
        },
      }),
      rawEvent(now + 5, { type: "complete" }),
    ]);

    expect(state.currentText).toBe("Done");
    expect(state.tools[0]?.name).toBe("read_file");
    expect(state.tools[0]?.status).toBe("completed");
    expect(state.phaseStatus).toBe("Waiting");
  });

  it("hydrates todos from Goose todo tool input", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "message",
        message: {
          id: "m1",
          role: "assistant",
          content: [{
            type: "toolRequest",
            id: "call-todo-1",
            toolCall: {
              status: "success",
              value: {
                name: "todo__todo_write",
                arguments: {
                  todos: [
                    { content: "Inspect parser", status: "in progress" },
                    { text: "Write test", status: "completed" },
                  ],
                },
              },
            },
          }],
        },
      }),
    ]);

    expect(state.todos).toEqual([
      { content: "Inspect parser", status: "in_progress" },
      { content: "Write test", status: "completed" },
    ]);
  });

  it("hydrates markdown checklist todos and shell details from Goose tools", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "message",
        message: {
          id: "m1",
          role: "assistant",
          content: [{
            type: "toolRequest",
            id: "call-todo-1",
            toolCall: {
              value: {
                name: "todo__todo_write",
                arguments: {
                  content: "- [ ] Inspect repository\n- [x] Read README\n- [~] Write report",
                },
              },
            },
          }],
        },
      }),
      rawEvent(now + 1, {
        type: "message",
        message: {
          id: "m2",
          role: "assistant",
          content: [{
            type: "toolRequest",
            id: "call-shell-1",
            toolCall: {
              value: {
                name: "shell",
                arguments: {
                  command: "cat README.md",
                },
              },
            },
          }],
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
      { content: "Inspect repository", status: "pending" },
      { content: "Read README", status: "completed" },
      { content: "Write report", status: "in_progress" },
    ]);
    expect(text).toContain("**Plan**");
    expect(text).toContain("- [ ] Inspect repository");
    expect(text).toContain("- [x] Read README");
    expect(text).toContain("- [~] Write report");
    expect(text).toContain("`shell` cat README.md");
  });
});
