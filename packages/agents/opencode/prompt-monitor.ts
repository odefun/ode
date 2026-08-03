export const DEFAULT_OPENCODE_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_OPENCODE_HEALTH_POLL_MS = 5_000;
export const DEFAULT_OPENCODE_INTERACTION_TIMEOUT_MS = 30 * 60_000;

export type OpenCodePendingInteractionHealth = {
  requestId: string;
  sessionId: string;
  kind: "question" | "permission";
  askedAt: number;
  permission?: string;
  patterns?: string[];
};

export class OpenCodeIdlePromptError extends Error {
  constructor(timeoutMs: number) {
    super(
      `OpenCode stopped reporting an active session and produced no progress for ${Math.round(timeoutMs / 1000)}s`
    );
    this.name = "OpenCodeIdlePromptError";
  }
}

export class OpenCodeInteractionTimeoutError extends Error {
  readonly interaction: OpenCodePendingInteractionHealth;

  constructor(timeoutMs: number, interaction: OpenCodePendingInteractionHealth) {
    const target = interaction.permission
      ? `permission ${interaction.permission}`
      : interaction.kind;
    const patterns = interaction.patterns?.length
      ? ` for ${interaction.patterns.join(", ")}`
      : "";
    super(
      `OpenCode waited ${Math.round(timeoutMs / 60_000)} minutes for ${target}${patterns}`
    );
    this.name = "OpenCodeInteractionTimeoutError";
    this.interaction = interaction;
  }
}

export type OpenCodePromptHealth = {
  relatedSessionIds: readonly string[];
  lastMeaningfulEventAt: number;
  awaitingInteraction: boolean;
  pendingInteractions?: readonly OpenCodePendingInteractionHealth[];
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

export function getTimedOutOpenCodeInteraction(params: {
  health: OpenCodePromptHealth;
  now: number;
  timeoutMs: number;
}): OpenCodePendingInteractionHealth | null {
  const { health, now, timeoutMs } = params;
  const pending = health.pendingInteractions ?? [];
  return pending.find((interaction) => now - interaction.askedAt >= timeoutMs) ?? null;
}

export async function monitorOpenCodePrompt<T>(params: {
  prompt: Promise<T>;
  readHealth: () => Promise<OpenCodePromptHealth | null>;
  abort: () => Promise<void>;
  timeoutMs?: number | null;
  interactionTimeoutMs?: number | null;
  pollIntervalMs?: number;
}): Promise<T> {
  const timeoutMs = params.timeoutMs === undefined
    ? DEFAULT_OPENCODE_IDLE_TIMEOUT_MS
    : params.timeoutMs;
  const interactionTimeoutMs = params.interactionTimeoutMs === undefined
    ? DEFAULT_OPENCODE_INTERACTION_TIMEOUT_MS
    : params.interactionTimeoutMs;
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
      const now = Date.now();
      if (interactionTimeoutMs !== null) {
        const interaction = getTimedOutOpenCodeInteraction({
          health,
          now,
          timeoutMs: interactionTimeoutMs,
        });
        if (interaction) {
          await params.abort();
          throw new OpenCodeInteractionTimeoutError(interactionTimeoutMs, interaction);
        }
      }
      if (
        timeoutMs !== null
        && isOpenCodePromptIdleTimedOut({ health, now, timeoutMs })
      ) {
        await params.abort();
        throw new OpenCodeIdlePromptError(timeoutMs);
      }
    }
    return await new Promise<never>(() => {});
  })();

  try {
    return await Promise.race([prompt, monitor]);
  } finally {
    settled = true;
  }
}
