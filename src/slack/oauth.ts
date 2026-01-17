import { type WebClient } from "@slack/web-api";
import { log } from "../logger";
import {
  initiateCodexAuth,
  isCodexAuthenticated,
  completeCodexAuthManual,
  stopCodexOAuthServer,
} from "../agents/opencode/codex-auth";

export async function startOAuthFlow(
  channelId: string,
  triggerId: string,
  client: WebClient
): Promise<void> {
  log.info("Starting OAuth flow", { channelId });

  // Check if already authenticated
  if (isCodexAuthenticated()) {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Already Authenticated" },
        close: { type: "plain_text", text: "Close" },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "You're already authenticated with OpenAI Codex. Use @ode /start to open setup and select the openai provider and gpt-5.2-codex model.",
            },
          },
        ],
      },
    });
    return;
  }

  // Initiate OAuth directly (OpenAI only)
  try {
    const authResult = await initiateCodexAuth(channelId);

    // Show the OAuth URL modal with callback input
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        callback_id: "codex_oauth_callback",
        private_metadata: JSON.stringify({ channelId, state: authResult.state }),
        title: { type: "plain_text", text: "OpenAI Codex Login" },
        submit: { type: "plain_text", text: "Submit" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Step 1:* Open this URL in your browser and sign in with your ChatGPT Pro/Plus account:",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `\`\`\`${authResult.url}\`\`\``,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "_Copy the URL above and paste it into your browser_",
              },
            ],
          },
          {
            type: "divider",
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Step 2:* After authorizing, copy the callback URL from your browser (starts with `http://localhost:1455/auth/callback?...`) and paste it below:",
            },
          },
          {
            type: "input",
            block_id: "callback_url",
            label: { type: "plain_text", text: "Callback URL" },
            element: {
              type: "plain_text_input",
              action_id: "value",
              placeholder: {
                type: "plain_text",
                text: "http://localhost:1455/auth/callback?code=...",
              },
            },
          },
        ],
      },
    });

    log.info("OAuth modal shown", { channelId });
  } catch (err) {
    log.error("Failed to initiate OAuth", { error: String(err) });
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Error" },
        close: { type: "plain_text", text: "Close" },
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Failed to start OAuth:\n\`${err instanceof Error ? err.message : "Unknown error"}\``,
            },
          },
        ],
      },
    });
  }
}

export async function handleCodexOAuthCallback(
  callbackUrl: string,
  channelId: string,
  client: WebClient
): Promise<void> {
  log.info("Processing OAuth callback", { channelId, urlLength: callbackUrl.length });

  try {
    await completeCodexAuthManual(callbackUrl);

    await client.chat.postMessage({
      channel: channelId,
      text: "Successfully authenticated with OpenAI Codex! Use @ode /start to open setup and set provider to openai and model to gpt-5.2-codex.",
    });
  } catch (err) {
    log.error("OAuth callback failed", { error: String(err) });
    await client.chat.postMessage({
      channel: channelId,
      text: `OAuth failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  }
}

// Legacy exports for compatibility (simplified)
export async function initiateOAuth(
  _providerID: string,
  channelId: string,
  triggerId: string,
  client: WebClient
): Promise<void> {
  // Always use OpenAI Codex
  await startOAuthFlow(channelId, triggerId, client);
}

export async function completeOAuth(
  _providerID: string,
  _methodIndex: number,
  _callbackInput: string,
  channelId: string,
  client: WebClient
): Promise<void> {
  // OAuth callback is now handled automatically by the server
  if (isCodexAuthenticated()) {
    await client.chat.postMessage({
      channel: channelId,
      text: "Successfully authenticated with OpenAI Codex! Use @ode /start to open setup and set provider to openai and model to gpt-5.2-codex.",
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      text: "OAuth not complete yet. Please complete the authorization in your browser.",
    });
  }
}

export async function processOAuthCallback(
  _code: string,
  channelId: string,
  client: WebClient
): Promise<void> {
  // Check if authenticated
  if (isCodexAuthenticated()) {
    await client.chat.postMessage({
      channel: channelId,
      text: "Successfully authenticated with OpenAI Codex!",
    });
  } else if (pendingAuth.get(channelId)) {
    await client.chat.postMessage({
      channel: channelId,
      text: "OAuth in progress. Please complete the authorization in your browser.",
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      text: "No pending OAuth flow. Use @ode /start to open setup and start OAuth again.",
    });
  }
}

export function stopOAuthServer(): void {
  stopCodexOAuthServer();
}

// Pending auth is now handled internally
export const pendingAuth = {
  get: (_channelId: string) => undefined,
  set: (_channelId: string, _data: unknown) => {},
  delete: (_channelId: string) => {},
  clear: () => {},
};
