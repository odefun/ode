import { log } from "@/utils";
import {
  formatIncomingDropMessage,
  parseIncomingCommand,
  type IncomingFlowResult,
} from "@/ims/shared/incoming-message-processor";
import type { InboundDecision } from "@/core/model/inbound-decision";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";
import { getChannelAmbientMode } from "@/config/local/ode-channel";
import { RuntimeCache } from "@/shared/cache/runtime-cache";
import { SlackInboundAdapter } from "@/ims/slack/slack-inbound-adapter";
import {
  deliveryStats,
  renderDeliveryStatsForSlack,
} from "@/ims/shared/delivery-stats";

type RouterDeps = {
  app: any;
  isAuthorizedChannel: (channelId: string) => boolean;
  resolveWorkspaceAuth: (
    credentialKey?: string
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
  isThreadOwner: (channelId: string, threadId: string, userId: string) => boolean;
  isThreadActive: (channelId: string, threadId: string, botId: string) => boolean;
  postGeneralSettingsLauncher: (channelId: string, userId: string, client: any) => Promise<void>;
  postCronLauncher: (channelId: string, userId: string, client: any) => Promise<void>;
  describeSettingsIssues: (channelId: string) => string[];
  handleInboundEvent: (event: RawInboundEvent) => Promise<void>;
};

type WorkspaceAuth = ReturnType<RouterDeps["resolveWorkspaceAuth"]>;

const slackInboundAdapter = new SlackInboundAdapter();
const TRACE_SLACK_ROUTER = process.env.ODE_SLACK_TRACE === "1";

function logSlackTrace(message: string, data: Record<string, unknown>): void {
  if (TRACE_SLACK_ROUTER) {
    log.info(message, data);
    return;
  }
  log.debug(message, data);
}

function toIncomingFlowResult(decision: InboundDecision): IncomingFlowResult {
  switch (decision.kind) {
    case "ignore":
      return { type: "ignore", reason: decision.reason };
    case "stop":
      return { type: "stop", text: "stop" };
    case "message":
      return { type: "forward", text: decision.text };
  }
}

type BotIdentity = {
  botUserId: string;
  botId?: string;
  teamId?: string;
  enterpriseId?: string;
};

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
  credentialKey?: string
): WorkspaceAuth {
  const auth = deps.resolveWorkspaceAuth(credentialKey);
  if (auth?.workspaceName && !deps.getChannelWorkspaceName(channelId)) {
    deps.setChannelWorkspaceName(channelId, auth.workspaceName);
  }
  deps.setChannelWorkspaceAuth(channelId, auth);
  return auth;
}

function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  const escapedBotUserId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`<@${escapedBotUserId}(?:\\|[^>]+)?>`, "g"), "").trim();
}

function extractMentionedUserIds(text: string): string[] {
  const mentionPattern = /<@([A-Z0-9_]+)(?:\|[^>]+)?>/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(text)) !== null) {
    const mentionedUserId = match[1];
    if (mentionedUserId) {
      mentions.push(mentionedUserId);
    }
  }
  return mentions;
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
  say: any,
  flowResult: IncomingFlowResult,
): Promise<boolean> {
  if (flowResult.type === "ignore") return false;

  const settingsIssues = deps.describeSettingsIssues(channelId);
  if (settingsIssues.length === 0) return false;

  await say({
    text: `Channel settings need attention:\n- ${settingsIssues.join("\n- ")}`,
    thread_ts: threadId,
  });
  log.info("Slack settings launcher triggered by configuration issues", {
    channelId,
    threadId,
    userId,
    issuesCount: settingsIssues.length,
    issues: settingsIssues,
  });
  await deps.postGeneralSettingsLauncher(channelId, userId, client);
  return true;
}

async function maybeHandleLauncherCommand(params: {
  deps: RouterDeps;
  cleanText: string;
  isMention: boolean;
  ambientMode: boolean;
  channelId: string;
  threadId: string;
  userId: string;
  client: any;
  say: any;
}): Promise<boolean> {
  const { deps, cleanText, isMention, ambientMode, channelId, threadId, userId, client, say } = params;
  const command = parseIncomingCommand(cleanText);
  if (command === "setting") {
    if (isMention || ambientMode) {
      log.info("Slack settings launcher command matched", {
        channelId,
        userId,
        cleanText,
      });
      await deps.postGeneralSettingsLauncher(channelId, userId, client);
    } else {
      log.debug("Slack settings command ignored because bot was not mentioned", {
        channelId,
        userId,
        cleanText,
      });
    }
    return true;
  }
  if (command === "stats") {
    if (isMention || ambientMode) {
      log.info("Slack delivery stats command matched", {
        channelId,
        userId,
        cleanText,
      });
      await handleStatsCommand({ channelId, threadId, say });
    } else {
      log.debug("Slack stats command ignored because bot was not mentioned", {
        channelId,
        userId,
        cleanText,
      });
    }
    return true;
  }
  if (command === "cron") {
    if (isMention || ambientMode) {
      log.info("Slack cron launcher command matched", {
        channelId,
        userId,
        cleanText,
      });
      await deps.postCronLauncher(channelId, userId, client);
    } else {
      log.debug("Slack cron command ignored because bot was not mentioned", {
        channelId,
        userId,
        cleanText,
      });
    }
    return true;
  }
  return false;
}

async function handleStatsCommand(params: {
  channelId: string;
  threadId: string;
  say: any;
}): Promise<void> {
  const { channelId, threadId, say } = params;
  const rendered = renderDeliveryStatsForSlack({
    channelId,
    platform: "slack",
  });
  let dumpNote = "";
  try {
    const dumpPath = await deliveryStats.dumpToFile();
    dumpNote = `\n_dumped full snapshot to_ \`${dumpPath}\``;
  } catch (err) {
    dumpNote = `\n_failed to dump snapshot: ${String(err)}_`;
  }
  await say({
    text: `${rendered}${dumpNote}`,
    thread_ts: threadId,
  });
}

function getCacheKey(credentialKey?: string): string | undefined {
  if (!credentialKey) return undefined;
  return `credential:${credentialKey}`;
}

async function getBotIdentity(params: {
  client: any;
  cache: RuntimeCache<string, BotIdentity>;
  credentialKey?: string;
}): Promise<BotIdentity> {
  const { client, cache, credentialKey } = params;
  const key = getCacheKey(credentialKey);
  if (key) {
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
  }

  const authResult = await client.auth.test();
  const identity: BotIdentity = {
    botUserId: (authResult.user_id as string) || "",
    botId: authResult.bot_id as string | undefined,
    teamId: authResult.team_id as string | undefined,
    enterpriseId: authResult.enterprise_id as string | undefined,
  };

  if (key) {
    cache.set(key, identity);
  }
  return identity;
}

export function registerSlackMessageRouter(deps: RouterDeps): void {
  const slackApp = deps.app;
  const botIdentityCache = new RuntimeCache<string, BotIdentity>({
    max: 200,
    ttlMs: 24 * 60 * 60 * 1000,
  });

  slackApp.message(async ({ message, say, client, context }: any) => {
    let contextData: IncomingMessageData | null = null;

    try {
      const incoming = extractIncomingMessageData(message);
      if (!incoming) return;
      contextData = incoming;

      const { channelId, userId, text, threadId, messageId } = incoming;
      const contextBotToken = context?.botToken as string | undefined;
      let workspaceAuth = syncWorkspaceAuth(
        deps,
        channelId,
        contextBotToken
      );
      const credentialKey =
        contextBotToken
        ?? workspaceAuth?.botToken
        ?? undefined;
      const identity = await getBotIdentity({
        client,
        cache: botIdentityCache,
        credentialKey,
      });

      const currentBotUserId = identity.botUserId;
      if (workspaceAuth) {
        workspaceAuth = {
          ...workspaceAuth,
          teamId: identity.teamId ?? workspaceAuth.teamId,
          enterpriseId: identity.enterpriseId ?? workspaceAuth.enterpriseId,
          botUserId: identity.botUserId || workspaceAuth.botUserId,
          botId: identity.botId ?? workspaceAuth.botId,
          userId: identity.botUserId || workspaceAuth.userId,
        };
        deps.setChannelWorkspaceAuth(channelId, workspaceAuth);
      }
      if (!workspaceAuth && contextBotToken) {
        workspaceAuth = syncWorkspaceAuth(deps, channelId, contextBotToken);
      }

      const messageBotId = typeof message?.bot_id === "string" ? message.bot_id : undefined;
      const messageBotProfileId = typeof message?.bot_profile?.id === "string"
        ? message.bot_profile.id
        : undefined;
      const selfMessage =
        (currentBotUserId && userId === currentBotUserId)
        || (Boolean(identity.botId) && (messageBotId === identity.botId || messageBotProfileId === identity.botId));

      const mentionedUserIds = extractMentionedUserIds(text);
      const hasAnyMention = mentionedUserIds.length > 0;
      const isMention = currentBotUserId ? mentionedUserIds.includes(currentBotUserId) : false;
      const cleanText = stripBotMention(text, currentBotUserId);
      const ambientMode = getChannelAmbientMode(channelId);
      logSlackTrace("Slack mention parse", {
        channelId,
        threadId,
        messageId,
        userId,
        currentBotUserId,
        mentionedUserIds,
        isMention,
        text,
        cleanText,
      });
      await maybeRefreshWorkspaceForMention({
        deps,
        channelId,
        isMention,
        workspaceAuth,
      });

      const runtimeBotId = contextBotToken ?? workspaceAuth?.botToken ?? "default";
      const isTopLevel = threadId === messageId;
      const threadOwnerMessage = deps.isThreadOwner(channelId, threadId, userId);
      const threadActive = deps.isThreadActive(channelId, threadId, runtimeBotId);
      const inboundEvent: RawInboundEvent = {
        platform: "slack",
        botId: runtimeBotId,
        channelId,
        rawChannelId: channelId,
        threadId,
        replyThreadId: threadId,
        messageId,
        userId,
        selfMessage,
        threadOwnerMessage,
        isTopLevel,
        hasAnyMention,
        mentionedBot: isMention,
        activeThread: threadActive,
        ambientMode,
        rawText: text,
        normalizedText: cleanText,
        receivedAtMs: Date.now(),
      };
      const flowResult = toIncomingFlowResult(slackInboundAdapter.evaluate(inboundEvent));
      logSlackTrace("Slack inbound decision", {
        channelId,
        threadId,
        messageId,
        currentBotUserId,
        mentionedUserIds,
        isMention,
        threadOwnerMessage,
        threadActive,
        flowType: flowResult.type,
        flowReason: flowResult.type === "ignore" ? flowResult.reason : undefined,
      });

      if (selfMessage) {
        log.info("[DROP] Bot-authored message", {
          channelId,
          threadId,
          messageId,
          userId,
          currentBotUserId,
          currentBotId: identity.botId,
          messageBotId,
          messageBotProfileId,
        });
      }

      if (await maybeHandleLauncherCommand({
        deps,
        cleanText,
        isMention,
        ambientMode,
        channelId,
        threadId,
        userId,
        client,
        say,
      })) {
        return;
      }

      if (await maybeNotifySettingsIssues(deps, channelId, threadId, userId, client, say, flowResult)) {
        return;
      }

      if (flowResult.type === "ignore") {
        if (
          flowResult.reason === "not_mentioned_and_inactive"
          || flowResult.reason === "self_message"
          || flowResult.reason === "not_thread_owner"
        ) {
          logSlackTrace(formatIncomingDropMessage(flowResult.reason), {
            channelId,
            threadId,
            messageId,
            mentionedUserIds,
            currentBotUserId,
            isMention,
            threadActive,
          });
          return;
        }
        await say({
          text: "Hi! How can I help you? Just ask me anything.",
          thread_ts: threadId,
        });
        return;
      }

      await deps.handleInboundEvent(inboundEvent);
    } catch (error) {
      log.error("Slack message router failed", {
        channelId: contextData?.channelId,
        threadId: contextData?.threadId,
        messageId: contextData?.messageId,
        error: String(error),
      });
      if (contextData) {
        await say({
          text: "I hit an internal error while handling that message. Please try again.",
          thread_ts: contextData.threadId,
        });
      }
    }
  });
}
