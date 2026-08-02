import Redis from "ioredis";
import { log } from "@/utils";
import {
  isAgentProviderId,
  type AgentProviderId,
} from "@/shared/agent-provider";

let redis: Redis | null = null;

export type SessionAgentProvider = AgentProviderId;

function getSessionEventsKey(redisSessionId: string): string {
  return `session:events:${redisSessionId}`;
}

function getSessionMetaKey(redisSessionId: string): string {
  return `session:meta:${redisSessionId}`;
}


export interface SessionEvent {
  timestamp: number;
  type: string;
  sessionId: string;
  agentProvider: SessionAgentProvider;
  channelId: string;
  threadId: string;
  data: Record<string, unknown>;
}

export interface SessionMeta {
  sessionId: string;
  agentProvider: SessionAgentProvider;
  channelId: string;
  threadId: string;
  workingDirectory: string;
  createdAt: number;
  lastActivityAt: number;
  initialPrompt?: string;
  threadOwnerUserId?: string;
  slackAppId?: string;
}

interface GetSessionEventsOptions {
  since?: number;
  limit?: number;
}

type HarnessRunMetaRecord = {
  runId: string;
  provider: string;
  prompt?: string;
  cwd: string;
  channelId: string;
  threadId: string;
  sessionId: string;
  startedAt: number;
  completedAt?: number;
  eventCount?: number;
};

type HarnessCapturedEventRecord = {
  runId: string;
  timestamp: number;
  index: number;
  event: unknown;
};

const HARNESS_PREFIX = "harness:live_status";

function getHarnessRunsIndexKey(): string {
  return `${HARNESS_PREFIX}:runs:index`;
}

function getHarnessRunMetaKey(runId: string): string {
  return `${HARNESS_PREFIX}:runs:${runId}:meta`;
}

function getHarnessRunEventsKey(runId: string): string {
  return `${HARNESS_PREFIX}:runs:${runId}:events`;
}

function toAgentProvider(provider: string | undefined): SessionAgentProvider {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "claude") return "claudecode";
  if (isAgentProviderId(normalized)) {
    return normalized;
  }
  return "opencode";
}

function parseHarnessRunMeta(raw: string | null): HarnessRunMetaRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HarnessRunMetaRecord>;
    if (
      typeof parsed.runId !== "string"
      || typeof parsed.channelId !== "string"
      || typeof parsed.threadId !== "string"
      || typeof parsed.cwd !== "string"
      || typeof parsed.startedAt !== "number"
    ) {
      return null;
    }
    return {
      runId: parsed.runId,
      provider: typeof parsed.provider === "string" ? parsed.provider : "opencode",
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined,
      cwd: parsed.cwd,
      channelId: parsed.channelId,
      threadId: parsed.threadId,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : parsed.runId,
      startedAt: parsed.startedAt,
      completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : undefined,
      eventCount: typeof parsed.eventCount === "number" ? parsed.eventCount : undefined,
    };
  } catch {
    return null;
  }
}

function mapHarnessMetaToSession(meta: HarnessRunMetaRecord): SessionMeta {
  return {
    sessionId: meta.runId,
    agentProvider: toAgentProvider(meta.provider),
    channelId: meta.channelId,
    threadId: meta.threadId,
    workingDirectory: meta.cwd,
    createdAt: meta.startedAt,
    lastActivityAt: meta.completedAt ?? meta.startedAt,
    initialPrompt: meta.prompt,
  };
}

function toSessionEventType(event: unknown): string {
  if (!event || typeof event !== "object") return "unknown";
  const record = event as Record<string, unknown>;
  const payload = record.payload;
  if (payload && typeof payload === "object") {
    const payloadRecord = payload as Record<string, unknown>;
    if (typeof payloadRecord.type === "string" && payloadRecord.type) {
      return payloadRecord.type;
    }
  }
  return typeof record.type === "string" && record.type ? record.type : "unknown";
}

export function getRedisClient(): Redis {
  if (!redis) {
    redis = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
    });

    redis.on("error", (err: Error) => {
      log.error("Redis connection error", { error: String(err) });
    });

    redis.on("connect", () => {
      log.info("Redis connected");
    });

    void redis.connect().catch((err: Error) => {
      log.error("Failed to connect to Redis", { error: String(err) });
    });
  }
  return redis;
}


export async function getSessionEvents(
  sessionId: string,
  options: GetSessionEventsOptions = {}
): Promise<SessionEvent[]> {
  try {
    const client = getRedisClient();
    const key = getSessionEventsKey(sessionId);
    const since =
      typeof options.since === "number" && Number.isFinite(options.since)
        ? Math.floor(options.since)
        : null;
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : null;

    const events = since !== null
      ? limit !== null
        ? await client.zrangebyscore(key, `(${since}`, "+inf", "LIMIT", 0, limit)
        : await client.zrangebyscore(key, `(${since}`, "+inf")
      : limit !== null
        ? await client.zrange(key, -limit, -1)
        : await client.zrange(key, 0, -1);

    return events.map((eventStr: string) => JSON.parse(eventStr) as SessionEvent);
  } catch (err) {
    log.error("Failed to get session events", { sessionId, error: String(err) });
    return [];
  }
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const client = getRedisClient();
    const key = getSessionMetaKey(sessionId);
    const data = await client.hgetall(key);
    if (
      !data ||
      !data.sessionId ||
      !data.channelId ||
      !data.threadId ||
      !data.workingDirectory ||
      !data.createdAt ||
      !data.lastActivityAt
    ) {
      return null;
    }
    const providerRaw = data.agentProvider;
    const inferredAgentProvider: SessionAgentProvider =
      providerRaw === "kilo" || data.sessionId.startsWith("kilo_")
        ? "kilo"
        : providerRaw === "kimi" || data.sessionId.startsWith("kimi_")
        ? "kimi"
        : providerRaw === "qwen" || data.sessionId.startsWith("qwen_")
        ? "qwen"
        : providerRaw === "goose" || data.sessionId.startsWith("goose_")
        ? "goose"
        : providerRaw === "codex" || data.sessionId.startsWith("codex_")
        ? "codex"
        : providerRaw === "claudecode" || providerRaw === "claude" || data.sessionId.startsWith("claude_") || data.sessionId.startsWith("claudecode_")
          ? "claudecode"
          : "opencode";
    return {
      sessionId: data.sessionId,
      agentProvider: inferredAgentProvider,
      channelId: data.channelId,
      threadId: data.threadId,
      workingDirectory: data.workingDirectory,
      createdAt: parseInt(data.createdAt, 10),
      lastActivityAt: parseInt(data.lastActivityAt, 10),
      initialPrompt: data.initialPrompt || undefined,
      threadOwnerUserId: data.threadOwnerUserId || undefined,
      slackAppId: data.slackAppId || undefined,
    };
  } catch (err) {
    log.error("Failed to get session meta", { sessionId, error: String(err) });
    return null;
  }
}

export async function getAllSessions(): Promise<SessionMeta[]> {
  try {
    const client = getRedisClient();
    const sessionIds = await client.zrevrange("sessions:all", 0, -1);
    const sessions: SessionMeta[] = [];
    for (const sessionId of sessionIds) {
      const meta = await getSessionMeta(sessionId);
      if (meta) sessions.push(meta);
    }
    return sessions;
  } catch (err) {
    log.error("Failed to get all sessions", { error: String(err) });
    return [];
  }
}

export async function getHarnessRunsAsSessions(): Promise<SessionMeta[]> {
  try {
    const client = getRedisClient();
    const runIds = await client.zrevrange(getHarnessRunsIndexKey(), 0, -1);
    if (runIds.length === 0) return [];

    const sessions: SessionMeta[] = [];
    for (const runId of runIds) {
      const raw = await client.get(getHarnessRunMetaKey(runId));
      const meta = parseHarnessRunMeta(raw);
      if (!meta) continue;
      sessions.push(mapHarnessMetaToSession(meta));
    }

    return sessions;
  } catch (err) {
    log.debug("Harness runs unavailable", { error: String(err) });
    return [];
  }
}

export async function getHarnessRunMetaAsSession(runId: string): Promise<SessionMeta | null> {
  try {
    const client = getRedisClient();
    const raw = await client.get(getHarnessRunMetaKey(runId));
    const meta = parseHarnessRunMeta(raw);
    if (!meta) return null;
    return mapHarnessMetaToSession(meta);
  } catch (err) {
    log.debug("Harness run meta unavailable", { runId, error: String(err) });
    return null;
  }
}

export async function getHarnessRunEventsAsSession(
  runId: string,
  options: GetSessionEventsOptions = {}
): Promise<SessionEvent[]> {
  try {
    const client = getRedisClient();
    const [rawMeta, rawEvents] = await Promise.all([
      client.get(getHarnessRunMetaKey(runId)),
      client.lrange(getHarnessRunEventsKey(runId), 0, -1),
    ]);

    const meta = parseHarnessRunMeta(rawMeta);
    if (!meta || rawEvents.length === 0) return [];

    const since =
      typeof options.since === "number" && Number.isFinite(options.since)
        ? Math.floor(options.since)
        : null;
    const limit =
      typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : null;

    let events = rawEvents
      .map((entry) => {
        try {
          return JSON.parse(entry) as HarnessCapturedEventRecord;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is HarnessCapturedEventRecord => Boolean(entry))
      .sort((a, b) => a.index - b.index)
      .filter((entry) => (since !== null ? entry.timestamp > since : true));

    if (since === null && limit !== null && events.length > limit) {
      events = events.slice(-limit);
    }

    return events.map((entry) => ({
      timestamp: entry.timestamp,
      type: toSessionEventType(entry.event),
      sessionId: runId,
      agentProvider: toAgentProvider(meta.provider),
      channelId: meta.channelId,
      threadId: meta.threadId,
      data: entry.event && typeof entry.event === "object"
        ? entry.event as Record<string, unknown>
        : { value: entry.event },
    }));
  } catch (err) {
    log.debug("Harness run events unavailable", { runId, error: String(err) });
    return [];
  }
}
