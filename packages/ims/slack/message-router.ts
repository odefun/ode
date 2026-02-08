import { log } from "@/utils";

type RouterDeps = {
  app: any;
  isAuthorizedChannel: (channelId: string) => boolean;
  resolveWorkspaceAuth: (
    teamId?: string,
    enterpriseId?: string
  ) => { workspaceId?: string; workspaceName?: string; botToken?: string; [key: string]: unknown } | undefined;
  syncWorkspaceForChannel: (
    channelId: string,
    workspaceAuth: { workspaceId?: string; workspaceName?: string; botToken?: string; [key: string]: unknown } | undefined
  ) => Promise<boolean>;
  getChannelWorkspaceName: (channelId: string) => string | undefined;
  setChannelWorkspaceName: (channelId: string, workspaceName: string) => void;
  setChannelWorkspaceAuth: (
    channelId: string,
    auth: { workspaceId?: string; workspaceName?: string; botToken?: string; [key: string]: unknown } | undefined
  ) => void;
  isThreadActive: (channelId: string, threadId: string) => boolean;
  markThreadActive: (channelId: string, threadId: string) => void;
  isGitHubCommand: (text: string) => boolean;
  isChannelSettingsCommand: (text: string) => boolean;
  isGeneralSettingsCommand: (text: string) => boolean;
  postGitHubLauncher: (channelId: string, userId: string, client: any) => Promise<void>;
  postChannelSettingsLauncher: (channelId: string, userId: string, client: any) => Promise<void>;
  postGeneralSettingsLauncher: (channelId: string, userId: string, client: any) => Promise<void>;
  describeSettingsIssues: (channelId: string) => string[];
  getChannelAgentProvider: (channelId: string) => "opencode" | "claudecode" | "codex" | "kimi" | "kiro" | "qwen";
  handleStopCommand: (channelId: string, threadId: string) => Promise<boolean>;
  handleIncomingMessage: (context: {
    channelId: string;
    threadId: string;
    userId: string;
    messageId: string;
    workspaceName?: string;
  }, text: string) => Promise<void>;
};

type WorkspaceAuth = ReturnType<RouterDeps["resolveWorkspaceAuth"]>;

type IncomingMessageData = {
  channelId: string;
  userId: string;
  text: string;
  threadId: string;
  messageId: string;
};

function syncWorkspaceAuth(
  deps: RouterDeps,
  channelId: string,
  teamId?: string,
  enterpriseId?: string
): WorkspaceAuth {
  if (!teamId) return undefined;
  const auth = deps.resolveWorkspaceAuth(teamId, enterpriseId);
  if (auth?.workspaceName && !deps.getChannelWorkspaceName(channelId)) {
    deps.setChannelWorkspaceName(channelId, auth.workspaceName);
  }
  deps.setChannelWorkspaceAuth(channelId, auth);
  return auth;
}

function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

function extractIncomingMessageData(message: any): IncomingMessageData | null {
  if (message.subtype !== undefined) return null;
  if (!("text" in message) || !message.text) return null;
  if (!("user" in message) || !message.user) return null;

  return {
    channelId: message.channel,
    userId: message.user,
    text: message.text,
    threadId: message.thread_ts || message.ts,
    messageId: message.ts,
  };
}

function shouldDropForThreadContext(isMention: boolean, threadActive: boolean): boolean {
  return !isMention && !threadActive;
}

function shouldDropForOtherMentions(text: string, isMention: boolean): boolean {
  return /<@U[A-Z0-9]+>/g.test(text) && !isMention;
}

async function maybeHandleStopCommand(
  deps: RouterDeps,
  text: string,
  channelId: string,
  threadId: string,
  say: any
): Promise<boolean> {
  if (!/\bstop\b/i.test(text)) return false;
  const stopped = await deps.handleStopCommand(channelId, threadId);
  if (!stopped) return false;

  await say({ text: "Request stopped.", thread_ts: threadId });
  return true;
}

async function maybeRefreshWorkspaceForMention(params: {
  deps: RouterDeps;
  channelId: string;
  isMention: boolean;
  workspaceAuth: WorkspaceAuth;
}): Promise<void> {
  const { deps, channelId, isMention, workspaceAuth } = params;
  if (!isMention) return;
  if (deps.isAuthorizedChannel(channelId)) return;
  await deps.syncWorkspaceForChannel(channelId, workspaceAuth);
}

async function maybeNotifySettingsIssues(
  deps: RouterDeps,
  channelId: string,
  threadId: string,
  userId: string,
  client: any,
  say: any
): Promise<boolean> {
  const settingsIssues = deps.describeSettingsIssues(channelId);
  if (settingsIssues.length === 0) return false;

  await say({
    text: `Channel settings need attention:\n- ${settingsIssues.join("\n- ")}`,
    thread_ts: threadId,
  });
  await deps.postChannelSettingsLauncher(channelId, userId, client);
  return true;
}

async function maybeHandleLauncherCommand(params: {
  deps: RouterDeps;
  cleanText: string;
  isMention: boolean;
  channelId: string;
  userId: string;
  client: any;
}): Promise<boolean> {
  const { deps, cleanText, isMention, channelId, userId, client } = params;

  const commandHandlers: Array<{
    matches: (text: string) => boolean;
    launch: (channelId: string, userId: string, client: any) => Promise<void>;
  }> = [
    { matches: deps.isGitHubCommand, launch: deps.postGitHubLauncher },
    { matches: deps.isChannelSettingsCommand, launch: deps.postChannelSettingsLauncher },
    { matches: deps.isGeneralSettingsCommand, launch: deps.postGeneralSettingsLauncher },
  ];

  const handler = commandHandlers.find((entry) => entry.matches(cleanText));
  if (!handler) return false;
  if (isMention) {
    await handler.launch(channelId, userId, client);
  }
  return true;
}

export function registerSlackMessageRouter(deps: RouterDeps): void {
  const slackApp = deps.app;

  slackApp.message(async ({ message, say, client }: any) => {
    const incoming = extractIncomingMessageData(message);
    if (!incoming) return;

    const { channelId, userId, text, threadId, messageId } = incoming;

    const authResult = await client.auth.test();
    const currentBotUserId = authResult.user_id as string;
    const workspaceAuth = syncWorkspaceAuth(
      deps,
      channelId,
      authResult.team_id,
      authResult.enterprise_id ?? undefined
    );

    if (userId === currentBotUserId) {
      log.debug("[DROP] Message from bot user", { channelId, userId });
      return;
    }

    const isMention = currentBotUserId ? text.includes(`<@${currentBotUserId}>`) : false;
    await maybeRefreshWorkspaceForMention({
      deps,
      channelId,
      isMention,
      workspaceAuth,
    });

    if (await maybeHandleStopCommand(deps, text, channelId, threadId, say)) {
      return;
    }
    const threadActive = deps.isThreadActive(channelId, threadId);

    if (shouldDropForThreadContext(isMention, threadActive)) {
      log.info("[DROP] Not mentioned and thread inactive", { channelId, threadId });
      return;
    }

    if (shouldDropForOtherMentions(text, isMention)) {
      log.info("[DROP] Mentions other user", { channelId, threadId });
      return;
    }

    deps.markThreadActive(channelId, threadId);

    const cleanText = stripBotMention(text, currentBotUserId);

    if (await maybeHandleLauncherCommand({
      deps,
      cleanText,
      isMention,
      channelId,
      userId,
      client,
    })) {
      return;
    }

    if (await maybeNotifySettingsIssues(deps, channelId, threadId, userId, client, say)) {
      return;
    }

    const workspaceName = deps.getChannelWorkspaceName(channelId) || "unknown";
    if (!cleanText) {
      await say({
        text: "Hi! How can I help you? Just ask me anything.",
        thread_ts: threadId,
      });
      return;
    }

    await deps.handleIncomingMessage(
      {
        channelId,
        threadId,
        userId,
        messageId,
        workspaceName,
      },
      cleanText
    );
  });
}
