export function validateWorkspaceConfig(config: {
  workspaces: Array<{
    id: string;
    type: "slack" | "discord" | "lark";
    name: string;
    slackAppToken?: string;
    slackBotToken?: string;
    discordBotToken?: string;
    larkAppKey?: string;
    larkAppId?: string;
    larkAppSecret?: string;
  }>;
}): string | null {
  const idCounts = new Map<string, number>();
  const slackBotTokenCounts = new Map<string, number>();
  const discordBotTokenCounts = new Map<string, number>();
  const larkAppKeyCounts = new Map<string, number>();
  for (const workspace of config.workspaces) {
    const workspaceId = workspace.id.trim();
    if (!workspaceId) {
      return "Workspace id is required for every workspace";
    }
    idCounts.set(workspaceId, (idCounts.get(workspaceId) ?? 0) + 1);
    if (workspace.type === "discord") {
      const botToken = workspace.discordBotToken?.trim() ?? "";
      if (!botToken) {
        const label = workspace.name.trim() || workspace.id;
        return `Missing Discord bot token for workspace: ${label}`;
      }
      discordBotTokenCounts.set(botToken, (discordBotTokenCounts.get(botToken) ?? 0) + 1);
      continue;
    }

    if (workspace.type === "lark") {
      const appId = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      const appSecret = workspace.larkAppSecret?.trim() ?? "";
      if (!appId || !appSecret) {
        const label = workspace.name.trim() || workspace.id;
        return `Missing Lark app key/app secret for workspace: ${label}`;
      }
      larkAppKeyCounts.set(appId, (larkAppKeyCounts.get(appId) ?? 0) + 1);
      continue;
    }

    const appToken = workspace.slackAppToken?.trim() ?? "";
    const botToken = workspace.slackBotToken?.trim() ?? "";
    if (!appToken || !botToken) {
      const label = workspace.name.trim() || workspace.id;
      return `Missing Slack app/bot token for workspace: ${label}`;
    }
    slackBotTokenCounts.set(botToken, (slackBotTokenCounts.get(botToken) ?? 0) + 1);
  }

  const duplicateIds = Array.from(idCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  if (duplicateIds.length > 0) {
    return `Duplicate workspace ids: ${duplicateIds.join(", ")}`;
  }

  const duplicateSlackBotTokenCount = Array.from(slackBotTokenCounts.values()).filter((count) => count > 1).length;
  if (duplicateSlackBotTokenCount > 0) {
    return "Duplicate Slack bot tokens found across workspaces";
  }

  const duplicateDiscordBotTokenCount = Array.from(discordBotTokenCounts.values()).filter((count) => count > 1).length;
  if (duplicateDiscordBotTokenCount > 0) {
    return "Duplicate Discord bot tokens found across workspaces";
  }

  const duplicateLarkAppKeyCount = Array.from(larkAppKeyCounts.values()).filter((count) => count > 1).length;
  if (duplicateLarkAppKeyCount > 0) {
    return "Duplicate Lark app keys found across workspaces";
  }

  return null;
}
