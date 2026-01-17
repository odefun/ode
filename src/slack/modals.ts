import { App } from "@slack/bolt";
import {
  getChannelAgentsMd,
  getChannelAgentInstructions,
  getChannelSettings,
  getGitHubAuth,
  getGitHubAuthForUser,
} from "../storage/settings";

export async function openAgentsModal(
  client: App["client"],
  trigger_id: string,
  channelId: string
) {
  const currentContent = getChannelAgentsMd(channelId) || "";
  const planContent = getChannelAgentInstructions(channelId, "plan") || "";
  const buildContent = getChannelAgentInstructions(channelId, "build") || "";

  await client.views.open({
    trigger_id,
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
}

export async function openConfigModal(
  client: App["client"],
  trigger_id: string,
  channelId: string
) {
  const settings = getChannelSettings(channelId);
  const overrides = settings.agentOverrides || {};

  await client.views.open({
    trigger_id,
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
}

export async function openGhAuthModal(
  client: App["client"],
  trigger_id: string,
  channelId: string,
  userId: string
) {
  const existingAuth = getGitHubAuthForUser(userId)
    ?? getGitHubAuth()
    ?? undefined;
  const host = existingAuth?.host || "github.com";
  const user = existingAuth?.user || "";

  await client.views.open({
    trigger_id,
    view: {
      type: "modal",
      callback_id: "gh_auth_modal",
      private_metadata: JSON.stringify({ channelId, userId, host }),
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
}
