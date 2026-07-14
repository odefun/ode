import { normalizeCwd } from "../paths";
import { isAgentProviderId } from "@/shared/agent-provider";
import {
  type AgentProvider,
  type ChannelDetail,
  type WorkspaceConfig,
} from "./ode-schema";
import {
  loadOdeConfig,
  normalizeBaseBranch,
  updateOdeConfig,
} from "./ode-store";

export type ChannelCwdInfo = {
  cwd: string;
  workingDirectory: string | null;
  hasCustomCwd: boolean;
};

export function getDefaultCwd(): string {
  return normalizeCwd(process.cwd());
}

function getWorkspaces(): WorkspaceConfig[] {
  return loadOdeConfig().workspaces;
}

function resolveConfigChannelId(channelId: string): string {
  const trimmed = channelId.trim();
  if (!trimmed) return trimmed;
  const delimiter = "::";
  const index = trimmed.lastIndexOf(delimiter);
  if (index < 0) return trimmed;
  const raw = trimmed.slice(index + delimiter.length).trim();
  return raw || trimmed;
}

export function getChannelDetails(channelId: string): ChannelDetail | null {
  const resolvedChannelId = resolveConfigChannelId(channelId);
  for (const workspace of getWorkspaces()) {
    const match = workspace.channelDetails.find((channel) => channel.id === resolvedChannelId);
    if (match) return match;
  }
  return null;
}

export function resolveChannelCwd(channelId: string): ChannelCwdInfo {
  const channel = getChannelDetails(channelId);
  const workingDirectory = channel?.workingDirectory?.trim();
  const normalized = workingDirectory && workingDirectory.length > 0
    ? normalizeCwd(workingDirectory)
    : null;
  return {
    cwd: normalized ?? getDefaultCwd(),
    workingDirectory: normalized,
    hasCustomCwd: Boolean(normalized),
  };
}

export function setChannelCwd(channelId: string, cwd: string): void {
  updateChannel(channelId, (channel) => ({
    ...channel,
    workingDirectory: normalizeCwd(cwd),
  }));
}

export function setChannelWorkingDirectory(channelId: string, workingDirectory: string | null): void {
  const normalized = workingDirectory && workingDirectory.trim().length > 0
    ? normalizeCwd(workingDirectory)
    : "";
  updateChannel(channelId, (channel) => ({
    ...channel,
    workingDirectory: normalized,
  }));
}

export function getChannelBaseBranch(channelId: string): string {
  return normalizeBaseBranch(getChannelDetails(channelId)?.baseBranch);
}

export function setChannelBaseBranch(channelId: string, baseBranch: string | null): void {
  const normalized = normalizeBaseBranch(baseBranch);
  updateChannel(channelId, (channel) => ({
    ...channel,
    baseBranch: normalized,
  }));
}

export function getChannelSystemMessage(channelId: string): string | null {
  return getChannelDetails(channelId)?.channelSystemMessage ?? null;
}

export function setChannelSystemMessage(channelId: string, channelSystemMessage: string | null): void {
  const normalized = channelSystemMessage?.trim() ?? "";
  updateChannel(channelId, (channel) => ({
    ...channel,
    channelSystemMessage: normalized,
  }));
}

export function getChannelModel(channelId: string): string | null {
  return getChannelDetails(channelId)?.model ?? null;
}

export function getChannelAgentProvider(channelId: string): AgentProvider {
  const provider = getChannelDetails(channelId)?.agentProvider;
  return isAgentProviderId(provider) ? provider : "opencode";
}

export function setChannelModel(channelId: string, model: string): void {
  updateChannel(channelId, (channel) => ({ ...channel, model }));
}

export function getChannelAmbientMode(channelId: string): boolean {
  return getChannelDetails(channelId)?.ambientMode ?? false;
}

export function setChannelAmbientMode(channelId: string, ambientMode: boolean): void {
  updateChannel(channelId, (channel) => ({ ...channel, ambientMode }));
}

export function setChannelAgentProvider(
  channelId: string,
  agentProvider: AgentProvider
): void {
  updateChannel(channelId, (channel) => ({ ...channel, agentProvider }));
}

function updateChannel(
  channelId: string,
  updater: (channel: ChannelDetail) => ChannelDetail
): void {
  const resolvedChannelId = resolveConfigChannelId(channelId);
  let updated = false;
  updateOdeConfig((config) => {
    const workspaces = config.workspaces.map((workspace) => {
      const channelDetails = workspace.channelDetails.map((channel) => {
        if (channel.id !== resolvedChannelId) return channel;
        updated = true;
        return updater(channel);
      });
      return { ...workspace, channelDetails };
    });

    if (!updated) {
      throw new Error("Channel not found in ~/.config/ode/ode.json");
    }

    return { ...config, workspaces };
  });
}
