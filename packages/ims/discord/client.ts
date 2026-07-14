import {
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { createCoreRuntime } from "@/core/runtime";
import type { IMAdapter } from "@/core/types";
import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents";
import {
  getChannelSystemMessage,
  getDiscordBotTokens,
  getDiscordTargetChannels,
  getGitHubInfoForUser,
} from "@/config";
import { findReplyThreadIdByStatusMessageTs } from "@/config/local/sessions";
import {
  isThreadActive,
  loadSession,
  markThreadActive,
} from "@/config/local/sessions";
import { log } from "@/utils";
import {
  formatIncomingDropMessage,
  parseIncomingCommand,
} from "@/ims/shared/incoming-message-processor";
import { createRuntimeController } from "@/ims/shared/runtime-controller";
import { createProcessorId } from "@/ims/shared/processor-id";
import {
  DISCORD_LAUNCHER_COMMANDS,
  handleDiscordSettingsInteraction,
  sendLauncherReplyForMessage,
} from "@/ims/discord/settings";
import { createProcessorManager } from "@/ims/shared/processor-manager";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import {
  buildMeaningfulThreadName,
  cleanBotMention,
  formatThreadNameFromBranch,
  formatThreadNameFromStatusTitle,
  isTopLevelMessage,
  markdownToDiscord,
  splitForDiscord,
} from "@/ims/discord/utils/message-utils";
import {
  isDiscordRateLimitErrorMessage,
  parseDiscordRetryAfterMs,
  sleep,
} from "@/ims/discord/utils/rate-limit";
import { DiscordStatusMessageIndex } from "@/ims/discord/state/status-message-index";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_THREAD_NAME_LIMIT = 25;
const DISCORD_THREAD_RENAME_LIMIT = 90;
const DISCORD_UPDATE_MAX_ATTEMPTS = 3;
const DISCORD_UPDATE_RETRY_BASE_MS = 400;

const discordClients = new Map<string, Client>();
const discordClientByProcessorId = new Map<string, Client>();
const statusMessageIndex = new DiscordStatusMessageIndex();
const discordThreadProcessorByKey = new Map<string, string>();
const discordProcessorManager = createProcessorManager({
  createRuntime: (processorId) => createCoreRuntime({
    platform: "discord",
    im: createDiscordAdapter(processorId),
    agent: createAgentAdapter(),
  }),
});

function getDiscordProcessorRuntime(processorId: string): ReturnType<typeof createCoreRuntime> {
  return discordProcessorManager.getRuntime(processorId);
}

function getThreadKey(channelId: string, threadId: string): string {
  return `${channelId}:${threadId}`;
}

function rememberThreadProcessor(channelId: string, threadId: string, processorId: string): void {
  discordThreadProcessorByKey.set(getThreadKey(channelId, threadId), processorId);
}

function getRememberedThreadProcessor(channelId: string, threadId: string): string | undefined {
  return discordThreadProcessorByKey.get(getThreadKey(channelId, threadId));
}

function getConfiguredDiscordRuntimeBots(): Array<{ workspaceId: string; token: string }> {
  const uniqueByWorkspace = new Map<string, { workspaceId: string; token: string }>();
  for (const entry of getDiscordBotTokens()) {
    const workspaceId = entry.workspaceId?.trim() || "";
    const token = entry.token?.trim() || "";
    if (!workspaceId || !token) continue;
    if (uniqueByWorkspace.has(workspaceId)) continue;
    uniqueByWorkspace.set(workspaceId, { workspaceId, token });
  }
  return Array.from(uniqueByWorkspace.values());
}

async function maybeHandleLauncherCommand(params: {
  text: string;
  message: any;
  channelId: string;
  logContext: "thread" | "parent channel" | "mention";
}): Promise<boolean> {
  const command = parseIncomingCommand(params.text);
  if (command !== "setting") return false;
  await sendLauncherReplyForMessage({
    message: params.message,
    command,
    channelId: params.channelId,
  });
  log.debug(`Handled Discord message settings command in ${params.logContext}`, {
    command,
    channelId: params.channelId,
  });
  return true;
}
async function resolveTextChannel(channelId: string, processorId?: string) {
  const attempts: string[] = [];
  if (processorId) {
    const pinnedClient = discordClientByProcessorId.get(processorId);
    if (pinnedClient) {
      try {
        const channel = await pinnedClient.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          return channel as any;
        }
        attempts.push(`bot=${pinnedClient.user?.id || "unknown"}: channel_not_text_or_missing`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        attempts.push(`bot=${pinnedClient.user?.id || "unknown"}: ${errorMessage}`);
      }
    }
  }

  for (const client of discordClients.values()) {
    if (processorId && discordClientByProcessorId.get(processorId) === client) continue;
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        return channel as any;
      }
      attempts.push(`bot=${client.user?.id || "unknown"}: channel_not_text_or_missing`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      attempts.push(`bot=${client.user?.id || "unknown"}: ${errorMessage}`);
    }
  }

  if (attempts.length > 0) {
    log.warn("Failed to resolve Discord text channel from available clients", {
      channelId,
      clientCount: discordClients.size,
      attempts,
    });
  }

  throw new Error(`Discord channel ${channelId} is not text-based or inaccessible`);
}

async function buildDiscordContext(
  channelId: string,
  threadId: string,
  userId: string,
  threadHistory?: string | null
): Promise<OpenCodeMessageContext> {
  return {
    threadHistory: threadHistory ?? undefined,
    slack: {
      platform: "discord",
      channelId,
      threadId,
      userId,
      threadHistory: threadHistory ?? undefined,
      hasGitHubToken: Boolean(getGitHubInfoForUser(userId)?.token),
      channelSystemMessage: getChannelSystemMessage(channelId) ?? undefined,
    },
  };
}

async function sendMessage(
  channelId: string,
  threadId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  try {
    const resolvedProcessorId = processorId || getRememberedThreadProcessor(channelId, threadId);
    const channel = await resolveTextChannel(threadId, resolvedProcessorId);
    const formattedText = markdownToDiscord(text);
    const chunks = splitForDiscord(formattedText, DISCORD_MESSAGE_LIMIT);
    let firstId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      try {
        const sent = await channel.send(chunk);
        firstId = firstId || sent.id;
        statusMessageIndex.setThreadId(sent.id, threadId);
      } catch (error) {
        log.warn("Failed to send Discord message chunk", {
          threadId,
          chunkIndex: index,
          chunkCount: chunks.length,
          chunkLength: chunk.length,
          error: String(error),
        });
        throw error;
      }
    }
    return firstId;
  } catch (error) {
    log.warn("Failed to send Discord message", {
      threadId,
      textLength: text.length,
      error: String(error),
    });
    throw error;
  }
}

export async function sendChannelMessage(
  channelId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  try {
    const channel = await resolveTextChannel(channelId, processorId);
    const formattedText = markdownToDiscord(text);
    const chunks = splitForDiscord(formattedText, DISCORD_MESSAGE_LIMIT);
    let firstId: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? "";
      const sent = await channel.send(chunk);
      firstId = firstId || sent.id;
      statusMessageIndex.setThreadId(sent.id, channelId);
    }
    return firstId;
  } catch (error) {
    log.warn("Failed to send Discord top-level channel message", {
      channelId,
      textLength: text.length,
      error: String(error),
    });
    throw error;
  }
}

async function updateMessage(
  channelId: string,
  messageId: string,
  text: string,
  processorId?: string
): Promise<void> {
  const rawChannelId = channelId;
  try {
    const mappedThreadId = statusMessageIndex.getThreadId(messageId);
    const persistedThreadId = findReplyThreadIdByStatusMessageTs(messageId);
    const threadId = mappedThreadId || persistedThreadId || rawChannelId;
    if (!threadId) {
      log.warn("Cannot update Discord message without known thread", { messageId });
      return;
    }
    if (!mappedThreadId && persistedThreadId) {
      statusMessageIndex.setThreadId(messageId, persistedThreadId);
    }
    const resolvedProcessorId = processorId || getRememberedThreadProcessor(channelId, threadId);
    const channel = await resolveTextChannel(threadId, resolvedProcessorId);
    const formattedText = markdownToDiscord(text);
    const content = splitForDiscord(formattedText, DISCORD_MESSAGE_LIMIT)[0] ?? formattedText;
    let lastRateLimitError: unknown;

    for (let attempt = 1; attempt <= DISCORD_UPDATE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit(content);
        lastRateLimitError = undefined;
        break;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!isDiscordRateLimitErrorMessage(errorMessage)) {
          throw error;
        }

        lastRateLimitError = error;

        if (attempt >= DISCORD_UPDATE_MAX_ATTEMPTS) {
          throw new Error(
            `Discord message update failed after ${DISCORD_UPDATE_MAX_ATTEMPTS} attempts due to 429 rate limit: ${errorMessage}`
          );
        }

        const retryAfterMs = parseDiscordRetryAfterMs(error);
        const jitterMs = Math.floor(Math.random() * 120);
        const backoffMs = DISCORD_UPDATE_RETRY_BASE_MS * attempt + jitterMs;
        const waitMs = Math.max(retryAfterMs ?? backoffMs, 120);
        log.warn("Discord message update rate limited; retrying", {
          channelId,
          threadId,
          messageId,
          attempt,
          maxAttempts: DISCORD_UPDATE_MAX_ATTEMPTS,
          waitMs,
          error: errorMessage,
        });
        await sleep(waitMs);
      }
    }

    if (lastRateLimitError) {
      throw lastRateLimitError;
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.warn("Failed to update Discord message", {
      messageId,
      channelId,
      resolvedChannelId: statusMessageIndex.getThreadId(messageId) || findReplyThreadIdByStatusMessageTs(messageId) || rawChannelId,
      error: errorMessage,
      errorStack,
    });
    if (isDiscordRateLimitErrorMessage(errorMessage)) {
      throw error;
    }
  }
}

async function deleteMessage(channelId: string, messageId: string, processorId?: string): Promise<void> {
  const rawChannelId = channelId;
  const threadId = statusMessageIndex.getThreadId(messageId) || findReplyThreadIdByStatusMessageTs(messageId) || rawChannelId;
  if (!threadId) return;
  const resolvedProcessorId = processorId || getRememberedThreadProcessor(channelId, threadId);
  const channel = await resolveTextChannel(threadId, resolvedProcessorId);
  const message = await channel.messages.fetch(messageId);
  await message.delete();
}

function createDiscordAdapter(processorId?: string): IMAdapter {
  return {
    maxEditableMessageChars: DISCORD_MESSAGE_LIMIT,
    sendMessage: (channelId: string, threadId: string, text: string) =>
      sendMessage(channelId, threadId, text, processorId),
    updateMessage: (channelId: string, messageId: string, text: string) =>
      updateMessage(channelId, messageId, text, processorId),
    deleteMessage: (channelId: string, messageId: string) =>
      deleteMessage(channelId, messageId, processorId),
    fetchThreadHistory: (channelId: string, threadId: string, messageId: string) =>
      fetchThreadHistory(channelId, threadId, messageId, processorId),
    renameThread: (channelId: string, threadId: string, name: string) =>
      renameDiscordThread(channelId, threadId, name, processorId),
    buildAgentContext: async ({ channelId, threadId, userId, threadHistory }) =>
      buildDiscordContext(channelId, threadId, userId, threadHistory),
  };
}

async function fetchThreadHistory(
  channelId: string,
  threadId: string,
  messageId: string,
  processorId?: string
): Promise<string | null> {
  try {
    const resolvedProcessorId = processorId || getRememberedThreadProcessor(channelId, threadId);
    const channel = await resolveTextChannel(threadId, resolvedProcessorId);
    const history = await channel.messages.fetch({ limit: 20, before: messageId });
    const ordered = Array.from(history.values() as Iterable<any>).reverse();
    const lines = ordered
      .filter((message: any) => !message.author.bot)
      .map((message: any) => `${message.author.username}: ${message.content}`)
      .filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

const discordAdapter: IMAdapter = createDiscordAdapter();

const discordRecoveryRuntime = createCoreRuntime({
  platform: "discord",
  im: discordAdapter,
  agent: createAgentAdapter(),
});

function isBotMentioned(message: any, botUserId: string): boolean {
  const debugMention = ["1", "true", "yes", "on"].includes(
    process.env.DISCORD_DEBUG_MENTION?.trim().toLowerCase() ?? ""
  );
  const mentionIds = Array.from(message?.mentions?.users?.keys?.() ?? []);
  const hasMention = message?.mentions?.users?.has?.(botUserId) ?? false;
  const content = typeof message?.content === "string" ? message.content : "";

  if (debugMention) {
    log.debug("Discord mention evaluate", {
      messageId: typeof message?.id === "string" ? message.id : "",
      botUserId,
      mentionIds,
      hasMentionByCollection: hasMention,
      hasMentionByContent: content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`),
      content,
    });
  }

  if (hasMention) return true;
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

async function renameDiscordThread(
  channelId: string,
  threadId: string,
  name: string,
  processorId?: string
): Promise<void> {
  const looksLikeBranch = /^[a-z0-9._\/-]+$/i.test(name.trim());
  const targetName = looksLikeBranch
    ? formatThreadNameFromBranch(name, DISCORD_THREAD_RENAME_LIMIT)
    : formatThreadNameFromStatusTitle(name, DISCORD_THREAD_RENAME_LIMIT);
  if (!targetName) return;

  try {
    const resolvedProcessorId = processorId || getRememberedThreadProcessor(channelId, threadId);
    const channel = await resolveTextChannel(threadId, resolvedProcessorId);
    if (channel && typeof (channel as any).setName === "function") {
      if ((channel as any).name === targetName) return;
      await (channel as any).setName(targetName);
    }
  } catch (error) {
    log.warn("Failed to rename Discord thread", {
      channelId,
      threadId,
      name,
      error: String(error),
    });
  }
}

async function registerDiscordCommands(client: Client): Promise<void> {
  try {
    const guilds = await client.guilds.fetch();
    for (const [, guildPreview] of guilds) {
      const guild = await client.guilds.fetch(guildPreview.id);
      await guild.commands.set([...DISCORD_LAUNCHER_COMMANDS]);
    }
    log.debug("Discord slash commands registered", { count: DISCORD_LAUNCHER_COMMANDS.length });
  } catch (error) {
    log.warn("Failed to register Discord slash commands", { error: String(error) });
  }
}

async function startDiscordRuntimeInternal(reason: string): Promise<boolean> {
  const bots = getConfiguredDiscordRuntimeBots();

  if (bots.length === 0) {
    log.debug("Discord runtime skipped (Discord bot token missing)", { reason });
    return false;
  }

  let startedCount = 0;
  log.debug("Discord runtime starting", {
    reason,
    tokenCount: bots.length,
  });

  for (const bot of bots) {
    if (discordClients.has(bot.workspaceId)) {
      continue;
    }

    try {
      const processorId = createProcessorId("discord", bot.token);
      const runtime = getDiscordProcessorRuntime(processorId);
      const client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      client.on("messageCreate", async (message: any) => {
        try {
          if (!client.user) return;
          if (message.author.bot) return;
          if (!message.guildId) return;

          const configuredChannels = getDiscordTargetChannels();

          if (!isTopLevelMessage(message)) {
            const parentId = message.channel.parentId;
            if (!parentId) return;
            if (configuredChannels && !configuredChannels.includes(parentId)) return;

            const threadId = message.channel.id;
            const text = message.content.trim();
            const mentioned = isBotMentioned(message, client.user.id);
            const hasAnyMention = (message?.mentions?.users?.size ?? 0) > 0;
            if (await maybeHandleLauncherCommand({
              text,
              message,
              channelId: parentId,
              logContext: "thread",
            })) {
              return;
            }
            const active = isThreadActive(parentId, threadId, processorId);
            const normalizedText = mentioned ? cleanBotMention(text, client.user.id) : text;
            const threadSession = loadSession(parentId, threadId);
            const inboundEvent: RawInboundEvent = {
              platform: "discord",
              botId: processorId,
              channelId: parentId,
              rawChannelId: parentId,
              threadId,
              replyThreadId: threadId,
              messageId: message.id,
              userId: message.author.id,
              selfMessage: false,
              threadOwnerMessage: isSyntheticOwner(threadSession?.threadOwnerUserId)
                || threadSession?.threadOwnerUserId === message.author.id,
              isTopLevel: false,
              hasAnyMention,
              mentionedBot: mentioned,
              activeThread: active,
              ambientMode: false,
              rawText: text,
              normalizedText,
              receivedAtMs: Date.now(),
            };
            rememberThreadProcessor(parentId, threadId, processorId);
            await runtime.handleInboundEvent(inboundEvent);
            return;
          }

          const parentId = message.channel.id;
          if (configuredChannels && !configuredChannels.includes(parentId)) return;

          if (await maybeHandleLauncherCommand({
            text: message.content,
            message,
            channelId: parentId,
            logContext: "parent channel",
          })) {
            return;
          }

          const topLevelMentioned = isBotMentioned(message, client.user.id);
          const topLevelText = cleanBotMention(message.content, client.user.id);
          if (!topLevelMentioned) {
            log.debug(formatIncomingDropMessage("not_mentioned_and_inactive"), {
              platform: "discord",
              channelId: parentId,
              threadId: message.id,
              messageId: message.id,
              isTopLevel: true,
              mentioned: false,
              activeThread: false,
            });
            return;
          }
          if (!topLevelText.trim()) {
            await message.reply("Please include a request after mentioning me.");
            return;
          }

          if (await maybeHandleLauncherCommand({
            text: topLevelText,
            message,
            channelId: parentId,
            logContext: "mention",
          })) {
            return;
          }

          const thread = await message.startThread({
            name: buildMeaningfulThreadName(topLevelText, DISCORD_THREAD_NAME_LIMIT),
            autoArchiveDuration: 60,
          });

          markThreadActive(parentId, thread.id, processorId);
          rememberThreadProcessor(parentId, thread.id, processorId);
          await runtime.handleInboundEvent({
            platform: "discord",
            botId: processorId,
            channelId: parentId,
            rawChannelId: parentId,
            threadId: thread.id,
            replyThreadId: thread.id,
             messageId: message.id,
             userId: message.author.id,
              selfMessage: false,
              threadOwnerMessage: true,
              isTopLevel: false,
              hasAnyMention: true,
              mentionedBot: true,
             activeThread: false,
             ambientMode: false,
            rawText: message.content,
            normalizedText: topLevelText,
            receivedAtMs: Date.now(),
          });
        } catch (error) {
          log.error("Discord message handler failed", { error: String(error) });
        }
      });

      client.on("interactionCreate", async (interaction: any) => {
        try {
          if (await handleDiscordSettingsInteraction(interaction)) return;
        } catch (error) {
          log.error("Discord interaction handler failed", { error: String(error) });
        }
      });

      await client.login(bot.token);
      await registerDiscordCommands(client);
      discordClients.set(bot.workspaceId, client);
      discordClientByProcessorId.set(processorId, client);
      startedCount += 1;
      log.debug("Discord runtime started", {
        reason,
        workspaceId: bot.workspaceId,
        botUserId: client.user?.id ?? "unknown",
      });
    } catch (error) {
      log.error("Discord runtime failed for token", {
        reason,
        workspaceId: bot.workspaceId,
        error: String(error),
      });
    }
  }

  return startedCount > 0;
}

export async function startDiscordRuntime(reason: string): Promise<boolean> {
  if (discordClients.size > 0) {
    const configuredBots = getConfiguredDiscordRuntimeBots();
    const hasMissingClient = configuredBots.some((bot) => !discordClients.has(bot.workspaceId));
    if (hasMissingClient) {
      log.debug("Discord runtime refreshing to include newly configured bots", {
        reason,
        clientCount: discordClients.size,
        configuredTokenCount: configuredBots.length,
      });
      return startDiscordRuntimeInternal(`${reason}:refresh`);
    }

    log.debug("Discord runtime start skipped; already running", {
      reason,
      clientCount: discordClients.size,
    });
  }
  return discordRuntimeController.start(reason);
}

export async function stopDiscordRuntime(reason: string): Promise<void> {
  await discordRuntimeController.stop(reason);
}

const discordRuntimeController = createRuntimeController({
  isRunning: () => discordClients.size > 0,
  startInternal: startDiscordRuntimeInternal,
  stopInternal: async (reason: string) => {
    for (const client of discordClients.values()) {
      client.destroy();
    }
    discordClients.clear();
    discordClientByProcessorId.clear();
    discordProcessorManager.clear();
    statusMessageIndex.clear();
    log.debug("Discord runtime stopped", { reason });
  },
});

export async function recoverPendingRequests(options?: { startedBeforeMs?: number }): Promise<void> {
  await discordRecoveryRuntime.recoverPendingRequests(options);
}
