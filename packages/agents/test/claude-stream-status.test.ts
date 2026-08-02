import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildStatusMessageByProvider } from "../../utils/status";

function rawEvent(timestamp: number, record: Record<string, unknown>) {
  return {
    timestamp,
    type: `claude.raw.${String(record.type ?? "unknown")}`,
    data: {
      properties: {
        record,
      },
    },
  };
}

describe("claude stream status parsing", () => {
  it("builds cumulative text from raw text deltas", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: " world" },
        },
      }),
    ]);

    expect(state.phaseStatus).toBe("Drafting response");
    expect(state.currentText).toBe("Hello world");
  });

  it("combines text deltas from multiple content block indexes", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: " world" },
        },
      }),
    ]);

    expect(state.currentText).toBe("Hello world");
  });

  it("keeps a tool running when only its streamed input block has ended", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
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
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"filePath":"README.md"}' },
        },
      }),
      rawEvent(now + 2, {
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 1,
        },
      }),
    ]);

    expect(state.phaseStatus).toBe("Running tool: Read");
    expect(state.tools.length).toBe(1);
    expect(state.tools[0]?.name).toBe("Read");
    expect(state.tools[0]?.status).toBe("running");
    expect(state.tools[0]?.input).toEqual({ filePath: "README.md" });
  });

  it("does not resurrect a completed tool when the next message reuses its block index", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "message_tool" } },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_read", name: "Read" },
        },
      }),
      rawEvent(now + 2, {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool_read", content: "done" }],
        },
      }),
      rawEvent(now + 3, {
        type: "stream_event",
        event: { type: "message_start", message: { id: "message_text" } },
      }),
      rawEvent(now + 4, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      }),
      rawEvent(now + 5, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "finished" },
        },
      }),
      rawEvent(now + 6, {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
    ], { provider: "claudecode" });

    expect(state.currentText).toBe("finished");
    expect(state.tools.find((tool) => tool.id === "tool_read")?.status).toBe("completed");
    expect(state.phaseStatus).toBe("Finished step");
  });

  it("tracks tool lifecycle from assistant tool_use and user tool_result records", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: {
                file_path: "/tmp/repo/README.md",
              },
            },
            {
              type: "tool_use",
              id: "call_2",
              name: "Bash",
              input: {
                command: "ls -la",
              },
            },
          ],
        },
      }),
      rawEvent(now + 1, {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: "README contents",
              is_error: false,
            },
          ],
        },
      }),
    ]);

    expect(state.phaseStatus).toBe("Finished tool: Read - /tmp/repo/README.md");
    expect(state.tools.length).toBe(2);
    expect(state.tools[0]?.name).toBe("Read");
    expect(state.tools[0]?.status).toBe("completed");
    expect(state.tools[0]?.input).toEqual({ file_path: "/tmp/repo/README.md" });
    expect(state.tools[1]?.name).toBe("Bash");
    expect(state.tools[1]?.status).toBe("running");
  });

  it("hydrates todos from assistant TodoWrite tool input", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "todo_1",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Inspect stream payload", status: "completed" },
                  { content: "Patch Claude parser", status: "in progress" },
                ],
              },
            },
          ],
        },
      }),
    ]);

    expect(state.todos).toEqual([
      { content: "Inspect stream payload", status: "completed" },
      { content: "Patch Claude parser", status: "in_progress" },
    ]);
  });

  it("hydrates todos from TodoWrite input_json_delta stream events", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "tool_use",
            id: "todo_stream_1",
            name: "TodoWrite",
          },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 3,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"Capture regression","status":"completed"},{"content":"Render task section","status":"in progress"}]}',
          },
        },
      }),
    ]);

    expect(state.todos).toEqual([
      { content: "Capture regression", status: "completed" },
      { content: "Render task section", status: "in_progress" },
    ]);
  });

  it("tracks thinking text from raw thinking deltas", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "thinking",
            thinking: "Plan",
          },
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 2,
          delta: { type: "thinking_delta", thinking: " next step" },
        },
      }),
    ]);

    expect(state.phaseStatus).toBe("Thinking");
    expect(state.thinkingText).toBe("Plan next step");
  });

  it("extracts session title from raw claude records", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "meta",
        info: {
          title: "Fix Slack status updates",
        },
      }),
    ]);

    expect(state.sessionTitle).toBe("Fix Slack status updates");
  });

  it("renders claude status message from raw records", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "meta",
        info: {
          title: "Investigate preview",
        },
      }),
      rawEvent(now + 1, {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-2",
            name: "Grep",
            input: { pattern: "session.status", path: "/tmp/repo" },
          },
        },
      }),
      rawEvent(now + 2, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Collecting preview details" },
        },
      }),
    ]);

    const text = buildStatusMessageByProvider(
      "claudecode",
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

    expect(text).toContain("Investigate preview");
    expect(text).toContain("Drafting response");
    expect(text).toContain("`Grep`");
    expect(text).toContain("session.status in tmp/repo");
  });

  it("renders assistant-derived tool details in claude status message", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_read",
              name: "Read",
              input: {
                file_path: "/tmp/repo/packages/core/index.ts",
              },
            },
            {
              type: "tool_use",
              id: "call_bash",
              name: "Bash",
              input: {
                command: "ls -la",
              },
            },
            {
              type: "tool_use",
              id: "call_task",
              name: "Task",
              input: {
                description: "Explore codebase structure",
                prompt: "Detailed prompt text",
              },
            },
          ],
        },
      }),
    ]);

    const text = buildStatusMessageByProvider(
      "claudecode",
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt: now,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "aggressive"
    );

    expect(text).toContain("`Read` packages/core/index.ts");
    expect(text).toContain("`Bash` ls -la");
    expect(text).toContain("`subagent`");
  });

  it("renders real Claude task lifecycle events as one subagent", () => {
    const now = Date.now() - 35_000;
    const events = [
      rawEvent(now, {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "call_agent_1",
            name: "Agent",
            input: { description: "Read package metadata", prompt: "Read package.json" },
          }],
        },
      }),
      rawEvent(now + 1, {
        type: "system",
        subtype: "task_started",
        task_id: "task_1",
        tool_use_id: "call_agent_1",
        description: "Read package metadata",
        subagent_type: "general-purpose",
      }),
      rawEvent(now + 2, {
        type: "assistant",
        parent_tool_use_id: "call_agent_1",
        task_description: "Read package metadata",
        message: {
          content: [{
            type: "tool_use",
            id: "child_read",
            name: "Read",
            input: { file_path: "/tmp/repo/package.json" },
          }],
        },
      }),
      rawEvent(now + 3, {
        type: "system",
        subtype: "task_progress",
        task_id: "task_1",
        tool_use_id: "call_agent_1",
        description: "Reading package.json",
        summary: "Checking package metadata",
        last_tool_name: "Read",
        usage: { total_tokens: 20, tool_uses: 1, duration_ms: 3000 },
      }),
    ];
    const running = buildSessionMessageState(events);

    expect(running.tools).toHaveLength(1);
    expect(running.tools[0]?.name).toBe("subagent");
    expect(running.tools[0]?.status).toBe("running");
    expect(running.tools[0]?.metadata?.lastTool).toBe("Read");
    expect(running.phaseStatus).toBe("Subagent Read package metadata: Checking package metadata");

    const statusText = buildStatusMessageByProvider(
      "claudecode",
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt: now,
        currentText: "",
      },
      "/tmp/repo",
      running,
      "medium"
    );
    expect(statusText).toContain("Waiting for subagent: Read package metadata");
    expect(statusText).not.toContain("`Read`");

    const completed = buildSessionMessageState([
      ...events,
      rawEvent(now + 4, {
        type: "system",
        subtype: "task_notification",
        task_id: "task_1",
        tool_use_id: "call_agent_1",
        status: "completed",
        summary: "ode 0.2.0",
      }),
    ]);
    expect(completed.tools[0]?.status).toBe("completed");
    expect(completed.tools[0]?.output).toBe("ode 0.2.0");
    expect(completed.phaseStatus).toBe("Finished subagent: Read package metadata");
  });

  it("shows Claude retry and precise result errors", () => {
    const now = Date.now();
    const retrying = buildSessionMessageState([
      rawEvent(now, {
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 4,
        retry_delay_ms: 2500,
      }),
    ]);
    expect(retrying.phaseStatus).toBe("Retrying Claude request 2/4 in 3s");

    const failed = buildSessionMessageState([
      rawEvent(now, {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["upstream disconnected"],
      }),
    ]);
    expect(failed.phaseStatus).toBe("Claude error: upstream disconnected");
  });

  it("uses frequency config for latest actions and shows last-N header", () => {
    const now = Date.now();
    const toolUses = Array.from({ length: 9 }, (_, idx) => ({
      type: "tool_use",
      id: `call_${idx + 1}`,
      name: "Read",
      input: {
        file_path: `/tmp/repo/file-${idx + 1}.ts`,
      },
    }));

    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "assistant",
        message: {
          content: toolUses,
        },
      }),
    ]);

    const text = buildStatusMessageByProvider(
      "claudecode",
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

    expect(text).toContain("Tool execution (Last 6 items in 9)");
    expect(text).not.toContain("`Read` file-1.ts");
    expect(text).toContain("`Read` file-9.ts");
  });

  it("uses shared renderer format with a latest-output preview", () => {
    const now = Date.now();
    const longResponse = `${"A".repeat(180)}\n\n${"B".repeat(180)}`;
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: longResponse,
            },
          ],
        },
      }),
    ]);

    const text = buildStatusMessageByProvider(
      "claudecode",
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt: now,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "minimum"
    );

    expect(text).toContain("Drafting response");
    expect(text).toContain("**Latest output**");
    expect(text).toContain(longResponse);
  });

  it("falls back to claude header when title is unavailable", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      rawEvent(now, {
        type: "stream_event",
        event: {
          type: "message_start",
        },
      }),
    ]);

    const text = buildStatusMessageByProvider(
      "claudecode",
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt: now,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "minimum"
    );

    expect(text).toContain("*Claude Code is running...*");
  });
});
