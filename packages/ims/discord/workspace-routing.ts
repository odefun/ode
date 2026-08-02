import { DISCORD_WORKSPACE_NOT_CONFIGURED_CODE } from "@/shared/delivery/permanent-error";

export function requireDiscordWorkspaceClient<T>(params: {
  workspaceId: string;
  configuredWorkspaceIds: Iterable<string>;
  connectedClients: ReadonlyMap<string, T>;
}): T {
  const configuredWorkspaceIds = new Set(params.configuredWorkspaceIds);
  if (!configuredWorkspaceIds.has(params.workspaceId)) {
    throw Object.assign(
      new Error(`Discord workspace ${params.workspaceId} is no longer configured`),
      { code: DISCORD_WORKSPACE_NOT_CONFIGURED_CODE },
    );
  }

  const client = params.connectedClients.get(params.workspaceId);
  if (!client) {
    // The workspace is still configured, so this is most likely a transient
    // login/restart failure. Do not attach a permanent error code: the cron
    // scheduler must keep the job enabled and retry on its next occurrence.
    throw new Error(`Discord workspace ${params.workspaceId} client is temporarily unavailable`);
  }
  return client;
}
