import { getApps } from "./client";
import {
  findMatchingModel,
  getProviderModelList,
  MODEL_DEFAULT_SENTINEL,
  MODEL_NONE_SENTINEL,
  resolveStoredModelForProvider,
  validateProviderModelSelection,
  type ProviderModelLists,
} from "@/shared/channel-settings";
import {
  AGENT_PROVIDERS,
  getAgentProviderLabel,
  normalizeAgentProviderId,
  providerSupportsModelSelection,
  type AgentProviderId,
} from "@/shared/agent-provider";
import {
  getChannelAgentProvider,
  getChannelModel,
  resolveChannelCwd,
  getEnabledAgentProviders,
  getOpenCodeModels,
  getCodexModels,
  getKiloModels,
  isAgentEnabled,
  getGitHubInfoForUser,
  setChannelAgentProvider,
  setChannelModel,
  setChannelWorkingDirectory,
  getChannelBaseBranch,
  setChannelBaseBranch,
  getChannelSystemMessage,
  setChannelSystemMessage,
  setGitHubInfoForUser,
  getUserGeneralSettings,
  setUserGeneralSettings,
  parseStatusMessageFrequencyValue,
  parseStatusMessageFrequencyMs,
  STATUS_MESSAGE_FREQUENCY_OPTIONS,
  STATUS_MESSAGE_FORMAT_OPTIONS,
  GIT_STRATEGY_OPTIONS,
  AUTO_UPDATE_OPTIONS,
  normalizeAutoUpdateSetting,
  normalizeStatusMessageFormat,
  normalizeGitStrategy,
  type AutoUpdateSetting,
  type StatusMessageFrequencyMs,
  type StatusMessageFormat,
  type GitStrategy,
} from "@/config";
import { refreshSettingsProviderData } from "@/ims/shared/settings-provider-data";
import {
  CRON_RUN_NOW_ACTION,
  CRON_VIEW_DETAILS_ACTION,
  buildCronJobDetailBlocks,
  getCronJobForChannel,
} from "./cron";
import {
  CronJobAlreadyRunningError,
  CronJobNotFoundError,
  beginTriggerCronJobNow,
} from "@/core/cron/scheduler";

const SETTINGS_LAUNCH_ACTION = "open_settings_modal";
const SETTINGS_MODAL_ID = "settings_modal";
const GENERAL_SETTINGS_LAUNCH_ACTION = "open_general_settings_modal";
const GENERAL_SETTINGS_MODAL_ID = "general_settings_modal";
const GITHUB_LAUNCH_ACTION = "open_github_token_modal";
const GITHUB_MODAL_ID = "github_token_modal";
const GITHUB_TOKEN_BLOCK = "github_token";
const GITHUB_TOKEN_ACTION = "github_token_input";
const GITHUB_NAME_BLOCK = "github_name";
const GITHUB_NAME_ACTION = "github_name_input";
const GITHUB_EMAIL_BLOCK = "github_email";
const GITHUB_EMAIL_ACTION = "github_email_input";
const PROVIDER_BLOCK = "provider";
const PROVIDER_ACTION = "provider_select";
const MODEL_BLOCK = "model";
const MODEL_ACTION = "model_select";
const WORKING_DIR_BLOCK = "working_dir";
const WORKING_DIR_ACTION = "working_dir_input";
const BASE_BRANCH_BLOCK = "base_branch";
const BASE_BRANCH_ACTION = "base_branch_input";
const CHANNEL_SYSTEM_MESSAGE_BLOCK = "channel_system_message";
const CHANNEL_SYSTEM_MESSAGE_ACTION = "channel_system_message_input";
const GENERAL_STATUS_MESSAGE_FORMAT_BLOCK = "general_status_message_format";
const GENERAL_STATUS_MESSAGE_FORMAT_ACTION = "general_status_message_format_select";
const GENERAL_STATUS_MESSAGE_FREQUENCY_BLOCK = "general_status_message_frequency";
const GENERAL_STATUS_MESSAGE_FREQUENCY_ACTION = "general_status_message_frequency_select";
const GENERAL_GIT_STRATEGY_BLOCK = "general_git_strategy";
const GENERAL_GIT_STRATEGY_ACTION = "general_git_strategy_select";
const GENERAL_AUTO_UPDATE_BLOCK = "general_auto_update";
const GENERAL_AUTO_UPDATE_ACTION = "general_auto_update_select";

type AgentProvider = AgentProviderId;

type SlackActionBody = {
  actions?: Array<{
    value?: string;
    selected_option?: {
      value?: string;
    };
  }>;
  channel?: {
    id?: string;
  };
  user?: {
    id?: string;
  };
  trigger_id?: string;
  view?: {
    private_metadata?: string;
    id?: string;
    hash?: string;
    state?: {
      values?: Record<string, Record<string, { value?: string; selected_option?: { value?: string } }>>;
    };
  };
  message?: {
    thread_ts?: string;
    ts?: string;
    text?: string;
  };
};

function parseAgentProvider(value: unknown): AgentProvider {
  return normalizeAgentProviderId(value);
}

function getSelectableProviders(): AgentProvider[] {
  const enabled = getEnabledAgentProviders().filter(
    (provider): provider is AgentProvider => AGENT_PROVIDERS.includes(provider as AgentProvider)
  );
  if (enabled.length > 0) return enabled;
  return Array.from(AGENT_PROVIDERS);
}

function toSelectableProvider(provider: AgentProviderId): AgentProvider {
  return parseAgentProvider(provider);
}

function getProviderModelLists(): ProviderModelLists {
  return {
    opencode: getOpenCodeModels(),
    codex: getCodexModels(),
    kilo: getKiloModels(),
  };
}

function getActionChannelId(body: SlackActionBody): string | undefined {
  return body.actions?.[0]?.value ?? body.channel?.id;
}

function getActionUserId(body: SlackActionBody): string | undefined {
  return body.user?.id;
}

function getActionTriggerId(body: SlackActionBody): string | undefined {
  return body.trigger_id;
}

function getActionSelectedOptionValue(body: SlackActionBody): string | undefined {
  return body.actions?.[0]?.selected_option?.value;
}

function getActionViewMetadata(body: SlackActionBody): string | undefined {
  return body.view?.private_metadata;
}

function getActionThreadTs(body: SlackActionBody): string | undefined {
  return body.message?.thread_ts || body.message?.ts;
}

function getActionMessageTs(body: SlackActionBody): string | undefined {
  return body.message?.ts;
}

function getActionMessageText(body: SlackActionBody): string {
  return body.message?.text || "Question";
}

function buildSettingsModal(params: {
  channelId: string;
  enabledProviders: AgentProvider[];
  opencodeModels: string[];
  codexModels: string[];
  kiloModels: string[];
  selectedProvider?: AgentProvider;
  selectedModel?: string | null;
  workingDirectory?: string | null;
  baseBranch?: string | null;
  channelSystemMessage?: string | null;
}) {
  const {
    channelId,
    enabledProviders,
    opencodeModels,
    codexModels,
    kiloModels,
    selectedProvider = "opencode",
    selectedModel,
    workingDirectory,
    baseBranch,
    channelSystemMessage,
  } = params;
  const providerOptions = enabledProviders.map((provider) => ({
    text: { type: "plain_text" as const, text: getAgentProviderLabel(provider) },
    value: provider,
  }));
  const providerModels = providerSupportsModelSelection(selectedProvider)
    ? getProviderModelList(selectedProvider, {
      opencode: opencodeModels,
      codex: codexModels,
      kilo: kiloModels,
    })
    : null;
  const modelOptions = providerModels && selectedProvider === "opencode"
    ? (opencodeModels.length > 0
      ? opencodeModels.map((model) => ({
          text: { type: "plain_text" as const, text: model },
          value: model,
        }))
      : [{ text: { type: "plain_text" as const, text: "No models configured" }, value: MODEL_NONE_SENTINEL }])
    : providerModels && selectedProvider === "codex"
      ? [
          { text: { type: "plain_text" as const, text: "Use default (gpt-5.3-codex)" }, value: MODEL_DEFAULT_SENTINEL },
          ...codexModels.map((model) => ({
            text: { type: "plain_text" as const, text: model },
            value: model,
          })),
        ]
      : providerModels && selectedProvider === "kilo"
        ? (kiloModels.length > 0
          ? kiloModels.map((model) => ({
              text: { type: "plain_text" as const, text: model },
              value: model,
            }))
          : [{ text: { type: "plain_text" as const, text: "No models configured" }, value: MODEL_NONE_SENTINEL }])
      : [];

  const availableModels = selectedProvider === "codex"
    ? modelOptions.map((entry) => entry.value)
    : providerModels ?? [];
  const matchedSelectedModel = findMatchingModel(availableModels, selectedModel);
  const initialModel = matchedSelectedModel
    ? matchedSelectedModel
    : (selectedProvider === "codex"
      ? MODEL_DEFAULT_SENTINEL
      : selectedProvider === "kilo"
        ? (kiloModels[0] ?? MODEL_NONE_SENTINEL)
        : (opencodeModels[0] ?? MODEL_NONE_SENTINEL));
  const introText = selectedProvider === "opencode"
    ? "Configure agent, model (OpenCode), working directory, and base branch for this channel."
    : selectedProvider === "codex"
      ? "Configure agent, optional Codex model, working directory, and base branch for this channel."
      : selectedProvider === "kilo"
        ? "Configure agent, model (Kilo), working directory, and base branch for this channel."
      : "Configure agent, working directory, and base branch for this channel.";

  const blocks: any[] = [
    {
      type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: introText,
        },
      },
    {
      type: "input" as const,
      block_id: PROVIDER_BLOCK,
      dispatch_action: true,
      label: { type: "plain_text" as const, text: "Provider" },
      element: {
        type: "static_select" as const,
        action_id: PROVIDER_ACTION,
        options: providerOptions,
        initial_option: providerOptions.find((option) => option.value === selectedProvider) ?? providerOptions[0],
      },
    },
  ];

  if (providerModels) {
    const initialOption = modelOptions.find((option) => option.value === initialModel);
    blocks.push(
      {
        type: "input" as const,
        block_id: MODEL_BLOCK,
        optional: selectedProvider === "codex",
        label: { type: "plain_text" as const, text: "Model" },
        element: {
          type: "static_select" as const,
          action_id: MODEL_ACTION,
          options: modelOptions,
          initial_option: initialOption,
        },
      },
    );
  }

  blocks.push({
    type: "input" as const,
    block_id: WORKING_DIR_BLOCK,
    label: { type: "plain_text" as const, text: "Working Directory" },
    element: {
      type: "plain_text_input" as const,
      action_id: WORKING_DIR_ACTION,
      initial_value: workingDirectory ?? "",
      placeholder: { type: "plain_text" as const, text: "e.g., ~/Code/ode" },
    },
  });

  blocks.push({
    type: "input" as const,
    block_id: BASE_BRANCH_BLOCK,
    optional: true,
    label: { type: "plain_text" as const, text: "Base Branch" },
    element: {
      type: "plain_text_input" as const,
      action_id: BASE_BRANCH_ACTION,
      initial_value: baseBranch?.trim() || "main",
      placeholder: { type: "plain_text" as const, text: "e.g., main" },
    },
  });

  blocks.push({
    type: "input" as const,
    block_id: CHANNEL_SYSTEM_MESSAGE_BLOCK,
    optional: true,
    label: { type: "plain_text" as const, text: "Channel System Message (optional)" },
    element: {
      type: "plain_text_input" as const,
      action_id: CHANNEL_SYSTEM_MESSAGE_ACTION,
      multiline: true,
      initial_value: channelSystemMessage ?? "",
      placeholder: { type: "plain_text" as const, text: "Instructions appended to the system prompt for this channel" },
    },
  });

  return {
    type: "modal" as const,
    callback_id: SETTINGS_MODAL_ID,
    private_metadata: channelId,
    title: { type: "plain_text" as const, text: "Channel Settings" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks,
  };
}

function buildGitHubTokenModal(params: {
  channelId: string;
  hasToken: boolean;
  token?: string;
  gitName?: string;
  gitEmail?: string;
}) {
  const { channelId, hasToken, token, gitName, gitEmail } = params;
  const statusText = hasToken
    ? "A GitHub token is already set for your account. Update it if needed; git name/email are used for commits."
    : "GitHub token is optional and only needed for GitHub CLI actions. Git name/email are used for commits.";

  return {
    type: "modal" as const,
    callback_id: GITHUB_MODAL_ID,
    private_metadata: channelId,
    title: { type: "plain_text" as const, text: "GitHub Token" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: { type: "mrkdwn" as const, text: statusText },
      },
      {
        type: "input" as const,
        block_id: GITHUB_TOKEN_BLOCK,
        label: { type: "plain_text" as const, text: "GitHub Token" },
        optional: true,
        element: {
          type: "plain_text_input" as const,
          action_id: GITHUB_TOKEN_ACTION,
          initial_value: token ?? "",
          placeholder: { type: "plain_text" as const, text: "ghp_..." },
        },
      },
      {
        type: "input" as const,
        block_id: GITHUB_NAME_BLOCK,
        label: { type: "plain_text" as const, text: "Git Name" },
        element: {
          type: "plain_text_input" as const,
          action_id: GITHUB_NAME_ACTION,
          initial_value: gitName ?? "",
          placeholder: { type: "plain_text" as const, text: "Jane Doe" },
        },
      },
      {
        type: "input" as const,
        block_id: GITHUB_EMAIL_BLOCK,
        label: { type: "plain_text" as const, text: "Git Email" },
        element: {
          type: "plain_text_input" as const,
          action_id: GITHUB_EMAIL_ACTION,
          initial_value: gitEmail ?? "",
          placeholder: { type: "plain_text" as const, text: "jane@example.com" },
        },
      },
    ],
  };
}

function buildGeneralSettingsModal(params: {
  channelId: string;
  statusMessageFormat: StatusMessageFormat;
  statusMessageFrequencyMs: StatusMessageFrequencyMs;
  gitStrategy: GitStrategy;
  autoUpdate: boolean;
}) {
  const {
    channelId,
    statusMessageFormat,
    statusMessageFrequencyMs,
    gitStrategy,
    autoUpdate,
  } = params;
  const statusMessageFormatOptions = STATUS_MESSAGE_FORMAT_OPTIONS.map((option) => ({
    text: { type: "plain_text" as const, text: option.label },
    value: option.value,
  }));
  const statusMessageFrequencyOptions = STATUS_MESSAGE_FREQUENCY_OPTIONS.map((option) => ({
    text: { type: "plain_text" as const, text: option.label },
    value: option.value,
  }));
  const gitStrategyOptions = GIT_STRATEGY_OPTIONS.map((option) => ({
    text: { type: "plain_text" as const, text: option.label },
    value: option.value,
  }));
  const autoUpdateOptions = AUTO_UPDATE_OPTIONS.map((option) => ({
    text: { type: "plain_text" as const, text: option.label },
    value: option.value,
  }));

  return {
    type: "modal" as const,
    callback_id: GENERAL_SETTINGS_MODAL_ID,
    private_metadata: channelId,
    title: { type: "plain_text" as const, text: "General Settings" },
    submit: { type: "plain_text" as const, text: "Save" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks: [
      {
        type: "section" as const,
        text: {
          type: "mrkdwn" as const,
          text: "Configure status updates, git strategy, and auto update.",
        },
      },
      {
        type: "input" as const,
        block_id: GENERAL_STATUS_MESSAGE_FORMAT_BLOCK,
        label: { type: "plain_text" as const, text: "Status Message Format" },
        element: {
          type: "static_select" as const,
          action_id: GENERAL_STATUS_MESSAGE_FORMAT_ACTION,
          options: statusMessageFormatOptions,
          initial_option:
            statusMessageFormatOptions.find((option) => option.value === statusMessageFormat)
            ?? statusMessageFormatOptions[1],
        },
      },
      {
        type: "input" as const,
        block_id: GENERAL_STATUS_MESSAGE_FREQUENCY_BLOCK,
        label: { type: "plain_text" as const, text: "Status Message Frequency" },
        element: {
          type: "static_select" as const,
          action_id: GENERAL_STATUS_MESSAGE_FREQUENCY_ACTION,
          options: statusMessageFrequencyOptions,
          initial_option:
            statusMessageFrequencyOptions.find((option) => option.value === String(statusMessageFrequencyMs))
            ?? statusMessageFrequencyOptions[0],
        },
      },
      {
        type: "input" as const,
        block_id: GENERAL_GIT_STRATEGY_BLOCK,
        label: { type: "plain_text" as const, text: "Git Strategy" },
        element: {
          type: "static_select" as const,
          action_id: GENERAL_GIT_STRATEGY_ACTION,
          options: gitStrategyOptions,
          initial_option:
            gitStrategyOptions.find((option) => option.value === gitStrategy)
            ?? gitStrategyOptions[0],
        },
      },
      {
        type: "input" as const,
        block_id: GENERAL_AUTO_UPDATE_BLOCK,
        label: { type: "plain_text" as const, text: "Auto Update" },
        element: {
          type: "static_select" as const,
          action_id: GENERAL_AUTO_UPDATE_ACTION,
          options: autoUpdateOptions,
          initial_option:
            autoUpdateOptions.find((option) => option.value === (autoUpdate ? "on" : "off"))
            ?? autoUpdateOptions[0],
        },
      },
    ],
  };
}

export function setupInteractiveHandlers(): void {
  for (const slackApp of getApps()) {
    slackApp.action(SETTINGS_LAUNCH_ACTION, async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as SlackActionBody;

    const channelId = getActionChannelId(actionBody);
    const triggerId = getActionTriggerId(actionBody);
    if (!channelId || !triggerId) return;

    const refreshedData = await refreshSettingsProviderData(toSelectableProvider(getChannelAgentProvider(channelId)));

    const view = buildSettingsModal({
      channelId,
      enabledProviders: refreshedData.enabledProviders,
      opencodeModels: refreshedData.opencodeModels,
      codexModels: refreshedData.codexModels,
      kiloModels: refreshedData.kiloModels,
      selectedProvider: toSelectableProvider(getChannelAgentProvider(channelId)),
      selectedModel: getChannelModel(channelId),
      workingDirectory: resolveChannelCwd(channelId).workingDirectory,
      baseBranch: getChannelBaseBranch(channelId),
      channelSystemMessage: getChannelSystemMessage(channelId),
    });

    await client.views.open({
      trigger_id: triggerId,
      view,
    });
    });

    slackApp.action(GITHUB_LAUNCH_ACTION, async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as SlackActionBody;

    const channelId = getActionChannelId(actionBody);
    const userId = getActionUserId(actionBody);
    const triggerId = getActionTriggerId(actionBody);
    if (!channelId || !userId || !triggerId) return;

    const info = getGitHubInfoForUser(userId);
    const view = buildGitHubTokenModal({
      channelId,
      hasToken: Boolean(info?.token),
      token: info?.token,
      gitName: info?.gitName,
      gitEmail: info?.gitEmail,
    });

    await client.views.open({
      trigger_id: triggerId,
      view,
    });
    });

    slackApp.action(GENERAL_SETTINGS_LAUNCH_ACTION, async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as SlackActionBody;
    const triggerId = getActionTriggerId(actionBody);
    if (!triggerId) return;

    const channelId = getActionChannelId(actionBody)
      ?? "";
    const generalSettings = getUserGeneralSettings();
    const view = buildGeneralSettingsModal({
      channelId,
      statusMessageFormat: generalSettings.defaultStatusMessageFormat,
      statusMessageFrequencyMs: generalSettings.statusMessageFrequencyMs,
      gitStrategy: generalSettings.gitStrategy,
      autoUpdate: generalSettings.autoUpdate,
    });

    await client.views.open({
      trigger_id: triggerId,
      view,
    });
    });

    slackApp.action(PROVIDER_ACTION, async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as SlackActionBody;

    const view = actionBody.view;
    if (!view || !view.id || !view.hash) return;

    const channelId = view.private_metadata;
    if (!channelId) return;
    const selectedOption = getActionSelectedOptionValue(actionBody);
    const selectedProvider = parseAgentProvider(selectedOption);
    const refreshedData = await refreshSettingsProviderData(selectedProvider);
    const selectedModel = view.state?.values?.[MODEL_BLOCK]?.[MODEL_ACTION]?.selected_option?.value
      || getChannelModel(channelId)
      || undefined;
    const workingDirectory = view.state?.values?.[WORKING_DIR_BLOCK]?.[WORKING_DIR_ACTION]?.value || "";
    const baseBranch = view.state?.values?.[BASE_BRANCH_BLOCK]?.[BASE_BRANCH_ACTION]?.value
      || getChannelBaseBranch(channelId)
      || "main";
    const channelSystemMessage = view.state?.values?.[CHANNEL_SYSTEM_MESSAGE_BLOCK]?.[CHANNEL_SYSTEM_MESSAGE_ACTION]?.value
      || getChannelSystemMessage(channelId)
      || "";

    const updatedView = buildSettingsModal({
      channelId,
      enabledProviders: refreshedData.enabledProviders,
      opencodeModels: refreshedData.opencodeModels,
      codexModels: refreshedData.codexModels,
      kiloModels: refreshedData.kiloModels,
      selectedProvider,
      selectedModel,
      workingDirectory,
      baseBranch,
      channelSystemMessage,
    });

    await client.views.update({
      view_id: view.id,
      hash: view.hash,
      view: updatedView,
    });
    });

    slackApp.view(SETTINGS_MODAL_ID, async ({ ack, view, body, client }) => {
    const channelId = view.private_metadata;
    const values = view.state.values;
    const selectedProvider = parseAgentProvider(
      values?.[PROVIDER_BLOCK]?.[PROVIDER_ACTION]?.selected_option?.value
    );
    const selectedModel = values?.[MODEL_BLOCK]?.[MODEL_ACTION]?.selected_option?.value;
    const workingDirectory = values?.[WORKING_DIR_BLOCK]?.[WORKING_DIR_ACTION]?.value || "";
    const baseBranch = values?.[BASE_BRANCH_BLOCK]?.[BASE_BRANCH_ACTION]?.value || "main";
    const channelSystemMessage = values?.[CHANNEL_SYSTEM_MESSAGE_BLOCK]?.[CHANNEL_SYSTEM_MESSAGE_ACTION]?.value || "";

    const errors: Record<string, string> = {};
    if (!isAgentEnabled(selectedProvider)) {
      errors[PROVIDER_BLOCK] = "Selected agent is disabled.";
    }

    if (selectedProvider === "opencode") {
      if (!selectedModel || selectedModel === MODEL_NONE_SENTINEL) {
        errors[MODEL_BLOCK] = "Select a model.";
      }

      if (!validateProviderModelSelection({
        provider: "opencode",
        selectedModel,
        lists: getProviderModelLists(),
      })) {
        errors[MODEL_BLOCK] = "Model not available in ~/.config/ode/ode.json agents.opencode.models.";
      }
    } else if (selectedProvider === "codex") {
      if (!validateProviderModelSelection({
        provider: "codex",
        selectedModel,
        lists: getProviderModelLists(),
      })) {
        errors[MODEL_BLOCK] = "Model not available in local Codex model list.";
      }
    } else if (selectedProvider === "kilo") {
      if (!selectedModel || selectedModel === MODEL_NONE_SENTINEL) {
        errors[MODEL_BLOCK] = "Select a model.";
      }
      if (!validateProviderModelSelection({
        provider: "kilo",
        selectedModel,
        lists: getProviderModelLists(),
      })) {
        errors[MODEL_BLOCK] = "Model not available in local Kilo model list.";
      }
    }

    if (!workingDirectory.trim()) {
      errors[WORKING_DIR_BLOCK] = "Enter a working directory.";
    }

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    try {
      setChannelAgentProvider(channelId, selectedProvider);
      setChannelModel(channelId, resolveStoredModelForProvider({
        provider: selectedProvider,
        selectedModel,
        lists: getProviderModelLists(),
      }));

      const workingDirValue = workingDirectory.trim();
      setChannelWorkingDirectory(channelId, workingDirValue.length > 0 ? workingDirValue : null);
      setChannelBaseBranch(channelId, baseBranch);
      setChannelSystemMessage(channelId, channelSystemMessage);
    } catch (err) {
      const actionBody = body as SlackActionBody;
      const userId = getActionUserId(actionBody);
      if (userId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    const actionBody = body as SlackActionBody;
    const userId = getActionUserId(actionBody);
    if (userId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "Channel settings updated.",
      });
    }
    });

    slackApp.view(GITHUB_MODAL_ID, async ({ ack, view, body, client }) => {
    const values = view.state.values;
    const token = values?.[GITHUB_TOKEN_BLOCK]?.[GITHUB_TOKEN_ACTION]?.value || "";
    const gitName = values?.[GITHUB_NAME_BLOCK]?.[GITHUB_NAME_ACTION]?.value || "";
    const gitEmail = values?.[GITHUB_EMAIL_BLOCK]?.[GITHUB_EMAIL_ACTION]?.value || "";
    const trimmed = token.trim();

    await ack();

    const actionBody = body as SlackActionBody;

    const userId = getActionUserId(actionBody);
    const channelId = getActionViewMetadata(actionBody)
      ?? actionBody.channel?.id;
    if (!userId || !channelId) return;

    try {
      setGitHubInfoForUser(userId, {
        token: trimmed,
        gitName,
        gitEmail,
      });
    } catch (err) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Failed to save GitHub info: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: "GitHub info updated.",
    });
    });

    slackApp.view(GENERAL_SETTINGS_MODAL_ID, async ({ ack, view, body, client }) => {
    const values = view.state.values;
    const selectedStatusMessageFormat = values?.[GENERAL_STATUS_MESSAGE_FORMAT_BLOCK]?.[GENERAL_STATUS_MESSAGE_FORMAT_ACTION]?.selected_option?.value;
    const selectedStatusMessageFrequency = values?.[GENERAL_STATUS_MESSAGE_FREQUENCY_BLOCK]?.[GENERAL_STATUS_MESSAGE_FREQUENCY_ACTION]?.selected_option?.value;
    const selectedGitStrategy = values?.[GENERAL_GIT_STRATEGY_BLOCK]?.[GENERAL_GIT_STRATEGY_ACTION]?.selected_option?.value;
    const selectedAutoUpdate = values?.[GENERAL_AUTO_UPDATE_BLOCK]?.[GENERAL_AUTO_UPDATE_ACTION]?.selected_option?.value;

    const statusMessageFormat: StatusMessageFormat = normalizeStatusMessageFormat(selectedStatusMessageFormat);
    const gitStrategy: GitStrategy = normalizeGitStrategy(selectedGitStrategy);
    const parsedStatusMessageFrequency = selectedStatusMessageFrequency
      ? parseStatusMessageFrequencyValue(selectedStatusMessageFrequency)
      : null;
    const statusMessageFrequencyMs: StatusMessageFrequencyMs = parseStatusMessageFrequencyMs(
      parsedStatusMessageFrequency ? Number(parsedStatusMessageFrequency) : undefined
    );
    const autoUpdateSetting: AutoUpdateSetting = normalizeAutoUpdateSetting(selectedAutoUpdate);
    const autoUpdate = autoUpdateSetting !== "off";

    await ack();

    try {
      setUserGeneralSettings({
        defaultStatusMessageFormat: statusMessageFormat,
        gitStrategy,
        statusMessageFrequencyMs,
        autoUpdate,
      });
    } catch (err) {
      const actionBody = body as SlackActionBody;
      const userId = getActionUserId(actionBody);
      const channelId = view.private_metadata || actionBody.channel?.id;
      if (userId && channelId) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to update general settings: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      return;
    }

    const actionBody = body as SlackActionBody;
    const userId = getActionUserId(actionBody);
    const channelId = view.private_metadata || actionBody.channel?.id;
    if (userId && channelId) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: "General settings updated.",
      });
    }
    });

  // Handle user choice button clicks (from Ode ask_user actions)
    slackApp.action(/^user_choice_\d+$/, async ({ ack, body, client }) => {
    await ack();

    const actionBody = body as SlackActionBody;

    const action = actionBody.actions?.[0];
    const value = action?.value;
    const channel = actionBody.channel?.id;
    const threadTs = getActionThreadTs(actionBody);
    const userId = getActionUserId(actionBody);
    const messageTs = getActionMessageTs(actionBody);

    if (!value || !channel || !threadTs) return;

    // Update the original message to remove buttons (keep question text only)
    if (messageTs) {
      const originalText = getActionMessageText(actionBody);
      await client.chat.update({
        channel,
        ts: messageTs,
        text: originalText,
        blocks: [],
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
      await handleButtonSelection(channel, threadTs, userId || "unknown", value, selectionMsg.ts);
    }
    });

    slackApp.action(CRON_VIEW_DETAILS_ACTION, async ({ ack, body, client }) => {
      await ack();
      const actionBody = body as SlackActionBody;
      const jobId = actionBody.actions?.[0]?.value;
      const channelId = actionBody.channel?.id;
      const userId = getActionUserId(actionBody);
      if (!jobId || !channelId || !userId) return;

      const job = getCronJobForChannel(channelId, jobId);
      if (!job) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Cron job \`${jobId}\` not found in this channel.`,
        });
        return;
      }

      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Cron job: ${job.title}`,
        blocks: buildCronJobDetailBlocks(job),
      });
    });

    slackApp.action(CRON_RUN_NOW_ACTION, async ({ ack, body, client }) => {
      await ack();
      const actionBody = body as SlackActionBody;
      const jobId = actionBody.actions?.[0]?.value;
      const channelId = actionBody.channel?.id;
      const userId = getActionUserId(actionBody);
      if (!jobId || !channelId || !userId) return;

      const job = getCronJobForChannel(channelId, jobId);
      if (!job) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Cron job \`${jobId}\` not found in this channel.`,
        });
        return;
      }

      try {
        const runPromise = beginTriggerCronJobNow(job.id);
        runPromise.catch((error) => {
          console.warn("Manually triggered cron job run failed", {
            cronJobId: job.id,
            error: String(error),
          });
        });
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `▶️ Triggered cron job *${job.title}* (\`${job.id}\`). It will run in the background.`,
        });
      } catch (error) {
        if (error instanceof CronJobAlreadyRunningError) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `⏳ Cron job *${job.title}* is already running.`,
          });
          return;
        }
        if (error instanceof CronJobNotFoundError) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Cron job \`${job.id}\` was not found.`,
          });
          return;
        }
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `Failed to trigger cron job: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }
}
