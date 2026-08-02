import { describe, expect, it } from "bun:test";
import { buildSessionMessageState } from "../../utils/session-inspector";
import { buildLiveStatusMessage } from "../../utils/status";

describe("session inspector", () => {
  it("hydrates child-session tool metadata from normalized OpenCode events", () => {
    const startedAt = Date.now() - 40_000;
    const state = buildSessionMessageState([{
      timestamp: startedAt,
      type: "message.part.updated",
      data: {
        type: "message.part.updated",
        odeContext: {
          rootSessionID: "root-1",
          sourceSessionID: "child-1",
          childSession: true,
          childTitle: "Audit docs",
        },
        properties: {
          sessionID: "child-1",
          odeContext: {
            rootSessionID: "root-1",
            sourceSessionID: "child-1",
            childSession: true,
            childTitle: "Audit docs",
          },
          part: {
            id: "tool-child",
            sessionID: "child-1",
            type: "tool",
            tool: "read",
            state: {
              status: "running",
              title: "README.md",
              time: { start: startedAt },
            },
          },
        },
      },
    }], { provider: "opencode" });

    expect(state.tools[0]?.metadata).toMatchObject({
      startedAtMs: startedAt,
      sourceSessionId: "child-1",
      childSession: true,
      childTitle: "Audit docs",
    });
  });

  it("parses wrapped OpenCode payload events", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "session.status",
        data: {
          directory: "/tmp/repo",
          payload: {
            type: "session.status",
            properties: {
              sessionID: "ses_1",
              status: { type: "busy" },
            },
          },
        },
      },
      {
        timestamp: now + 1,
        type: "message.part.updated",
        data: {
          directory: "/tmp/repo",
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "tool_1",
                sessionID: "ses_1",
                type: "tool",
                tool: "Read",
                state: {
                  status: "running",
                  input: { filePath: "/tmp/repo/README.md" },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.phaseStatus).toBe("Running tool: Read");
    expect(state.tools.length).toBe(1);
    expect(state.tools[0]?.name).toBe("Read");
    expect(state.tools[0]?.status).toBe("running");
  });

  it("keeps detailed phase when busy updates arrive after tool progress", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "tool_1",
                sessionID: "ses_1",
                type: "tool",
                tool: "Read",
                state: {
                  status: "running",
                  input: { filePath: "/tmp/repo/README.md" },
                },
              },
            },
          },
        },
      },
      {
        timestamp: now + 1,
        type: "session.status",
        data: {
          payload: {
            type: "session.status",
            properties: {
              sessionID: "ses_1",
              status: { type: "busy" },
            },
          },
        },
      },
    ]);

    expect(state.phaseStatus).toBe("Running tool: Read");
  });

  it("formats reasoning updates into thinking status details", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "reasoning_1",
                sessionID: "ses_1",
                type: "reasoning",
                text: "**Planning repo exploration strategy**",
              },
            },
          },
        },
      },
    ]);

    expect(state.phaseStatus).toBe("Thinking: Planning repo exploration strategy");
  });

  it("only updates opencode phase when thinking details are present", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "tool_1",
                sessionID: "ses_1",
                type: "tool",
                tool: "Read",
                state: {
                  status: "running",
                  input: { filePath: "/tmp/repo/README.md" },
                },
              },
            },
          },
        },
      },
      {
        timestamp: now + 1,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "reasoning_1",
                sessionID: "ses_1",
                type: "reasoning",
                text: "Planning response sections",
              },
            },
          },
        },
      },
      {
        timestamp: now + 2,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "text_1",
                sessionID: "ses_1",
                type: "text",
                text: "Draft message body",
              },
            },
          },
        },
      },
    ], { provider: "opencode" });

    expect(state.phaseStatus).toBe("Thinking: Planning response sections");
  });

  it("renders non-empty preview details from wrapped events", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "session.updated",
        data: {
          payload: {
            type: "session.updated",
            properties: {
              info: {
                title: "Investigate status preview",
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "tool_2",
                sessionID: "ses_1",
                type: "tool",
                tool: "Grep",
                state: {
                  status: "completed",
                  input: { pattern: "session.status", path: "/tmp/repo" },
                },
              },
            },
          },
        },
      },
    ]);

    const preview = buildLiveStatusMessage(
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "medium"
    );

    expect(preview).toContain("Investigate status preview");
    expect(preview).toContain("Tool execution");
    expect(preview).toContain("`Grep`");
  });

  it("ignores session slug when OpenCode title is generic", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "session.updated",
        data: {
          payload: {
            type: "session.updated",
            properties: {
              info: {
                title: "New session - 2026-02-20T05:51:37.251Z",
                slug: "neon-harbor",
              },
            },
          },
        },
      },
    ]);

    expect(state.sessionTitle).toBeUndefined();
  });

  it("does not expose injected Ode system context as the session title", () => {
    const state = buildSessionMessageState([{
      timestamp: Date.now(),
      type: "session.updated",
      data: {
        properties: {
          title: "<system-prompt>\nODE RUNTIME CONTEXT:\n- Platform: slack",
        },
      },
    }], { provider: "codebuddy" });

    expect(state.sessionTitle).toBeUndefined();
  });

  it("prefers summarized title over sibling slug", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "session.updated",
        data: {
          payload: {
            type: "session.updated",
            properties: {
              slug: "silent-ocean",
              info: {
                title: "Fix session title extraction",
              },
            },
          },
        },
      },
    ]);

    expect(state.sessionTitle).toBe("Fix session title extraction");
  });

  it("hydrates OpenCode model/agent and reported total tokens", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "session.updated",
        data: {
          payload: {
            type: "session.updated",
            properties: {
              info: {
                title: "Inspect stream payload",
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                modelID: "gpt-5.3-codex",
                agent: "build",
                cost: 0,
                tokens: {
                  total: 41681,
                  input: 295,
                  output: 42,
                  reasoning: 0,
                  cache: {
                    read: 41344,
                    write: 0,
                  },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.model).toBe("gpt-5.3-codex");
    expect(state.agent).toBe("build");
    expect(state.tokenUsage?.total).toBe(41681);

    const text = buildLiveStatusMessage(
      {
        channelId: "C1",
        threadId: "T1",
        statusMessageTs: "S1",
        startedAt,
        currentText: "",
      },
      "/tmp/repo",
      state,
      "medium"
    );

    expect(text).toContain("gpt-5.3-codex");
    expect(text).toContain("42k tokens");
    expect(text).toContain("build");
    expect(text).not.toContain("cost 0");
  });

  it("hydrates OpenCode token usage from nested message info shape", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              message: {
                info: {
                  title: "Refactor live status parser",
                  modelId: "gpt-5.3-codex",
                  agentName: "build",
                  usage: {
                    total_tokens: 1024,
                    input_tokens: 200,
                    output_tokens: 120,
                    reasoning_tokens: 4,
                    cache_tokens: {
                      input_tokens: 700,
                      output_tokens: 0,
                    },
                  },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.sessionTitle).toBeUndefined();
    expect(state.model).toBe("gpt-5.3-codex");
    expect(state.agent).toBe("build");
    expect(state.tokenUsage?.total).toBe(1024);
    expect(state.tokenUsage?.cacheRead).toBe(700);
  });

  it("hydrates metadata from raw provider records", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "qwen.raw.message",
        data: {
          payload: {
            type: "qwen.raw.message",
            properties: {
              record: {
                model: {
                  providerID: "openai",
                  modelID: "gpt-5.3-codex",
                },
                mode: "build",
                usage: {
                  prompt_tokens: 120,
                  completion_tokens: 80,
                  total_tokens: 240,
                  cache_tokens: {
                    input_tokens: 40,
                  },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.model).toBe("gpt-5.3-codex");
    expect(state.agent).toBe("build");
    expect(state.tokenUsage?.input).toBe(120);
    expect(state.tokenUsage?.output).toBe(80);
    expect(state.tokenUsage?.cacheRead).toBe(40);
    expect(state.tokenUsage?.total).toBe(240);
  });

  it("hydrates token usage from nested codex and kilo event shapes", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "codex.raw.turn.completed",
        data: {
          payload: {
            type: "codex.raw.turn.completed",
            properties: {
              event: {
                type: "turn.completed",
                usage: {
                  input_tokens: 1000,
                  output_tokens: 50,
                },
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "kilo.raw.step_finish",
        data: {
          payload: {
            type: "kilo.raw.step_finish",
            properties: {
              record: {
                type: "step_finish",
                part: {
                  tokens: {
                    input: 200,
                    output: 30,
                    cache: {
                      read: 70,
                    },
                  },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.tokenUsage?.input).toBe(200);
    expect(state.tokenUsage?.output).toBe(30);
    expect(state.tokenUsage?.cacheRead).toBe(70);
    expect(state.tokenUsage?.total).toBe(300);
  });

  it("keeps Claude cumulative token usage monotonic across nested progress records", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "claude.raw.assistant",
        data: {
          payload: {
            type: "claude.raw.assistant",
            properties: {
              record: {
                type: "assistant",
                usage: {
                  input_tokens: 20_000,
                  output_tokens: 3_000,
                },
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "claude.raw.tool_progress",
        data: {
          payload: {
            type: "claude.raw.tool_progress",
            properties: {
              record: {
                type: "tool_progress",
                usage: {
                  input_tokens: 1_000,
                  output_tokens: 200,
                },
              },
            },
          },
        },
      },
    ], { provider: "claudecode" });

    expect(state.tokenUsage?.input).toBe(20_000);
    expect(state.tokenUsage?.output).toBe(3_000);
    expect(state.tokenUsage?.total).toBe(23_000);
  });

  it("hydrates OpenCode model when info.model is an object", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                model: {
                  providerID: "openai",
                  modelID: "gpt-5.3-codex",
                },
                mode: "build",
              },
            },
          },
        },
      },
    ]);

    expect(state.model).toBe("gpt-5.3-codex");
    expect(state.agent).toBe("build");
  });

  it("does not clear token usage when later message.updated has empty usage object", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                modelID: "gpt-5.3-codex",
                tokens: {
                  total: 2048,
                  input: 500,
                  output: 200,
                  reasoning: 10,
                  cache: { read: 1338, write: 0 },
                },
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                tokens: {},
              },
            },
          },
        },
      },
    ]);

    expect(state.tokenUsage?.total).toBe(2048);
    expect(state.tokenUsage?.input).toBe(500);
  });

  it("does not regress to zero tokens when a later event reports zero usage", () => {
    const startedAt = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: startedAt,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                modelID: "gpt-5.3-codex",
                tokens: {
                  total: 1500,
                  input: 400,
                  output: 100,
                  cache: { read: 1000, write: 0 },
                },
              },
            },
          },
        },
      },
      {
        timestamp: startedAt + 1,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                tokens: {
                  total: 0,
                  input: 0,
                  output: 0,
                  cache: { read: 0, write: 0 },
                },
              },
            },
          },
        },
      },
    ]);

    expect(state.tokenUsage?.total).toBe(1500);
    expect(state.tokenUsage?.input).toBe(400);
  });

  it("parses todo.updated aliases from wrapped payload events", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "todo.updated",
        data: {
          payload: {
            type: "todo.updated",
            properties: {
              items: [
                { title: "Check status rendering", status: "in progress" },
                { content: "Keep final waiting state", status: "completed" },
              ],
            },
          },
        },
      },
    ]);

    expect(state.todos).toEqual([
      { content: "Check status rendering", status: "in_progress" },
      { content: "Keep final waiting state", status: "completed" },
    ]);
  });

  it("ignores TextPart events that belong to a user message", () => {
    const now = Date.now();
    const userPrompt = "You can use accounts in infra/readme, can connect to staging db";

    const state = buildSessionMessageState([
      // OpenCode announces the user message first; this records role="user"
      // for messageID "msg_user_1".
      {
        timestamp: now,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                id: "msg_user_1",
                sessionID: "ses_1",
                role: "user",
              },
            },
          },
        },
      },
      // A TextPart for the user message arrives. This MUST NOT populate
      // state.currentText - previously this caused the bot to echo the
      // user's prompt back as the final response.
      {
        timestamp: now + 1,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "prt_user_text_1",
                sessionID: "ses_1",
                messageID: "msg_user_1",
                type: "text",
                text: userPrompt,
              },
            },
          },
        },
      },
      // The assistant message is created; role="assistant" now tracked
      // under messageID "msg_asst_1". The turn runs a tool and stops
      // without emitting any assistant text.
      {
        timestamp: now + 2,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                id: "msg_asst_1",
                sessionID: "ses_1",
                role: "assistant",
              },
            },
          },
        },
      },
      {
        timestamp: now + 3,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "tool_1",
                sessionID: "ses_1",
                messageID: "msg_asst_1",
                type: "tool",
                tool: "Read",
                state: { status: "completed" },
              },
            },
          },
        },
      },
    ]);

    expect(state.currentText).toBe("");
    expect(state.tools.length).toBe(1);
  });

  it("still captures assistant TextPart as currentText", () => {
    const now = Date.now();
    const state = buildSessionMessageState([
      {
        timestamp: now,
        type: "message.updated",
        data: {
          payload: {
            type: "message.updated",
            properties: {
              info: {
                id: "msg_asst_1",
                sessionID: "ses_1",
                role: "assistant",
              },
            },
          },
        },
      },
      {
        timestamp: now + 1,
        type: "message.part.updated",
        data: {
          payload: {
            type: "message.part.updated",
            properties: {
              part: {
                id: "prt_asst_text_1",
                sessionID: "ses_1",
                messageID: "msg_asst_1",
                type: "text",
                text: "Here is the summary of changes",
              },
            },
          },
        },
      },
    ]);

    expect(state.currentText).toBe("Here is the summary of changes");
  });

  it("keeps unknown provider protocol events visible in live status", () => {
    const state = buildSessionMessageState([{
      timestamp: Date.now(),
      type: "qwen.raw.stream_event",
      data: {
        properties: {
          record: { type: "stream_event", event: { type: "future_event" } },
          recordType: "stream_event",
          streamEventType: "future_event",
          protocolKnown: false,
          protocolLabel: "Qwen stream future_event",
        },
      },
    }], { provider: "qwen" });

    expect(state.phaseStatus).toBe("Qwen Code integration update required: Qwen stream future_event");
  });
});
