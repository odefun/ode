import { createAgentAdapter } from "@/agents/adapter";
import type { OpenCodeMessageContext } from "@/agents/types";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  getChannelAgentProvider,
  getChannelSystemMessage,
  getGitHubInfoForUser,
  getLarkAppCredentials,
  getLarkTargetChannels,
  getUserGeneralSettings,
  parseStatusMessageFrequencyMs,
  setChannelAgentProvider,
  setChannelBaseBranch,
  setChannelModel,
  setChannelSystemMessage,
  setChannelWorkingDirectory,
  setGitHubInfoForUser,
  setUserGeneralSettings,
  type StatusMessageFormat,
  getWorkspaces,
} from "@/config";
import { findReplyThreadIdByStatusMessageTs } from "@/config/local/sessions";
import {
  isThreadActive,
  loadSession,
  markThreadActive,
} from "@/config/local/sessions";
import { createCoreRuntime } from "@/core/runtime";
import type { IMAdapter } from "@/core/types";
import { log } from "@/utils";
import {
  parseIncomingCommand,
} from "@/ims/shared/incoming-message-processor";
import {
  createProcessorId,
} from "@/ims/shared/processor-id";
import { createRuntimeController } from "@/ims/shared/runtime-controller";
import {
  buildLarkSettingsDetailCard,
  resolveLarkSettingsCardAction,
  sendLarkSettingsCard,
} from "./settings";
import { refreshSettingsProviderData } from "@/ims/shared/settings-provider-data";
import { createProcessorManager } from "@/ims/shared/processor-manager";
import { isSyntheticOwner } from "@/ims/shared/synthetic-owner";
import {
  extractFormValues,
  firstNonEmptyString,
  pickActionSelectedOption,
  pickFormValue,
  pickValueField,
} from "@/ims/lark/utils/card-action-utils";
import { LarkRuntimeState } from "@/ims/lark/state/runtime-state";
import type { RawInboundEvent } from "@/core/model/raw-inbound-event";

let larkRuntimeStarted = false;

type LarkCredentials = {
  workspaceId: string;
  appId: string;
  appSecret: string;
};

type LarkMessageResponse = {
  message_id?: string;
};

type LarkMessageType = "text" | "interactive" | "post";

type LarkBotInfoResponse = {
  bot?: {
    open_id?: string;
  };
};

const larkRuntimeState = new LarkRuntimeState();
const wsClientRegistry = new Map<string, unknown>();
const larkCredentialsByProcessorId = new Map<string, LarkCredentials>();
const larkProcessorManager = createProcessorManager({
  createRuntime: (processorId) => createCoreRuntime({
    platform: "lark",
    im: createLarkAdapter(processorId),
    agent: createAgentAdapter(),
  }),
});
const MAX_LARK_MESSAGE_EDITS = 20;

function getLarkProcessorRuntime(processorId: string): ReturnType<typeof createCoreRuntime> {
  return larkProcessorManager.getRuntime(processorId);
}

function getConfiguredLarkCredentials(): LarkCredentials[] {
  const uniqueCredentials = new Map<string, LarkCredentials>();
  for (const workspace of getLarkAppCredentials()) {
    if (!uniqueCredentials.has(workspace.appId)) {
      uniqueCredentials.set(workspace.appId, {
        workspaceId: workspace.workspaceId,
        appId: workspace.appId,
        appSecret: workspace.appSecret,
      });
    }
  }
  return Array.from(uniqueCredentials.values());
}

function hasMissingLarkLongConnectionClient(): boolean {
  if (!isLarkLongConnectionEnabled()) {
    return false;
  }
  const configuredCredentials = getConfiguredLarkCredentials();
  return configuredCredentials.some((entry) => !wsClientRegistry.has(entry.appId));
}

function isLarkEventDebugEnabled(): boolean {
  const raw = process.env.LARK_DEBUG_EVENTS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function logLarkEvent(message: string, payload: Record<string, unknown>): void {
  if (!isLarkEventDebugEnabled()) return;
  log.debug(message, payload);
}

function getLarkCredentialsForChannel(channelId: string): LarkCredentials | null {
  const channel = channelId.trim();

  if (channel.length > 0) {
    for (const workspace of getWorkspaces()) {
      if (workspace.type !== "lark") continue;
      const appId = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      const appSecret = workspace.larkAppSecret?.trim() ?? "";
      if (!appId || !appSecret) continue;
      if (workspace.channelDetails.some((entry) => entry.id === channel)) {
        return {
          workspaceId: workspace.id,
          appId,
          appSecret,
        };
      }
    }
  }

  const first = getLarkAppCredentials()[0];
  if (!first) return null;
  return {
    workspaceId: first.workspaceId,
    appId: first.appId,
    appSecret: first.appSecret,
  };
}

function registerLarkProcessorCredentials(processorId: string, creds: LarkCredentials): void {
  if (!processorId || !creds.appId || !creds.appSecret) return;
  larkCredentialsByProcessorId.set(processorId, creds);
}

function getLarkCredentialsForProcessor(processorId: string | undefined, channelId: string): LarkCredentials | null {
  const normalizedProcessorId = processorId?.trim() || "";
  if (normalizedProcessorId) {
    const mapped = larkCredentialsByProcessorId.get(normalizedProcessorId);
    if (mapped) return mapped;
  }
  return getLarkCredentialsForChannel(channelId);
}

async function getLarkTenantAccessToken(creds: LarkCredentials): Promise<string> {
  const cached = larkRuntimeState.getTenantToken(creds.workspaceId);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 30_000) {
    return cached.token;
  }

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  if (!response.ok) {
    throw new Error(`Lark token API ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if ((payload.code ?? -1) !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || "Failed to get Lark tenant access token");
  }

  const ttlSec = typeof payload.expire === "number" ? payload.expire : 3600;
  larkRuntimeState.setTenantToken(creds.workspaceId, {
    token: payload.tenant_access_token,
    expiresAt: now + Math.max(ttlSec - 30, 30) * 1000,
  });
  return payload.tenant_access_token;
}

async function larkApi<T>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`https://open.feishu.cn${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Lark API ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as {
    code?: number;
    msg?: string;
    data?: T;
    [key: string]: unknown;
  };
  if ((payload.code ?? -1) !== 0) {
    throw new Error(payload.msg || "Lark API error");
  }
  if (payload.data !== undefined) {
    return payload.data as T;
  }
  return payload as unknown as T;
}

async function sendLarkMessage(params: {
  channelId: string;
  threadId: string;
  msgType: LarkMessageType;
  content: Record<string, unknown>;
  creds?: LarkCredentials;
}): Promise<string | undefined> {
  const rawChannelId = params.channelId;
  const creds = params.creds ?? getLarkCredentialsForChannel(params.channelId);
  if (!creds) {
    log.warn("No Lark credentials available for sendLarkMessage", { channelId: rawChannelId });
    return undefined;
  }

  const token = await getLarkTenantAccessToken(creds);
  const data = params.threadId
    ? await larkApi<LarkMessageResponse>(
      token,
      "POST",
      `/open-apis/im/v1/messages/${encodeURIComponent(params.threadId)}/reply`,
      {
        msg_type: params.msgType,
        content: JSON.stringify(params.content),
        reply_in_thread: true,
      }
    )
    : await larkApi<LarkMessageResponse>(
      token,
      "POST",
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      {
        receive_id: rawChannelId,
        msg_type: params.msgType,
        content: JSON.stringify(params.content),
      }
    );

  const messageId = data.message_id;
  if (messageId) {
    larkRuntimeState.setMessageThread(messageId, {
      channelId: rawChannelId,
      threadId: params.threadId,
    });
  }
  return messageId;
}

function buildLarkPostContent(text: string): Record<string, unknown> {
  const block = [{ tag: "md", text }];
  return {
    zh_cn: {
      title: "",
      content: [block],
    },
    en_us: {
      title: "",
      content: [block],
    },
  };
}

function stripLarkMentionMarkup(text: string): string {
  return text
    .replace(/<at\b[^>]*>.*?<\/at>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLarkText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "string") {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.content === "string") {
        return record.content;
      }
      const localized = (record.zh_cn ?? record.en_us) as Record<string, unknown> | undefined;
      const postBlocks = localized?.content;
      if (Array.isArray(postBlocks)) {
        const lines: string[] = [];
        for (const row of postBlocks) {
          if (!Array.isArray(row)) continue;
          const line = row
            .map((cell) => {
              if (!cell || typeof cell !== "object") return "";
              const textValue = (cell as Record<string, unknown>).text;
              return typeof textValue === "string" ? textValue : "";
            })
            .join("");
          if (line.trim()) lines.push(line);
        }
        if (lines.length > 0) return lines.join("\n");
      }
    }
    return content;
  } catch {
    return content;
  }
}

async function buildLarkContext(
  channelId: string,
  threadId: string,
  userId: string,
  threadHistory?: string | null
): Promise<OpenCodeMessageContext> {
  return {
    threadHistory: threadHistory ?? undefined,
    slack: {
      platform: "lark",
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
  const creds = getLarkCredentialsForProcessor(processorId, channelId);
  if (!creds) return undefined;
  return sendLarkMessage({
    channelId,
    threadId: threadId || "",
    msgType: "post",
    content: buildLarkPostContent(text),
    creds,
  });
}

export async function sendChannelMessage(
  channelId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  const creds = getLarkCredentialsForProcessor(processorId, channelId);
  if (!creds) return undefined;
  return sendLarkMessage({
    channelId,
    threadId: "",
    msgType: "post",
    content: buildLarkPostContent(text),
    creds,
  });
}

async function sendSettingsCard(channelId: string, threadId: string, userId = ""): Promise<string | undefined> {
  const routeThreadId = threadId || "";
  return sendLarkSettingsCard({
    channelId,
    threadId: routeThreadId,
    userId,
    sendInteractive: (card) =>
      sendLarkMessage({
        channelId,
        threadId: routeThreadId,
        msgType: "interactive",
        content: card,
      }),
    sendText: (text) => sendMessage(channelId, routeThreadId, text),
    logEvent: logLarkEvent,
  });
}

async function updateMessage(
  channelId: string,
  messageId: string,
  text: string,
  processorId?: string
): Promise<string | undefined> {
  const rawChannelId = channelId;
  const creds = getLarkCredentialsForProcessor(processorId, channelId);
  if (!creds) return;
  const token = await getLarkTenantAccessToken(creds);

  const editCount = larkRuntimeState.getMessageEditCount(messageId);
  if (editCount >= MAX_LARK_MESSAGE_EDITS) {
    const trackedThreadId = larkRuntimeState.getMessageThread(messageId)?.threadId || findReplyThreadIdByStatusMessageTs(messageId) || "";
    try {
      await deleteMessage(channelId, messageId, processorId);
      const replacementMessageId = await sendMessage(channelId, trackedThreadId, text, processorId);
      if (replacementMessageId) {
        larkRuntimeState.moveMessageEditCount(messageId, replacementMessageId);
        log.info("Lark message edit limit reached; replaced status message", {
          channelId: rawChannelId,
          oldMessageId: messageId,
          newMessageId: replacementMessageId,
          editCount,
        });
        return replacementMessageId;
      }
      log.warn("Lark message edit limit reached but replacement send failed", {
        channelId: rawChannelId,
        messageId,
        editCount,
      });
    } catch (error) {
      log.warn("Failed to replace Lark message after edit limit reached", {
        channelId: rawChannelId,
        messageId,
        editCount,
        error: String(error),
      });
    }
  }

  const payload = {
    msg_type: "post",
    content: JSON.stringify(buildLarkPostContent(text)),
  };

  try {
    await larkApi<Record<string, unknown>>(
      token,
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      payload
    );
    larkRuntimeState.setMessageEditCount(messageId, editCount + 1);
    return;
  } catch (error) {
    const patchMessage = error instanceof Error ? error.message : String(error);
    const patchNormalized = patchMessage.toLowerCase();
    if (patchNormalized.includes("429") || patchNormalized.includes("rate limit") || patchNormalized.includes("ratelimit")) {
      log.warn("Lark message update rate limited", {
        channelId: rawChannelId,
        messageId,
        error: patchMessage,
      });
      throw error;
    }
    if (!patchMessage.includes("400")) {
      log.warn("Failed to update Lark message", {
        channelId: rawChannelId,
        messageId,
        error: patchMessage,
      });
      return;
    }

    try {
      await larkApi<Record<string, unknown>>(
        token,
        "PUT",
        `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        payload
      );
       larkRuntimeState.setMessageEditCount(messageId, editCount + 1);
      return;
    } catch (fallbackError) {
      const fallbackMessage = String(fallbackError);
      const fallbackNormalized = fallbackMessage.toLowerCase();
      if (fallbackNormalized.includes("429") || fallbackNormalized.includes("rate limit") || fallbackNormalized.includes("ratelimit")) {
        log.warn("Lark message update fallback rate limited", {
          channelId: rawChannelId,
          messageId,
          error: fallbackMessage,
        });
        throw fallbackError;
      }
      log.warn("Failed to update Lark message with PATCH/POST fallback", {
        channelId: rawChannelId,
        messageId,
        error: fallbackMessage,
      });
    }

    log.warn("Failed to update Lark message", {
      channelId: rawChannelId,
      messageId,
      error: patchMessage,
    });
  }
}

async function deleteMessage(channelId: string, messageId: string, processorId?: string): Promise<void> {
  const creds = getLarkCredentialsForProcessor(processorId, channelId);
  if (!creds) return;
  const token = await getLarkTenantAccessToken(creds);
  try {
    await larkApi<Record<string, unknown>>(
      token,
      "DELETE",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    );
    larkRuntimeState.deleteMessageThread(messageId);
    larkRuntimeState.deleteMessageEditCount(messageId);
  } catch {
    // Ignore delete failures
  }
}

async function fetchThreadHistory(
  channelId: string,
  threadId: string,
  messageId: string,
  processorId?: string
): Promise<string | null> {
  const rawChannelId = channelId;
  const creds = getLarkCredentialsForProcessor(processorId, channelId);
  if (!creds) return null;
  const token = await getLarkTenantAccessToken(creds);
  try {
    let threadConversationId = "";
    try {
      const rootData = await larkApi<{ items?: Array<Record<string, unknown>> }>(
        token,
        "GET",
        `/open-apis/im/v1/messages/${encodeURIComponent(threadId)}`
      );
      const rootItem = Array.isArray(rootData.items) ? rootData.items[0] : null;
      threadConversationId = typeof rootItem?.thread_id === "string" ? rootItem.thread_id : "";
    } catch {
      threadConversationId = "";
    }

    const data = await larkApi<{ items?: Array<Record<string, unknown>> }>(
      token,
      "GET",
      `/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(rawChannelId)}&page_size=50`
    );
    const lines = (data.items ?? [])
      .filter((message) => {
        const messageId = typeof message.message_id === "string" ? message.message_id : "";
        const rootId = typeof message.root_id === "string" ? message.root_id : "";
        const parentId = typeof message.parent_id === "string" ? message.parent_id : "";
        const itemThreadId = typeof message.thread_id === "string" ? message.thread_id : "";
        if (threadConversationId) {
          return itemThreadId === threadConversationId;
        }
        return messageId === threadId || rootId === threadId || parentId === threadId;
      })
      .filter((message) => {
        const currentMessageId = typeof message.message_id === "string" ? message.message_id : "";
        return currentMessageId && currentMessageId !== messageId;
      })
      .map((message) => {
        const sender = (message.sender as Record<string, unknown> | undefined)?.sender_id as Record<string, unknown> | undefined;
        const author = typeof sender?.open_id === "string" ? sender.open_id : "unknown";
        const body = message.body as Record<string, unknown> | undefined;
        const text = parseLarkText(typeof body?.content === "string" ? body.content : undefined);
        return text ? `${author}: ${text}` : "";
      })
      .filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function createLarkAdapter(processorId?: string): IMAdapter {
  return {
    maxEditableMessageChars: 30_000,
    sendMessage: (channelId: string, threadId: string, text: string) =>
      sendMessage(channelId, threadId, text, processorId),
    updateMessage: (channelId: string, messageId: string, text: string) =>
      updateMessage(channelId, messageId, text, processorId),
    deleteMessage: (channelId: string, messageId: string) =>
      deleteMessage(channelId, messageId, processorId),
    fetchThreadHistory: (channelId: string, threadId: string, messageId: string) =>
      fetchThreadHistory(channelId, threadId, messageId, processorId),
    buildAgentContext: async ({ channelId, threadId, userId, threadHistory }) =>
      buildLarkContext(channelId, threadId, userId, threadHistory),
  };
}

const larkAdapter: IMAdapter = createLarkAdapter();

const larkRecoveryRuntime = createCoreRuntime({
  platform: "lark",
  im: larkAdapter,
  agent: createAgentAdapter(),
});

async function getBotOpenIdForChannel(channelId: string): Promise<string | null> {
  const creds = getLarkCredentialsForChannel(channelId);
  if (!creds) return null;
  const cached = larkRuntimeState.getBotOpenId(creds.workspaceId);
  if (cached) return cached;
  const token = await getLarkTenantAccessToken(creds);
  const data = await larkApi<LarkBotInfoResponse>(token, "GET", "/open-apis/bot/v3/info");
  const openId = data.bot?.open_id?.trim();
  if (openId) {
    larkRuntimeState.setBotOpenId(creds.workspaceId, openId);
    return openId;
  }
  logLarkEvent("Lark bot open_id missing from bot/v3/info response", {
    channelId,
    workspaceId: creds.workspaceId,
    appId: creds.appId,
    responseKeys: Object.keys((data as Record<string, unknown>) ?? {}),
  });
  return null;
}

function isAuthorizedLarkChannel(channelId: string): boolean {
  const targets = getLarkTargetChannels();
  if (!targets) return true;
  return targets.includes(channelId);
}

function parseMentionedOpenIds(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  const ids: string[] = [];
  for (const mention of mentions) {
    if (!mention || typeof mention !== "object") continue;
    const record = mention as Record<string, unknown>;

    const directOpenId = record.open_id;
    if (typeof directOpenId === "string" && directOpenId.trim().length > 0) {
      ids.push(directOpenId.trim());
    }

    const directUserId = record.user_id;
    if (typeof directUserId === "string" && directUserId.trim().length > 0) {
      ids.push(directUserId.trim());
    }

    const directKey = record.key;
    if (typeof directKey === "string" && directKey.trim().length > 0) {
      ids.push(directKey.trim());
    }

    const idValue = record.id;
    if (typeof idValue === "string" && idValue.trim().length > 0) {
      ids.push(idValue.trim());
      continue;
    }

    const idRecord = idValue;
    if (!idRecord || typeof idRecord !== "object") continue;
    const openId = (idRecord as Record<string, unknown>).open_id;
    if (typeof openId === "string" && openId.trim().length > 0) {
      ids.push(openId.trim());
    }

    const userId = (idRecord as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim().length > 0) {
      ids.push(userId.trim());
    }
  }
  return Array.from(new Set(ids));
}

function isBotMentionedInText(rawText: string, botOpenId: string): boolean {
  if (!rawText || !botOpenId) return false;
  const escaped = botOpenId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<at\\b[^>]*(?:open_id|user_id|id)\\s*=\\s*"${escaped}"[^>]*>`, "i");
  return pattern.test(rawText);
}

type LarkIncomingEnvelope = {
  type?: string;
  challenge?: string;
  header?: {
    event_type?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
    message?: {
      chat_id?: string;
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      message_type?: string;
      content?: string;
      mentions?: unknown;
    };
  };
};

type LarkCardActionEnvelope = {
  action?: {
    value?: unknown;
  };
  open_chat_id?: string;
  chat_id?: string;
  open_message_id?: string;
  message_id?: string;
  open_id?: string;
  user_id?: string;
  event?: {
    action?: {
      value?: unknown;
    };
    context?: {
      open_chat_id?: string;
      chat_id?: string;
      open_message_id?: string;
      message_id?: string;
    };
    operator?: {
      open_id?: string;
      user_id?: string;
    };
  };
};

type LarkIncomingEvent = NonNullable<LarkIncomingEnvelope["event"]>;

async function processLarkCardAction(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== "object") return;
  const envelope = payload as LarkCardActionEnvelope;
  const value = envelope.event?.action?.value ?? envelope.action?.value;
  const action = resolveLarkSettingsCardAction(value);
  if (!action) return;

  const channelId = firstNonEmptyString(
    envelope.event?.context?.open_chat_id,
    envelope.event?.context?.chat_id,
    envelope.open_chat_id,
    envelope.chat_id,
    pickValueField(value, "channel_id"),
    pickValueField(value, "channelId")
  );
  const sourceMessageId = firstNonEmptyString(
    envelope.event?.context?.open_message_id,
    envelope.event?.context?.message_id,
    envelope.open_message_id,
    envelope.message_id
  );
  const threadId = firstNonEmptyString(
    pickValueField(value, "thread_id"),
    pickValueField(value, "threadId"),
    sourceMessageId
  );
  const userId = firstNonEmptyString(
    envelope.event?.operator?.open_id,
    envelope.event?.operator?.user_id,
    envelope.open_id,
    envelope.user_id,
    pickValueField(value, "user_id"),
    pickValueField(value, "userId")
  );

  if (
    action === "set_general_settings"
    ||
    action === "set_general_status_format"
    || action === "set_general_status_frequency"
    || action === "set_general_git_strategy"
    || action === "set_general_auto_update"
  ) {
    const current = getUserGeneralSettings();
    if (action === "set_general_settings") {
      const formValues = extractFormValues(payload);
      const format = pickFormValue(formValues, "statusFormat");
      const frequency = pickFormValue(formValues, "statusFrequencyMs");
      const gitStrategy = pickFormValue(formValues, "gitStrategy");
      const autoUpdate = pickFormValue(formValues, "autoUpdate");

      if (format.exists && (format.value === "minimum" || format.value === "medium" || format.value === "aggressive")) {
        current.defaultStatusMessageFormat = format.value as StatusMessageFormat;
      }

      if (frequency.exists) {
        const parsed = Number(frequency.value);
        if (Number.isFinite(parsed) && parsed > 0) {
          current.statusMessageFrequencyMs = parseStatusMessageFrequencyMs(parsed);
        }
      }

      if (gitStrategy.exists) {
        current.gitStrategy = gitStrategy.value === "default" ? "default" : "worktree";
      }

      if (autoUpdate.exists) {
        const normalized = autoUpdate.value.toLowerCase();
        current.autoUpdate = !(normalized === "off" || normalized === "false" || normalized === "0");
      }
    } else if (action === "set_general_status_format") {
      const format = firstNonEmptyString(
        pickValueField(value, "status_format"),
        pickValueField(value, "statusFormat"),
        pickActionSelectedOption(payload)
      );
      if (format === "minimum" || format === "medium" || format === "aggressive") {
        current.defaultStatusMessageFormat = format as StatusMessageFormat;
      }
    } else if (action === "set_general_status_frequency") {
      const raw = firstNonEmptyString(
        pickValueField(value, "status_frequency_ms"),
        pickValueField(value, "statusFrequencyMs"),
        pickActionSelectedOption(payload)
      );
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        current.statusMessageFrequencyMs = parseStatusMessageFrequencyMs(parsed);
      }
    } else if (action === "set_general_git_strategy") {
      const strategy = firstNonEmptyString(
        pickValueField(value, "git_strategy"),
        pickValueField(value, "gitStrategy"),
        pickActionSelectedOption(payload)
      );
      current.gitStrategy = strategy === "default" ? "default" : "worktree";
    } else if (action === "set_general_auto_update") {
      const autoUpdate = firstNonEmptyString(
        pickValueField(value, "auto_update"),
        pickValueField(value, "autoUpdate"),
        pickActionSelectedOption(payload)
      ).toLowerCase();
      current.autoUpdate = !(autoUpdate === "off" || autoUpdate === "false" || autoUpdate === "0");
    }
    setUserGeneralSettings(current);
  }

  if (action === "set_channel_settings") {
    const formValues = extractFormValues(payload);
    const selected = pickActionSelectedOption(payload);
    const field = firstNonEmptyString(
      pickValueField(value, "field")
    );
    const formModel = pickFormValue(formValues, "model");
    const formWorkingDirectory = pickFormValue(formValues, "workingDirectory");
    const formBaseBranch = pickFormValue(formValues, "baseBranch");
    const formSystemMessage = pickFormValue(formValues, "channelSystemMessage");
    const provider = firstNonEmptyString(
      pickValueField(value, "provider"),
      field === "provider" ? selected : ""
    );
    if (
      provider === "opencode"
      || provider === "claudecode"
      || provider === "codex"
      || provider === "kimi"
      || provider === "kiro"
      || provider === "kilo"
      || provider === "qwen"
      || provider === "goose"
      || provider === "gemini"
    ) {
      setChannelAgentProvider(channelId, provider);
    }

    const model = formModel.exists
      ? formModel.value
      : firstNonEmptyString(
        pickValueField(value, "model"),
        field === "model" ? selected : ""
      );
    setChannelModel(channelId, model);

    const workingDirectory = formWorkingDirectory.exists
      ? formWorkingDirectory.value
      : firstNonEmptyString(
        pickValueField(value, "working_directory"),
        pickValueField(value, "workingDirectory"),
        field === "workingDirectory" ? selected : ""
      );
    setChannelWorkingDirectory(channelId, workingDirectory || null);

    const baseBranch = formBaseBranch.exists
      ? formBaseBranch.value
      : firstNonEmptyString(
        pickValueField(value, "base_branch"),
        pickValueField(value, "baseBranch"),
        field === "baseBranch" ? selected : ""
      );
    setChannelBaseBranch(channelId, baseBranch || null);

    const channelSystemMessage = formSystemMessage.exists
      ? formSystemMessage.value
      : firstNonEmptyString(
        pickValueField(value, "channel_system_message"),
        pickValueField(value, "channelSystemMessage"),
        field === "channelSystemMessage" ? selected : ""
      );
    setChannelSystemMessage(channelId, channelSystemMessage || null);
  }

  if (action === "set_github_info") {
    const formValues = extractFormValues(payload);
    const selected = pickActionSelectedOption(payload);
    const field = firstNonEmptyString(pickValueField(value, "field"));
    const formGithubToken = pickFormValue(formValues, "githubToken");
    const formGithubName = pickFormValue(formValues, "githubName");
    const formGithubEmail = pickFormValue(formValues, "githubEmail");
    const token = formGithubToken.exists
      ? formGithubToken.value
      : firstNonEmptyString(
        pickValueField(value, "github_token"),
        pickValueField(value, "githubToken"),
        field === "githubToken" ? selected : ""
      );
    const gitName = formGithubName.exists
      ? formGithubName.value
      : firstNonEmptyString(
        pickValueField(value, "git_name"),
        pickValueField(value, "github_name"),
        pickValueField(value, "gitName"),
        pickValueField(value, "githubName"),
        field === "githubName" ? selected : ""
      );
    const gitEmail = formGithubEmail.exists
      ? formGithubEmail.value
      : firstNonEmptyString(
        pickValueField(value, "git_email"),
        pickValueField(value, "github_email"),
        pickValueField(value, "gitEmail"),
        pickValueField(value, "githubEmail"),
        field === "githubEmail" ? selected : ""
      );
    setGitHubInfoForUser(userId || "", {
      token,
      gitName,
      gitEmail,
    });
  }

  if (action === "clear_github_info") {
    setGitHubInfoForUser(userId || "", {
      token: "",
      gitName: "",
      gitEmail: "",
    });
  }

  if (!channelId) {
    logLarkEvent("Lark card action ignored: missing routing ids", {
      channelId,
      threadId,
      sourceMessageId,
      action,
    });
    return;
  }

  const detailAction = (
    action === "set_general_settings"
    || action === "set_general_status_format"
    || action === "set_general_status_frequency"
    || action === "set_general_git_strategy"
    || action === "set_general_auto_update"
    || action === "set_channel_settings"
    || action === "set_github_info"
    || action === "clear_github_info"
  )
    ? (
      action === "set_channel_settings"
        ? "open_settings_modal"
        : action === "set_github_info" || action === "clear_github_info"
          ? "open_github_token_modal"
          : "open_general_settings_modal"
    )
    : action;

  const providerData = detailAction === "open_settings_modal"
    ? await refreshSettingsProviderData(getChannelAgentProvider(channelId))
    : undefined;

  const card = action === "open_settings_launcher"
    ? null
    : buildLarkSettingsDetailCard({
      action: detailAction,
      channelId,
      threadId,
      userId: userId || "",
      providerData,
      notice: (
        action === "set_general_settings"
        ||
        action === "set_general_status_format"
        || action === "set_general_status_frequency"
        || action === "set_general_git_strategy"
        || action === "set_general_auto_update"
        || action === "set_channel_settings"
        || action === "set_github_info"
        || action === "clear_github_info"
      )
        ? (
          action === "set_channel_settings"
            ? "Channel settings updated"
            : action === "set_github_info"
              ? "GitHub settings updated"
              : action === "clear_github_info"
                ? "GitHub settings cleared"
                : "General settings updated"
        )
        : undefined,
    });

  if (!card) {
    await sendSettingsCard(channelId, "", userId);
    return;
  }

  await sendLarkMessage({
    channelId,
    threadId: "",
    msgType: "interactive",
    content: card,
  });
}

function isLarkLongConnectionEnabled(): boolean {
  const raw = process.env.LARK_LONG_CONNECTION?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no"].includes(raw);
}

async function processLarkIncomingEvent(event: LarkIncomingEvent, processorAppId?: string): Promise<void> {
  const message = event.message;
  const senderOpenId = event.sender?.sender_id?.open_id?.trim() || "";
  const channelId = message?.chat_id?.trim() || "";
  const messageId = message?.message_id?.trim() || "";
  const threadId = message?.root_id?.trim() || message?.parent_id?.trim() || messageId;
  const topLevelMessage = !(message?.root_id || message?.parent_id);

  logLarkEvent("Lark inbound event received", {
    channelId,
    messageId,
    threadId,
    senderOpenId,
    messageType: message?.message_type ?? "",
    isThreadReply: !topLevelMessage,
    hasMentions: Array.isArray(message?.mentions),
  });

  if (!channelId || !messageId || !threadId || !senderOpenId) {
    logLarkEvent("Lark inbound ignored: missing required identifiers", {
      channelId,
      messageId,
      threadId,
      senderOpenId,
    });
    return;
  }

  if (!isAuthorizedLarkChannel(channelId)) {
    logLarkEvent("Lark inbound ignored: channel not authorized", { channelId });
    return;
  }

  const inferredAppId = processorAppId ?? getLarkCredentialsForChannel(channelId)?.appId;
  const processorId = createProcessorId("lark", inferredAppId ?? "");
  const mappedCreds = getLarkAppCredentials().find((entry) => entry.appId === inferredAppId)
    ?? getLarkCredentialsForChannel(channelId)
    ?? null;
  if (mappedCreds) {
    registerLarkProcessorCredentials(processorId, mappedCreds);
  }
  const runtime = getLarkProcessorRuntime(processorId);

  const botOpenId = await getBotOpenIdForChannel(channelId);
  const isSelfMessage = Boolean(botOpenId && senderOpenId === botOpenId);

  if (message?.message_type !== "text") {
    logLarkEvent("Lark inbound ignored: non-text message", {
      channelId,
      messageId,
      messageType: message?.message_type ?? "",
    });
    return;
  }

  const rawText = parseLarkText(message?.content);
  const mentions = parseMentionedOpenIds(message?.mentions);
  const isMentioned = botOpenId
    ? (mentions.includes(botOpenId) || isBotMentionedInText(rawText, botOpenId))
    : false;
  const hasAnyMention = mentions.length > 0;
  const active = isThreadActive(channelId, threadId, processorId);
  const threadSession = loadSession(channelId, threadId);
  const text = stripLarkMentionMarkup(rawText);
  const inboundEvent: RawInboundEvent = {
    platform: "lark",
    botId: processorId,
    channelId,
    rawChannelId: channelId,
    threadId,
    replyThreadId: threadId,
    messageId,
    userId: senderOpenId,
    selfMessage: isSelfMessage,
    threadOwnerMessage: isSyntheticOwner(threadSession?.threadOwnerUserId)
      || threadSession?.threadOwnerUserId === senderOpenId,
    isTopLevel: topLevelMessage,
    hasAnyMention,
    mentionedBot: isMentioned,
    activeThread: active,
    ambientMode: false,
    rawText,
    normalizedText: text,
    receivedAtMs: Date.now(),
  };

  logLarkEvent("Lark inbound parsed", {
    channelId,
    messageId,
    botOpenId: botOpenId ?? "",
    rawText,
    mentions,
    mentionCount: mentions.length,
    isMentioned,
    activeThread: active,
    textLength: text.length,
  });

  const command = parseIncomingCommand(text);
  if (command === "setting") {
    logLarkEvent("Lark inbound matched /setting", {
      channelId,
      threadId,
      messageId,
      topLevelMessage,
      isMentioned,
    });
    await sendSettingsCard(channelId, "", senderOpenId);
    return;
  }
  if (!isMentioned && !active) {
    logLarkEvent("Lark inbound ignored: not mentioned and thread inactive", {
      channelId,
      threadId,
      messageId,
      reason: "not_mentioned_and_inactive",
      isTopLevel: topLevelMessage,
      isMentioned,
      activeThread: active,
    });
    return;
  }

  logLarkEvent("Lark inbound accepted: forwarding to core runtime", {
    channelId,
    threadId,
    messageId,
    userId: senderOpenId,
  });
  await runtime.handleInboundEvent(inboundEvent);
  logLarkEvent("Lark inbound handled by core runtime", {
    channelId,
    threadId,
    messageId,
  });
}

async function startLarkLongConnections(reason: string): Promise<void> {
  if (!isLarkLongConnectionEnabled()) {
    log.debug("Lark long connection disabled", { reason });
    return;
  }

  const configuredCredentials = getConfiguredLarkCredentials();

  for (const creds of configuredCredentials) {
    const appId = creds.appId;
    const processorId = createProcessorId("lark", appId);
    registerLarkProcessorCredentials(processorId, creds);
    if (wsClientRegistry.has(appId)) {
      continue;
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        try {
          await processLarkIncomingEvent(data as LarkIncomingEvent, appId);
        } catch (error) {
          log.warn("Failed to handle Lark long-connection message event", {
            appId,
            error: String(error),
          });
        }
      },
      "card.action.trigger": async (data: unknown) => {
        try {
          await processLarkCardAction(data);
        } catch (error) {
          log.warn("Failed to handle Lark long-connection card action", {
            appId,
            error: String(error),
          });
        }
      },
    });

    const wsClient = new Lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      loggerLevel: Lark.LoggerLevel.debug,
    });

    await Promise.resolve(
      wsClient.start({
        eventDispatcher,
      })
    );

    wsClientRegistry.set(appId, wsClient);
    log.debug("Lark long connection started", { appId });
  }
}

async function stopLarkLongConnections(reason: string): Promise<void> {
  const entries = Array.from(wsClientRegistry.entries());
  wsClientRegistry.clear();
  larkCredentialsByProcessorId.clear();
  for (const [appId, client] of entries) {
    try {
      const wsClient = client as { stop?: () => unknown | Promise<unknown> };
      if (typeof wsClient.stop === "function") {
        await Promise.resolve(wsClient.stop());
      }
      log.debug("Lark long connection stopped", { appId, reason });
    } catch (error) {
      log.warn("Failed to stop Lark long connection", {
        appId,
        reason,
        error: String(error),
      });
    }
  }
}

export async function handleLarkEventPayload(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!payload || typeof payload !== "object") {
    logLarkEvent("Lark webhook ignored: invalid payload", {});
    return { status: 400, body: { ok: false, error: "Invalid payload" } };
  }

  const envelope = payload as LarkIncomingEnvelope;
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    logLarkEvent("Lark webhook url_verification", {});
    return { status: 200, body: { challenge: envelope.challenge } };
  }

  const payloadRecord = payload as Record<string, unknown>;
  const payloadEvent = payloadRecord.event && typeof payloadRecord.event === "object"
    ? payloadRecord.event as Record<string, unknown>
    : null;
  const payloadEventAction = payloadEvent?.action && typeof payloadEvent.action === "object"
    ? payloadEvent.action as Record<string, unknown>
    : null;
  const payloadAction = payloadRecord.action && typeof payloadRecord.action === "object"
    ? payloadRecord.action as Record<string, unknown>
    : null;
  const cardAction = resolveLarkSettingsCardAction(payloadEventAction?.value)
    || resolveLarkSettingsCardAction(payloadAction?.value)
    || resolveLarkSettingsCardAction(payloadEventAction)
    || resolveLarkSettingsCardAction(payloadAction);
  if (cardAction) {
    await processLarkCardAction(payload);
    return { status: 200, body: { code: 0 } };
  }

  if (envelope.header?.event_type !== "im.message.receive_v1") {
    if (envelope.header?.event_type === "card.action.trigger") {
      await processLarkCardAction(payload);
      return {
        status: 200,
        body: { code: 0 },
      };
    }

    logLarkEvent("Lark webhook ignored: unsupported event type", {
      eventType: envelope.header?.event_type ?? "",
    });
    return { status: 200, body: { code: 0 } };
  }

  if (envelope.event) {
    const envelopeRecord = envelope as Record<string, unknown>;
    const webhookAppId =
      (typeof envelopeRecord.app_id === "string" && envelopeRecord.app_id.trim().length > 0
        ? envelopeRecord.app_id
        : undefined)
      ?? (typeof payloadRecord.app_id === "string" && payloadRecord.app_id.trim().length > 0 ? payloadRecord.app_id : undefined);
    await processLarkIncomingEvent(envelope.event, webhookAppId);
  }

  return { status: 200, body: { code: 0 } };
}

export async function startLarkRuntime(reason: string): Promise<boolean> {
  if (larkRuntimeStarted) {
    if (hasMissingLarkLongConnectionClient()) {
      log.debug("Lark runtime refreshing to include newly configured apps", {
        reason,
        connectedCount: wsClientRegistry.size,
      });
      await startLarkLongConnections(`${reason}:refresh`);
      return true;
    }

    log.debug("Lark runtime start skipped; already running", { reason });
  }
  return larkRuntimeController.start(reason);
}

export async function stopLarkRuntime(reason: string): Promise<void> {
  await larkRuntimeController.stop(reason);
}

const larkRuntimeController = createRuntimeController({
  isRunning: () => larkRuntimeStarted,
  startInternal: async (reason: string): Promise<boolean> => {
    const workspaces = getLarkAppCredentials();
    if (workspaces.length === 0) {
      log.debug("Lark runtime skipped (Lark app credentials missing)", { reason });
      return false;
    }
    larkRuntimeStarted = true;
    larkRuntimeState.clear();
    log.debug("Lark runtime started", {
      reason,
      workspaceCount: workspaces.length,
    });
    await startLarkLongConnections(reason);
    return true;
  },
  stopInternal: async (reason: string): Promise<void> => {
    larkRuntimeStarted = false;
    await stopLarkLongConnections(reason);
    larkRuntimeState.clear();
    larkProcessorManager.clear();
    log.debug("Lark runtime stopped", { reason });
  },
});

export async function recoverPendingRequests(options?: { startedBeforeMs?: number }): Promise<void> {
  await larkRecoveryRuntime.recoverPendingRequests(options);
}
