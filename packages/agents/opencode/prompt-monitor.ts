export const DEFAULT_OPENCODE_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENCODE_HEALTH_POLL_MS = 5_000;

export class OpenCodeIdlePromptError extends Error {
  constructor(timeoutMs: number) {
    super(
      `OpenCode stopped reporting an active session and produced no progress for ${Math.round(timeoutMs / 1000)}s`
    );
    this.name = "OpenCodeIdlePromptError";
  }
}

export type OpenCodePromptHealth = {
  relatedSessionIds: readonly string[];
  lastMeaningfulEventAt: number;
  awaitingInteraction: boolean;
  statuses: Record<string, unknown>;
};

function statusIsActive(value: unknown): boolean {
  if (typeof value === "string") return value === "busy" || value === "retry";
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>).type;
  return type === "busy" || type === "retry";
}

export function isOpenCodePromptIdleTimedOut(params: {
  health: OpenCodePromptHealth;
  now: number;
  timeoutMs: number;
}): boolean {
  const { health, now, timeoutMs } = params;
  if (health.awaitingInteraction) return false;
  if (now - health.lastMeaningfulEventAt < timeoutMs) return false;
  return !health.relatedSessionIds.some((sessionId) => statusIsActive(health.statuses[sessionId]));
}

export async function monitorOpenCodePrompt<T>(params: {
  prompt: Promise<T>;
  readHealth: () => Promise<OpenCodePromptHealth | null>;
  abort: () => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_OPENCODE_IDLE_TIMEOUT_MS;
  const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_OPENCODE_HEALTH_POLL_MS;
  let settled = false;

  const prompt = params.prompt.finally(() => {
    settled = true;
  });
  const monitor = (async (): Promise<never> => {
    while (!settled) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      if (settled) break;
      const health = await params.readHealth();
      if (!health) continue;
      if (!isOpenCodePromptIdleTimedOut({ health, now: Date.now(), timeoutMs })) continue;
      await params.abort();
      throw new OpenCodeIdlePromptError(timeoutMs);
    }
    return await new Promise<never>(() => {});
  })();

  try {
    return await Promise.race([prompt, monitor]);
  } finally {
    settled = true;
  }
}
