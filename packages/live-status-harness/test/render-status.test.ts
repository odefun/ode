import { describe, expect, it } from "bun:test";
import { renderStatusesFromRun } from "../renderer";
import type { HarnessCapturedEvent, HarnessRunMeta } from "../types";

type FixtureShape = {
  meta: HarnessRunMeta;
  events: HarnessCapturedEvent[];
};

describe("live status harness renderer", () => {
  it("renders deterministic incremental statuses from captured events", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/claude-basic-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(statuses[0]?.text).toContain("Running tool: Read");
    expect(statuses[statuses.length - 1]?.text).toContain("Finished tool: Read");
    expect(statuses.some((status) => status.text.includes("Drafting response"))).toBeTrue();
  });

  it("renders codex tool and response statuses from fixture", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/codex-basic-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(statuses.length).toBeGreaterThanOrEqual(4);
    expect(joined).toContain("Running tool: Bash");
    expect(joined).toContain("Finished tool: Bash");
    expect(joined).toContain("Drafting response");
  });

  it("keeps Codex child output scoped to its subagent", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/codex-app-subagent-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");
    const final = statuses.at(-1)?.text ?? "";

    expect(joined).toContain("`subagent` package_identity");
    expect(final).toContain("The package is ode, version 0.2.0.");
    expect(final).not.toContain("**Latest output**\node 0.2.0");
  });

  it("renders Claude task progress without flattening child tools", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/claude-subagent-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(joined).toContain("Waiting for subagent: Read package metadata — Checking package metadata");
    expect(joined).toContain("`subagent` Read package metadata");
    expect(joined).not.toContain("`Read` package.json");
    expect(joined).toContain("Finished subagent: Read package metadata");
  });

  it("renders OpenCode child-session progress from normalized sync events", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/opencode-child-sync-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(joined).toContain("Waiting for subagent: Audit repository docs");
    expect(joined).toContain("~ `read`");
    expect(joined).toContain("- `task` Audit repository docs");
  });

  it("renders kilo live status from fixture", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/kilo-basic-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(joined).toContain("Working");
    expect(joined).toContain("Waiting");
  });

  it("renders goose live status from fixture", async () => {
    const fixtureFile = Bun.file(`${import.meta.dir}/fixtures/goose-basic-run.json`);
    const fixture = JSON.parse(await fixtureFile.text()) as FixtureShape;

    const statuses = renderStatusesFromRun(fixture.meta, fixture.events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(statuses.length).toBeGreaterThanOrEqual(2);
    expect(joined).toContain("Goose is running...");
    expect(joined).toContain("Finished tool: Read");
  });

  it("renders goose subagent completion when tool response uses tool_use_id", () => {
    const now = Date.now();
    const meta: HarnessRunMeta = {
      runId: "run-goose-subagent-id",
      provider: "goose",
      prompt: "test",
      promptHash: "hash",
      cwd: "/tmp/repo",
      channelId: "C1",
      threadId: "T1",
      sessionId: "goose_s1",
      startedAt: now,
      eventCount: 2,
    };

    const events: HarnessCapturedEvent[] = [
      {
        runId: "run-goose-subagent-id",
        sessionId: "goose_s1",
        provider: "goose",
        timestamp: now,
        index: 0,
        event: {
          type: "goose.raw.message",
          properties: {
            record: {
              type: "message",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolRequest",
                    id: "call-subagent-1",
                    toolCall: {
                      value: {
                        name: "subagent",
                        arguments: { instructions: "inspect repo" },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        runId: "run-goose-subagent-id",
        sessionId: "goose_s1",
        provider: "goose",
        timestamp: now + 1,
        index: 1,
        event: {
          type: "goose.raw.message",
          properties: {
            record: {
              type: "message",
              message: {
                role: "user",
                content: [
                  {
                    type: "toolResponse",
                    tool_use_id: "call-subagent-1",
                    toolResult: {
                      status: "success",
                      value: {
                        content: [
                          { type: "text", text: "subagent complete" },
                        ],
                        isError: false,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ];

    const statuses = renderStatusesFromRun(meta, events);
    const joined = statuses.map((status) => status.text).join("\n\n");

    expect(joined).toContain("Running tool: subagent");
    expect(joined).toContain("Finished tool: subagent");
  });

  it("renders todos and waiting status from wrapped payload events", () => {
    const now = Date.now();
    const meta: HarnessRunMeta = {
      runId: "run-qwen-todo-test",
      provider: "qwen",
      prompt: "test",
      promptHash: "hash",
      cwd: "/tmp/repo",
      channelId: "C1",
      threadId: "T1",
      sessionId: "qwen_s1",
      startedAt: now,
      eventCount: 4,
    };

    const events: HarnessCapturedEvent[] = [
      {
        runId: "run-qwen-todo-test",
        sessionId: "qwen_s1",
        provider: "qwen",
        timestamp: now,
        index: 0,
        event: {
          payload: {
            type: "session.status",
            properties: {
              status: { type: "busy" },
            },
          },
        },
      },
      {
        runId: "run-qwen-todo-test",
        sessionId: "qwen_s1",
        provider: "qwen",
        timestamp: now + 1,
        index: 1,
        event: {
          payload: {
            type: "qwen.raw.stream_event",
            properties: {
              record: {
                type: "stream_event",
                event: {
                  type: "content_block_start",
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: "todo-1",
                    name: "todo_write",
                  },
                },
              },
            },
          },
        },
      },
      {
        runId: "run-qwen-todo-test",
        sessionId: "qwen_s1",
        provider: "qwen",
        timestamp: now + 2,
        index: 2,
        event: {
          payload: {
            type: "qwen.raw.stream_event",
            properties: {
              record: {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: '{"todos":[{"content":"Verify harness parser","status":"in progress"}]}',
                  },
                },
              },
            },
          },
        },
      },
      {
        runId: "run-qwen-todo-test",
        sessionId: "qwen_s1",
        provider: "qwen",
        timestamp: now + 3,
        index: 3,
        event: {
          payload: {
            type: "session.status",
            properties: {
              status: { type: "idle" },
            },
          },
        },
      },
    ];

    const statuses = renderStatusesFromRun(meta, events);
    const finalText = statuses[statuses.length - 1]?.text || "";

    expect(finalText).toContain("**Plan**");
    expect(finalText).toContain("- [~] Verify harness parser");
    expect(finalText).toContain("*Waiting*");
  });
});
