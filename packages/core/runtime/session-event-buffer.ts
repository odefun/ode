import type { SessionEvent } from "@/utils/session-inspector";

type UnknownRecord = Record<string, unknown>;

const NOISY_EVENT_TYPES = new Set([
  "server.connected",
  "server.heartbeat",
  "plugin.added",
  "catalog.updated",
  "reference.updated",
  "integration.updated",
  "project.directories.updated",
  "file.watcher.updated",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function eventData(event: SessionEvent): UnknownRecord {
  const payload = asRecord(event.data.payload);
  return payload ?? event.data;
}

function eventProperties(event: SessionEvent): UnknownRecord {
  const data = eventData(event);
  return asRecord(data.properties) ?? data;
}

function sourceSessionId(event: SessionEvent): string {
  const data = eventData(event);
  const context = asRecord(data.odeContext);
  const source = context?.sourceSessionID;
  if (typeof source === "string" && source) return source;
  const properties = eventProperties(event);
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const part = asRecord(properties.part);
  if (typeof part?.sessionID === "string") return part.sessionID;
  const info = asRecord(properties.info);
  if (typeof info?.sessionID === "string") return info.sessionID;
  return "global";
}

/**
 * Returns a stable slot for snapshot-style events. Replacing the prior value
 * prevents an O(n²) replay of every intermediate OpenCode text/tool snapshot.
 */
export function getSessionEventCoalesceKey(event: SessionEvent): string | null {
  const properties = eventProperties(event);
  const source = sourceSessionId(event);
  const part = asRecord(properties.part);
  const partId = typeof part?.id === "string"
    ? part.id
    : typeof properties.partID === "string"
      ? properties.partID
      : undefined;
  if (partId && (event.type.startsWith("message.part.") || event.type.startsWith("session.next."))) {
    return `${source}:${event.type}:part:${partId}`;
  }

  const info = asRecord(properties.info) ?? asRecord(properties.message);
  const messageId = typeof info?.id === "string" ? info.id : undefined;
  if (messageId && event.type === "message.updated") {
    return `${source}:${event.type}:message:${messageId}`;
  }

  if (
    event.type === "session.updated"
    || event.type === "session.status"
    || event.type === "session.diff"
    || event.type === "todo.updated"
  ) {
    return `${source}:${event.type}`;
  }

  return null;
}

export function appendCoalescedSessionEvent(
  history: SessionEvent[],
  indexByKey: Map<string, number>,
  event: SessionEvent
): void {
  const key = getSessionEventCoalesceKey(event);
  if (!key) {
    history.push(event);
    return;
  }
  const existing = indexByKey.get(key);
  if (existing === undefined) {
    indexByKey.set(key, history.length);
    history.push(event);
    return;
  }
  history[existing] = event;
}

/**
 * Snapshot replacement keeps a stable array slot for O(1) writes. Replay by
 * timestamp so a late idle/completion snapshot is not applied before newer
 * tool events merely because it reused an older slot.
 */
export function orderSessionEventsChronologically(events: readonly SessionEvent[]): SessionEvent[] {
  return events.slice().sort((left, right) => left.timestamp - right.timestamp);
}

/** A sampling key for provider.raw persistence; null means preserve the event. */
export function getRawProviderEventSamplingKey(event: SessionEvent): string | null {
  const coalesceKey = getSessionEventCoalesceKey(event);
  if (coalesceKey) return `snapshot:${coalesceKey}`;
  if (NOISY_EVENT_TYPES.has(event.type)) return `noise:${event.type}`;
  return null;
}

export class SampledRawEventBuffer {
  private readonly pending = new Map<string, SessionEvent>();
  private sequence = 0;
  private retained = 0;
  private dropped = 0;
  private summaryEmitted = false;

  constructor(private readonly maxEvents: number) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error("maxEvents must be a positive integer");
    }
  }

  enqueue(event: SessionEvent): void {
    const samplingKey = getRawProviderEventSamplingKey(event);
    this.pending.set(samplingKey ?? `event:${this.sequence++}`, event);
  }

  drain(force = false): {
    events: SessionEvent[];
    summary?: { dropped: number; retained: number };
  } {
    const events: SessionEvent[] = [];
    for (const event of this.pending.values()) {
      if (this.retained >= this.maxEvents) {
        this.dropped += 1;
      } else {
        events.push(event);
        this.retained += 1;
      }
    }
    this.pending.clear();

    const summary = force && this.dropped > 0 && !this.summaryEmitted
      ? { dropped: this.dropped, retained: this.retained }
      : undefined;
    if (summary) this.summaryEmitted = true;
    return { events, summary };
  }
}
