import { getApp, handleStopCommand } from "./client";
import { loadEnv } from "../config";
import { openAgentsModal, openConfigModal, openGhAuthModal } from "./modals";
import { startOAuthFlow } from "./oauth";
import {
  setChannelAgentsMd,
  deleteChannelAgentsMd,
  setChannelAgentInstructions,
  deleteChannelAgentInstructions,
  updateChannelSettings,
  getOpenCodeSession,
  addPendingRestartMessage,
  getChannelCwd,
  getChannelSettings,
} from "../storage/settings";
import { getSessionsWithPendingRequests } from "../storage";
import { abortSession } from "../agents";

export function setupInteractiveHandlers(): void {
  const slackApp = getApp();

  // Handle /start actions
  slackApp.action("config_edit", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const triggerId = (body as any).trigger_id;
    if (channelId && triggerId) {
      await openConfigModal(client, triggerId, channelId);
    }
  });

  slackApp.action("agents_edit", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const triggerId = (body as any).trigger_id;
    if (channelId && triggerId) {
      await openAgentsModal(client, triggerId, channelId);
    }
  });

  slackApp.action("codex_auth", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const triggerId = (body as any).trigger_id;
    if (channelId && triggerId) {
      await startOAuthFlow(channelId, triggerId, client);
    }
  });

  slackApp.action("gh_auth", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const triggerId = (body as any).trigger_id;
    const userId = (body as any).user?.id;
    if (channelId && triggerId && userId) {
      await openGhAuthModal(client, triggerId, channelId, userId);
    }
  });

  slackApp.action("help", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const threadId = (body as any).message?.thread_ts || (body as any).message?.ts;
    if (channelId) {
      await client.chat.postMessage({
        channel: channelId,
        ...(threadId ? { thread_ts: threadId } : {}),
        text: `*Ode Commands*
Mention the bot with \`/start\` to open setup.

\`stop\` - Stop current operation
\`plan\` - Force a planning response
\`build\` - Force a build response`,
      });
    }
  });

  slackApp.action("stop_ode", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    const threadId = (body as any).message?.thread_ts || (body as any).message?.ts;
    
    if (channelId && threadId) {
       const stopped = await handleStopCommand(channelId, threadId, client);
       if (stopped) {
         await client.chat.postMessage({
           channel: channelId,
           thread_ts: threadId,
           text: "Request stopped.",
         });
       } else {
          // If we can't find a session by thread, try just the channel (legacy behavior)
          // But `handleStopCommand` currently loads session by channelId AND threadId.
          // If no threadId provided (e.g. from main channel message?), we might need to search?
          // The button is likely inside a message.
       }
    }
  });

  slackApp.action("restart_ode", async ({ ack, body, client }) => {
    await ack();
    const channelId = (body as any).channel?.id;
    
    if (channelId) {
        // Reuse restart logic... duplicate for now since it's short but involves imports
        const { pendingAuth } = await import("./oauth");
        pendingAuth.clear();

        const env = loadEnv();
        const cwd = getChannelCwd(channelId, env.DEFAULT_CWD);
        const sessionId = getOpenCodeSession(channelId, cwd);
        if (sessionId) {
          await abortSession(sessionId);
        }

        const pendingSessions = getSessionsWithPendingRequests();
        const restartTargets =
          pendingSessions.length > 0
            ? pendingSessions.map((session) => ({
                channelId: session.channelId,
                threadId: session.threadId,
              }))
            : [{ channelId, threadId: null }];

        for (const target of restartTargets) {
            // ... restart message logic ...
             try {
                const restartMessage = await client.chat.postMessage({
                  channel: target.channelId,
                  text: "Restarting Ode...",
                  ...(target.threadId ? { thread_ts: target.threadId } : {}),
                });
                if (restartMessage.ts) {
                  addPendingRestartMessage(target.channelId, restartMessage.ts);
                }
              } catch {}
        }
        process.kill(process.pid, "SIGUSR2");
    }
  });

  // Handle channel instruction edit modal submission
  slackApp.view("agents_edit_modal", async ({ ack, view }) => {
    await ack();

    const channelId = view.private_metadata;
    const values = view.state.values;
    const globalContent = values.agents_global?.content?.value || "";
    const planContent = values.agents_plan?.content?.value || "";
    const buildContent = values.agents_build?.content?.value || "";

    if (globalContent.trim()) {
      setChannelAgentsMd(channelId, globalContent);
    } else {
      deleteChannelAgentsMd(channelId);
    }

    if (planContent.trim()) {
      setChannelAgentInstructions(channelId, "plan", planContent);
    } else {
      deleteChannelAgentInstructions(channelId, "plan");
    }

    if (buildContent.trim()) {
      setChannelAgentInstructions(channelId, "build", buildContent);
    } else {
      deleteChannelAgentInstructions(channelId, "build");
    }
  });

  // Handle config edit modal submission
  slackApp.view("config_edit_modal", async ({ ack, view, client }) => {
    const { log } = await import("../logger");
    const { getAnyServerUrl } = await import("../agents/opencode/server");

    const channelId = view.private_metadata;
    const values = view.state.values;

    const agent = values.agent?.value?.value;
    const provider = values.provider?.value?.value;
    const model = values.model?.value?.value;
    const reasoning = values.reasoning?.value?.selected_option?.value as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined;

    // Validate provider/model combination if both are specified
    if (provider && model) {
      try {
        const serverUrl = await getAnyServerUrl();
        const response = await fetch(`${serverUrl}/provider`);
        if (response.ok) {
          const data = await response.json() as { all?: Array<{ id: string; models?: Record<string, { id: string }> }> };
          const providerData = data.all?.find((p) => p.id === provider);

          if (!providerData) {
            const availableProviders = data.all?.map((p) => p.id).slice(0, 10).join(", ") || "none";
            await ack({
              response_action: "errors",
              errors: {
                provider: `Provider "${provider}" not found. Available: ${availableProviders}...`,
              },
            });
            return;
          }

          const modelExists = providerData.models && Object.keys(providerData.models).some(
            (m) => m === model || m.includes(model) || model.includes(m)
          );

          if (!modelExists && providerData.models) {
            const availableModels = Object.keys(providerData.models).slice(0, 5).join(", ");
            await ack({
              response_action: "errors",
              errors: {
                model: `Model "${model}" not found for ${provider}. Available: ${availableModels}...`,
              },
            });
            return;
          }
        }
      } catch (err) {
        log.warn("Could not validate model", { error: String(err) });
        // Continue anyway if validation fails
      }
    }

    await ack();

    const agentOverrides: NonNullable<
      ReturnType<typeof getChannelSettings>["agentOverrides"]
    > = {};

    if (agent) agentOverrides.agent = agent;
    if (provider) agentOverrides.provider = provider;
    if (model) agentOverrides.model = model;
    if (reasoning) agentOverrides.reasoningEffort = reasoning;

    updateChannelSettings(channelId, { agentOverrides });

    // Notify user of successful update
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `Config updated: provider=${provider || "(default)"}, model=${model || "(default)"}`,
      });
    } catch {
      // Ignore notification errors
    }
  });

  // Handle GitHub auth modal submission
  slackApp.view("gh_auth_modal", async ({ ack, view, client }) => {
    const { saveGitHubAuth, saveGitHubAuthForUser, getGitHubAuth } = await import("../storage/settings");

    let channelId = view.private_metadata;
    let userId = "";
    let host = "github.com";
    try {
      const metadata = JSON.parse(view.private_metadata || "{}");
      if (metadata.channelId) channelId = metadata.channelId;
      if (metadata.userId) userId = metadata.userId;
      if (metadata.host) host = metadata.host;
    } catch {
      // Legacy modal metadata
    }

    const values = view.state.values;
    const userInput = values.gh_user?.value?.value || "";
    const tokenInput = values.gh_token?.value?.value || "";

    const errors: Record<string, string> = {};

    if (!tokenInput.trim()) {
      errors.gh_token = "Please enter a GitHub token";
    }

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    const baseAuth = getGitHubAuth(host);
    const saveParams = {
      host,
      user: userInput.trim() || undefined,
      token: tokenInput.trim(),
      gitProtocol: "ssh",
    };

    if (userId) {
      saveGitHubAuthForUser({ userId, ...saveParams });
    }

    if (!baseAuth) {
      saveGitHubAuth(saveParams);
    }

    const baseNote = !baseAuth ? " Set as base auth for new users." : "";

    await client.chat.postMessage({
      channel: channelId,
      text: `GitHub auth saved for ${host} (ssh).${baseNote}`,
    });
  });

  // Handle Codex OAuth callback submission
  slackApp.view("codex_oauth_callback", async ({ ack, view, client }) => {
    const { log } = await import("../logger");
    const metadata = JSON.parse(view.private_metadata || "{}");
    const { channelId } = metadata;
    const callbackUrl = view.state.values.callback_url?.value?.value || "";

    log.info("Codex OAuth callback submitted", { channelId, hasUrl: !!callbackUrl });

    if (!callbackUrl) {
      await ack({
        response_action: "errors",
        errors: {
          callback_url: "Please enter the callback URL",
        },
      });
      return;
    }

    await ack();

    // Process the callback
    const { handleCodexOAuthCallback } = await import("./oauth");
    await handleCodexOAuthCallback(callbackUrl, channelId, client);
  });

  // Legacy OAuth handlers (kept for backwards compatibility with any open modals)
  slackApp.view("oauth_provider_select", async ({ ack, view, client }) => {
    await ack();
    const channelId = view.private_metadata;
    await client.chat.postMessage({
      channel: channelId,
      text: "OAuth flow has been simplified. Use @ode /start to open setup and choose OpenAI Codex auth.",
    });
  });

  slackApp.view("oauth_callback_submit", async ({ ack, view, client }) => {
    await ack();
    const metadata = JSON.parse(view.private_metadata || "{}");
    const { channelId } = metadata;
    await client.chat.postMessage({
      channel: channelId,
      text: "OAuth callback is now handled via the modal. Use @ode /start to open setup and start authentication.",
    });
  });

  // Handle user choice button clicks (from slack_ask_user MCP tool)
  slackApp.action(/^user_choice_\d+$/, async ({ ack, body, client }) => {
    await ack();

    const action = (body as any).actions?.[0];
    const value = action?.value;
    const channel = (body as any).channel?.id;
    const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
    const userId = (body as any).user?.id;
    const messageTs = (body as any).message?.ts;

    if (!value || !channel || !threadTs) return;

    // Update the original message to remove buttons (keep question text only)
    if (messageTs) {
      const originalText = (body as any).message?.text || "Question";
      await client.chat.update({
        channel,
        ts: messageTs,
        text: originalText,
        blocks: [], // Remove the buttons
      });
    }

    // Post the user's choice as a regular message in the thread (for visibility)
    const selectionMsg = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `${value}`,
    });

    // Send the selection to OpenCode so the model can respond
    const { handleButtonSelection } = await import("./client");
    if (selectionMsg.ts) {
      await handleButtonSelection(channel, threadTs, userId || "unknown", value, selectionMsg.ts, client);
    }
  });
}
