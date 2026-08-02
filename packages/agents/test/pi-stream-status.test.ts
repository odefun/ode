import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildLiveStatusMessage } from "../../utils/status";

function rawEvent(timestamp: number, record: Record<string, unknown>) {
  return {
    timestamp,
    type: `pi.raw.${String(record.type ?? "unknown")}`,
    data: {
      properties: {
        record,
      },
    },
  };
}

describe("pi stream status parsing", () => {
  it("tracks thinking, tool calls, and tool results", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "I should inspect the package scripts first.",
        },
      }),
      rawEvent(now + 1, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          partial: {
            content: [
              {
                type: "toolCall",
                id: "tool-1",
                name: "read",
                arguments: { path: "/tmp/repo/package.json" },
              },
            ],
          },
        },
      }),
      rawEvent(now + 2, {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "{\"scripts\":{\"test\":\"bun test\"}}" }],
          isError: false,
        },
      }),
    ]);

    expect(state.thinkingText).toBe("I should inspect the package scripts first.");
    expect(state.tools[0]?.name).toBe("read");
    expect(state.tools[0]?.status).toBe("completed");
    expect(state.tools[0]?.title).toBe("/tmp/repo/package.json");
    expect(state.phaseStatus).toBe("Finished tool: read - /tmp/repo/package.json");
  });

  it("renders Pi tool details in live status", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-2",
              name: "find",
              arguments: { pattern: "*.ts", path: "/tmp/repo/packages" },
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

    expect(text).toContain("Tool execution");
    expect(text).toContain("`find` *.ts");
  });

  it("tracks Pi 0.83 tool execution lifecycle records", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "tool_execution_start",
        toolCallId: "tool-3",
        toolName: "read",
        args: { path: "/tmp/repo/package.json" },
      }),
      rawEvent(now + 1, {
        type: "tool_execution_end",
        toolCallId: "tool-3",
        toolName: "read",
        result: { content: [{ type: "text", text: "version 0.2.0" }], isError: false },
      }),
    ]);

    expect(state.tools[0]).toMatchObject({
      id: "tool-3",
      name: "read",
      status: "completed",
      title: "/tmp/repo/package.json",
      output: "version 0.2.0",
    });
    expect(state.phaseStatus).toBe("Finished tool: read - /tmp/repo/package.json");
  });
});
