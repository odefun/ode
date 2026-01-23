import { getApp, sendMessage } from "./client";
import { loadEnv } from "../config";
import {
  getChannelCwd,
  setChannelCwd,
  getChannelAgentsMd,
  setChannelAgentsMd,
  deleteChannelAgentsMd,
  getChannelAgentInstructions,
  setChannelAgentInstructions,
  deleteChannelAgentInstructions,
  clearOpenCodeSessions,
  getChannelSettings,
  updateChannelSettings,
  getOpenCodeSession,
  addPendingRestartMessage,
} from "../storage/settings";
import { getSessionsWithPendingRequests } from "../storage";
import { cancelActiveRequest, abortSession } from "../agents";

export function setupSlashCommands(): void {
  const slackApp = getApp();
  const env = loadEnv();

  // /ode - Main command with subcommands
  slackApp.command("/ode", async ({ command, ack, respond, client }) => {
    await ack();

    const args = command.text.trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase() || "help";
    const channelId = command.channel_id;

    switch (subcommand) {
      case "help": {
        await respond({
          response_type: "ephemeral",
          text: `*Ode Commands*

\`/ode help\` - Show this help
\`/ode cwd\` - Show current working directory
\`/ode cwd <path>\` - Set working directory
\`/ode agents\` - View channel instructions
\`/ode agents edit\` - Edit channel instructions
\`/ode agents clear\` - Clear channel instructions
\`/ode stop\` - Stop current operation
\`/ode clear\` - Clear all sessions
\`/ode config\` - View/edit OpenCode config
\`/ode auth\` - Login with OpenAI Codex (ChatGPT Pro/Plus)
\`/ode gh auth\` - Login to GitHub CLI
\`/ode restart\` - Restart the bot`,
        });
        break;
      }

      case "cwd": {
        const path = args.slice(1).join(" ");
        if (!path) {
          const currentCwd = getChannelCwd(channelId, env.DEFAULT_CWD);
          await respond({
            response_type: "ephemeral",
            text: `Current working directory: \`${currentCwd}\``,
          });
        } else {
          setChannelCwd(channelId, path);
          await respond({
            response_type: "ephemeral",
            text: `Working directory set to: \`${path}\``,
          });
        }
        break;
      }

      case "agents": {
        const action = args[1]?.toLowerCase();

        if (action === "edit") {
          const currentContent = getChannelAgentsMd(channelId) || "";
          const planContent = getChannelAgentInstructions(channelId, "plan") || "";
          const buildContent = getChannelAgentInstructions(channelId, "build") || "";

          await client.views.open({
            trigger_id: command.trigger_id,
            view: {
              type: "modal",
              callback_id: "agents_edit_modal",
              private_metadata: channelId,
              title: {
                type: "plain_text",
                text: "Edit Instructions",
              },
              submit: {
                type: "plain_text",
                text: "Save",
              },
              close: {
                type: "plain_text",
                text: "Cancel",
              },
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "Edit global and agent-specific instructions for this channel. Global instructions apply to every request, while plan/build instructions apply only to those agents.",
                  },
                },
                {
                  type: "input",
                  block_id: "agents_global",
                  label: {
                    type: "plain_text",
                    text: "Global Instructions",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "content",
                    multiline: true,
                    initial_value: currentContent,
                    placeholder: {
                      type: "plain_text",
                      text: "Enter global instructions...",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "agents_plan",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Plan Instructions",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "content",
                    multiline: true,
                    initial_value: planContent,
                    placeholder: {
                      type: "plain_text",
                      text: "Enter plan agent instructions...",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "agents_build",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Build Instructions",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "content",
                    multiline: true,
                    initial_value: buildContent,
                    placeholder: {
                      type: "plain_text",
                      text: "Enter build agent instructions...",
                    },
                  },
                },
              ],
            },
          });
        } else if (action === "clear") {
          deleteChannelAgentsMd(channelId);
          deleteChannelAgentInstructions(channelId, "plan");
          deleteChannelAgentInstructions(channelId, "build");
          await respond({
            response_type: "ephemeral",
            text: "Channel instructions cleared.",
          });
        } else {
          const globalContent = getChannelAgentsMd(channelId);
          const planContent = getChannelAgentInstructions(channelId, "plan");
          const buildContent = getChannelAgentInstructions(channelId, "build");
          const formatSection = (title: string, content: string | null) =>
            content && content.trim().length > 0
              ? `*${title}:*\n\`\`\`\n${content}\n\`\`\``
              : `*${title}:* (none)`;

          const sections = [
            formatSection("Global Instructions", globalContent),
            formatSection("Plan Instructions", planContent),
            formatSection("Build Instructions", buildContent),
          ];

          await respond({
            response_type: "ephemeral",
            text: sections.join("\n\n"),
          });
        }
        break;
      }

      case "stop": {
        const settings = getChannelSettings(channelId);
        const cwd = getChannelCwd(channelId, env.DEFAULT_CWD);
        const sessionId = getOpenCodeSession(channelId, cwd);

        if (sessionId) {
          const cancelled = await cancelActiveRequest(channelId, sessionId);
          if (cancelled) {
            await respond({
              response_type: "ephemeral",
              text: "Operation cancelled.",
            });
          } else {
            await respond({
              response_type: "ephemeral",
              text: "No active operation to cancel.",
            });
          }
        } else {
          await respond({
            response_type: "ephemeral",
            text: "No active session.",
          });
        }
        break;
      }

      case "clear": {
        clearOpenCodeSessions(channelId);
        await respond({
          response_type: "ephemeral",
          text: "All sessions cleared for this channel.",
        });
        break;
      }

      case "config": {
        const action = args[1]?.toLowerCase();

        if (action === "edit") {
          const settings = getChannelSettings(channelId);
          const overrides = settings.agentOverrides || {};

          await client.views.open({
            trigger_id: command.trigger_id,
            view: {
              type: "modal",
              callback_id: "config_edit_modal",
              private_metadata: channelId,
              title: {
                type: "plain_text",
                text: "OpenCode Config",
              },
              submit: {
                type: "plain_text",
                text: "Save",
              },
              close: {
                type: "plain_text",
                text: "Cancel",
              },
              blocks: [
                {
                  type: "input",
                  block_id: "cwd",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Working Directory",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    initial_value: settings.customCwd || "",
                    placeholder: {
                      type: "plain_text",
                      text: "e.g., ~/Code/ode",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "agent",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Agent Override",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    initial_value: overrides.agent || "",
                    placeholder: {
                      type: "plain_text",
                      text: "e.g., build, plan, code",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "provider",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Provider ID",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    initial_value: overrides.provider || "",
                    placeholder: {
                      type: "plain_text",
                      text: "e.g., openai, anthropic",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "model",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Model ID",
                  },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    initial_value: overrides.model || "",
                    placeholder: {
                      type: "plain_text",
                      text: "e.g., codex-mini, claude-opus-4",
                    },
                  },
                },
                {
                  type: "input",
                  block_id: "reasoning",
                  optional: true,
                  label: {
                    type: "plain_text",
                    text: "Reasoning Effort",
                  },
                  element: {
                    type: "static_select",
                    action_id: "value",
                    initial_option: overrides.reasoningEffort
                      ? {
                          text: {
                            type: "plain_text",
                            text: overrides.reasoningEffort,
                          },
                          value: overrides.reasoningEffort,
                        }
                      : undefined,
                    placeholder: {
                      type: "plain_text",
                      text: "Select effort level",
                    },
                    options: [
                      {
                        text: { type: "plain_text", text: "Low" },
                        value: "low",
                      },
                      {
                        text: { type: "plain_text", text: "Medium" },
                        value: "medium",
                      },
                      {
                        text: { type: "plain_text", text: "High" },
                        value: "high",
                      },
                      {
                        text: { type: "plain_text", text: "Extra High" },
                        value: "xhigh",
                      },
                    ],
                  },
                },
              ],
            },
          });
        } else {
          // Show current config
          const settings = getChannelSettings(channelId);
          const overrides = settings.agentOverrides || {};
          const cwd = getChannelCwd(channelId, env.DEFAULT_CWD);

          await respond({
            response_type: "ephemeral",
            text: `*Channel Config:*
• Working Directory: \`${cwd}\`
• Agent: ${overrides.agent || "(default)"}
• Provider: ${overrides.provider || "(default)"}
• Model: ${overrides.model || "(default)"}
• Reasoning: ${overrides.reasoningEffort || "(default)"}

Use \`/ode config edit\` to modify.`,
          });
        }
        break;
      }

      case "gh": {
        const action = args[1]?.toLowerCase();
        if (action === "auth") {
          const { getGitHubAuth, getGitHubAuthForUser } = await import("../storage/settings");
          const existingAuth = getGitHubAuthForUser(command.user_id)
            ?? getGitHubAuth()
            ?? undefined;
          const host = existingAuth?.host || "github.com";
          const user = existingAuth?.user || "";

          await client.views.open({
            trigger_id: command.trigger_id,
            view: {
              type: "modal",
              callback_id: "gh_auth_modal",
              private_metadata: JSON.stringify({ channelId, userId: command.user_id, host }),
              title: { type: "plain_text", text: "GitHub Auth" },
              submit: { type: "plain_text", text: "Save" },
              close: { type: "plain_text", text: "Cancel" },
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "Enter a GitHub personal access token for Ode. Git operations use SSH.",
                  },
                },
                {
                  type: "input",
                  block_id: "gh_user",
                  optional: true,
                  label: { type: "plain_text", text: "GitHub Username" },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    initial_value: user,
                    placeholder: { type: "plain_text", text: "octocat" },
                  },
                },
                {
                  type: "input",
                  block_id: "gh_token",
                  label: { type: "plain_text", text: "Personal Access Token" },
                  element: {
                    type: "plain_text_input",
                    action_id: "value",
                    placeholder: { type: "plain_text", text: "ghp_... or github_pat_..." },
                  },
                },
                {
                  type: "context",
                  elements: [
                    {
                      type: "mrkdwn",
                      text: "_Required scopes: `repo`, plus `read:org` for org repos, and `workflow` if managing Actions. Ensure your SSH key is added to GitHub._",
                    },
                  ],
                },
              ],
            },
          });
        } else {
          await respond({
            response_type: "ephemeral",
            text: "Use `/ode gh auth` to authenticate GitHub CLI.",
          });
        }
        break;
      }

      case "auth":
      case "oauth": {
        // Start OAuth flow - will be handled in oauth.ts
        const { startOAuthFlow } = await import("./oauth");
        await startOAuthFlow(channelId, command.trigger_id, client);
        break;
      }

      case "callback": {
        // Callback is now handled automatically by the OAuth server
        const { isCodexAuthenticated } = await import("../agents/opencode/codex-auth");
        if (isCodexAuthenticated()) {
          await respond({
            response_type: "ephemeral",
            text: "Already authenticated with OpenAI Codex. Use `/ode config edit` to set provider to `openai` and model to `gpt-5.2-codex`.",
          });
        } else {
          await respond({
            response_type: "ephemeral",
            text: "OAuth callback is now handled automatically. After completing authorization in your browser, the credentials will be saved automatically.\n\nIf you haven't started OAuth yet, use `/ode oauth`.",
          });
        }
        break;
      }

      case "restart": {
        // Clear OAuth pending sessions
        const { pendingAuth } = await import("./oauth");
        pendingAuth.clear();

        // Abort any active sessions for this channel
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
          try {
            const restartMessage = await client.chat.postMessage({
              channel: target.channelId,
              text: "Restarting Ode...",
              ...(target.threadId ? { thread_ts: target.threadId } : {}),
            });
            if (restartMessage.ts) {
              addPendingRestartMessage(target.channelId, restartMessage.ts);
            }
          } catch {
            if (target.channelId === channelId && !target.threadId) {
              await respond({
                response_type: "in_channel",
                text: "Restarting Ode...",
              });
            }
          }
        }

        process.kill(process.pid, "SIGUSR2");
        break;
      }

      default: {
        await respond({
          response_type: "ephemeral",
          text: `Unknown command: ${subcommand}. Use \`/ode help\` for available commands.`,
        });
      }
    }
  });
}

export function setupInteractiveHandlers(): void {
  const slackApp = getApp();

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

    const cwd = values.cwd?.value?.value;
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

    updateChannelSettings(channelId, {
      agentOverrides,
      customCwd: cwd?.trim() || undefined,
    });

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
      text: "OAuth flow has been simplified. Please use `/ode auth` to start the OpenAI Codex authentication.",
    });
  });

  slackApp.view("oauth_callback_submit", async ({ ack, view, client }) => {
    await ack();
    const metadata = JSON.parse(view.private_metadata || "{}");
    const { channelId } = metadata;
    await client.chat.postMessage({
      channel: channelId,
      text: "OAuth callback is now handled via the modal. Please use `/ode auth` to start authentication.",
    });
  });

  // Handle user choice button clicks (from Ode ask_user actions)
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
