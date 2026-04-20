import { describe, expect, it, mock } from "bun:test";
import { registerSlackMessageRouter } from "./message-router";

function createDeps(overrides: Partial<Parameters<typeof registerSlackMessageRouter>[0]> = {}) {
  const handleInboundEvent = mock(async () => {});

  return {
    app: {
      message: (handler: unknown) => handler,
    },
    isAuthorizedChannel: () => true,
    resolveWorkspaceAuth: () => undefined,
    syncWorkspaceForChannel: async () => false,
    getChannelWorkspaceName: () => "workspace",
    setChannelWorkspaceName: () => {},
    setChannelWorkspaceAuth: () => {},
    isThreadOwner: () => false,
    isThreadActive: () => false,
    postGeneralSettingsLauncher: async () => {},
    postCronLauncher: async () => {},
    describeSettingsIssues: () => [],
    handleInboundEvent,
    ...overrides,
  };
}

describe("registerSlackMessageRouter", () => {
  it("forwards stop-like messages to runtime kernel", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    const basePayload = {
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    };

    await registeredHandler!({
      ...basePayload,
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT> please stop this request",
        ts: "1710000000.000000",
      },
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(1);

    await registeredHandler!({
      ...basePayload,
      message: {
        channel: "C1",
        user: "U2",
        text: "<@U_BOT> stop",
        ts: "1710000000.000009",
      },
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("ignores messages that carry the current bot id", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        bot_id: "B_BOT",
        text: "main has uncommitted changes",
        ts: "1710000000.000015",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", bot_id: "B_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(0);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("detects mentions that include display names", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT|ode> stop",
        ts: "1710000000.000013",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("drops active-thread messages that mention a different bot", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      isThreadActive: () => true,
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_OTHER|other-bot> please handle this",
        ts: "1710000000.000014",
        thread_ts: "1710000000.000010",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(0);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("ignores non-owner thread replies unless bot is mentioned", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      isThreadActive: () => true,
      isThreadOwner: () => false,
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U_OTHER",
        text: "OpenCode is running...",
        ts: "1710000000.000017",
        thread_ts: "1710000000.000010",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(0);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("allows active owner replies without mention in multi-bot thread", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      isThreadActive: () => true,
      isThreadOwner: () => true,
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});
    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U_OWNER",
        text: "continue",
        ts: "1710000000.000018",
        thread_ts: "1710000000.000010",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(handleInboundEvent).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("caches bot identity and avoids auth.test on every message when bot token is known", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const authTest = mock(async () => ({ user_id: "U_BOT", team_id: "T1", enterprise_id: "E1" }));
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      resolveWorkspaceAuth: () => ({ workspaceId: "ws_123", botToken: "xoxb-token-1" }),
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT> hello",
        ts: "1710000000.000001",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: { teamId: "T1", enterpriseId: "E1" },
      body: { team_id: "T1", enterprise_id: "E1" },
      say,
    });

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U2",
        text: "<@U_BOT> again",
        ts: "1710000000.000002",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: { teamId: "T1", enterpriseId: "E1" },
      body: { team_id: "T1", enterprise_id: "E1" },
      say,
    });

    expect(authTest).toHaveBeenCalledTimes(1);
    expect(handleInboundEvent).toHaveBeenCalledTimes(2);
  });

  it("does not cache bot identity when team metadata is missing", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const identities = [
      { user_id: "U_BOT_A" },
      { user_id: "U_BOT_B" },
    ];
    let callCount = 0;
    const authTest = mock(async () => identities[callCount++] ?? identities[identities.length - 1]);
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT_A> hello",
        ts: "1710000000.000011",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: {},
      body: {},
      say,
    });

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U2",
        text: "<@U_BOT_B> again",
        ts: "1710000000.000012",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: {},
      body: {},
      say,
    });

    expect(authTest).toHaveBeenCalledTimes(2);
    expect(handleInboundEvent).toHaveBeenCalledTimes(2);
  });

  it("caches bot identity per bot token within same workspace", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const authTestA = mock(async () => ({ user_id: "U_BOT_A", team_id: "T1" }));
    const authTestB = mock(async () => ({ user_id: "U_BOT_B", team_id: "T1" }));
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      resolveWorkspaceAuth: (credentialKey?: string) => ({
        workspaceId: "ws_shared",
        botToken: credentialKey,
      }),
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT_A> hello",
        ts: "1710000000.000101",
      },
      client: {
        auth: {
          test: authTestA,
        },
      },
      context: { botToken: "xoxb-token-a" },
      body: { team_id: "T1" },
      say,
    });

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U2",
        text: "<@U_BOT_B> hello",
        ts: "1710000000.000102",
      },
      client: {
        auth: {
          test: authTestB,
        },
      },
      context: { botToken: "xoxb-token-b" },
      body: { team_id: "T1" },
      say,
    });

    expect(authTestA).toHaveBeenCalledTimes(1);
    expect(authTestB).toHaveBeenCalledTimes(1);
    expect(handleInboundEvent).toHaveBeenCalledTimes(2);
  });

  it("does not reuse bot identity cache across apps when only workspace id is known", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const authTest = mock(async () => {
      if (authTest.mock.calls.length === 1) {
        return { user_id: "U_BOT_A", team_id: "T1" };
      }
      return { user_id: "U_BOT_B", team_id: "T1" };
    });
    const handleInboundEvent = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      resolveWorkspaceAuth: () => ({ workspaceId: "ws_shared" }),
      handleInboundEvent,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT_A> hello",
        ts: "1710000000.000201",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: {},
      body: { team_id: "T1" },
      say,
    });

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U2",
        text: "<@U_BOT_A> still there?",
        ts: "1710000000.000202",
      },
      client: {
        auth: {
          test: authTest,
        },
      },
      context: {},
      body: { team_id: "T1" },
      say,
    });

    expect(authTest).toHaveBeenCalledTimes(2);
    expect(handleInboundEvent).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("does not trigger settings launcher for ignored non-mention messages", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const postGeneralSettingsLauncher = mock(async () => {});
    const say = mock(async () => {});
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      describeSettingsIssues: () => ["Model not configured.", "Working directory not configured."],
      postGeneralSettingsLauncher,
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "hello everyone",
        ts: "1710000000.000010",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(postGeneralSettingsLauncher).toHaveBeenCalledTimes(0);
    expect(say).toHaveBeenCalledTimes(0);
  });

  it("handles message processing errors with a thread reply", async () => {
    let registeredHandler: ((args: any) => Promise<void>) | undefined;
    const deps = createDeps({
      app: {
        message: (handler: (args: any) => Promise<void>) => {
          registeredHandler = handler;
        },
      },
      handleInboundEvent: async () => {
        throw new Error("boom");
      },
    });

    registerSlackMessageRouter(deps);
    expect(registeredHandler).toBeDefined();

    const say = mock(async () => {});

    await registeredHandler!({
      message: {
        channel: "C1",
        user: "U1",
        text: "<@U_BOT> fail",
        ts: "1710000000.000003",
      },
      client: {
        auth: {
          test: async () => ({ user_id: "U_BOT", team_id: "T1" }),
        },
      },
      context: { teamId: "T1" },
      body: { team_id: "T1" },
      say,
    });

    expect(say).toHaveBeenCalledWith({
      text: "I hit an internal error while handling that message. Please try again.",
      thread_ts: "1710000000.000003",
    });
  });
});
