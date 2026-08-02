import {
  readDashboardConfig,
  updateDashboardConfig,
} from "@/config";
import {
  createWorkspaceCredentialId,
  normalizeChannelAgentProvider,
  resolveFallbackModel,
  type WorkspaceConfig,
} from "./shared";

type SlackChannel = {
  id: string;
  name: string;
  is_member?: boolean;
};

type SlackTeam = {
  id?: string;
  name?: string;
  domain?: string;
};

const slackRequest = async <T>(token: string, path: string, params?: URLSearchParams) => {
  const url = new URL(`https://slack.com/api/${path}`);
  if (params) {
    url.search = params.toString();
  }
  const response = await fetch(url.toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  const data = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!data.ok) {
    throw new Error(data.error ?? "Slack API error");
  }
  return data;
};

const fetchSlackChannels = async (token: string): Promise<SlackChannel[]> => {
  const channels: SlackChannel[] = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({
      limit: "200",
      types: "public_channel,private_channel",
      exclude_archived: "true",
    });
    if (cursor) params.set("cursor", cursor);
    const data = await slackRequest<{
      channels: SlackChannel[];
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.list", params);
    const joinedChannels = (data.channels ?? []).filter((channel) => channel.is_member === true);
    channels.push(...joinedChannels);
    cursor = data.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return channels;
};

const formatSlackDomain = (domain?: string): string => (domain ? `${domain}.slack.com` : "");

const fetchSlackWorkspaceSnapshot = async (botToken: string): Promise<{ team: SlackTeam; channels: SlackChannel[] }> => {
  const teamInfo = await slackRequest<{ team: SlackTeam }>(botToken, "team.info");
  const channels = await fetchSlackChannels(botToken);
  return { team: teamInfo.team ?? {}, channels };
};

const buildDiscoveredChannelDetails = (
  channels: SlackChannel[],
  fallbackModel: string
): WorkspaceConfig["channelDetails"] =>
  channels.map((channel) => ({
    id: channel.id,
    name: channel.name ? `#${channel.name}` : "",
    agentProvider: "opencode",
    model: fallbackModel,
    workingDirectory: "",
    baseBranch: "main",
    channelSystemMessage: "",
  }));

const buildSyncedChannelDetails = (
  channels: SlackChannel[],
  workspace: WorkspaceConfig,
  fallbackModel: string
): WorkspaceConfig["channelDetails"] =>
  channels.map((channel) => {
    const existing = workspace.channelDetails.find((item) => item.id === channel.id);
    const agentProvider = normalizeChannelAgentProvider(existing?.agentProvider);
    return {
      id: channel.id,
      name: channel.name ? `#${channel.name}` : "",
      agentProvider,
      model: existing?.model ?? resolveFallbackModel(agentProvider, fallbackModel),
      workingDirectory: existing?.workingDirectory ?? "",
      baseBranch: existing?.baseBranch?.trim() ? existing.baseBranch.trim() : "main",
      channelSystemMessage: existing?.channelSystemMessage ?? "",
    };
  });

export const discoverSlackWorkspace = async (
  slackAppToken: string,
  slackBotToken: string
): Promise<WorkspaceConfig> => {
  const appToken = slackAppToken.trim();
  const botToken = slackBotToken.trim();
  if (!appToken) throw new Error("Missing Slack app token");
  if (!botToken) throw new Error("Missing Slack bot token");

  const config = readDashboardConfig();
  const snapshot = await fetchSlackWorkspaceSnapshot(botToken);
  const fallbackModel = config.agents.opencode.models[0] ?? "";
  const workspaceId = createWorkspaceCredentialId("slack", botToken);
  const workspaceName = snapshot.team.name?.trim() || `Workspace ${config.workspaces.length + 1}`;
  const channelDetails = buildDiscoveredChannelDetails(snapshot.channels, fallbackModel);

  return {
    id: workspaceId,
    type: "slack",
    name: workspaceName,
    domain: formatSlackDomain(snapshot.team.domain),
    status: "active",
    channels: channelDetails.length,
    members: 0,
    lastSync: new Date().toISOString(),
    slackAppToken: appToken,
    slackBotToken: botToken,
    channelDetails,
  };
};

export const syncSlackWorkspace = async (workspaceId: string): Promise<WorkspaceConfig> => {
  const config = readDashboardConfig();
  const workspaceIndex = config.workspaces.findIndex((item) => item.id === workspaceId);
  if (workspaceIndex === -1) throw new Error("Workspace not found");

  const workspace = config.workspaces[workspaceIndex]!;
  if (workspace.type !== "slack") throw new Error("Workspace is not Slack type");

  const botToken = workspace.slackBotToken?.trim() ?? "";
  if (!botToken) throw new Error("Missing Slack bot token");

  const snapshot = await fetchSlackWorkspaceSnapshot(botToken);
  const fallbackModel = config.agents.opencode.models[0] ?? "";
  const channelDetails = buildSyncedChannelDetails(snapshot.channels, workspace, fallbackModel);

  const updatedWorkspace: WorkspaceConfig = {
    ...workspace,
    type: "slack",
    name: snapshot.team.name ?? workspace.name,
    domain: formatSlackDomain(snapshot.team.domain) || workspace.domain,
    channels: channelDetails.length,
    lastSync: new Date().toISOString(),
    channelDetails,
  };

  updateDashboardConfig((current) => ({
    ...current,
    workspaces: current.workspaces.map((item, index) =>
      index === workspaceIndex ? updatedWorkspace : item
    ),
  }));

  return updatedWorkspace;
};
