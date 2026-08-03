import { extractEventSessionId } from "@/utils/session-id";

type UnknownRecord = Record<string, unknown>;

export type OpenCodeEventContext = {
  rootSessionID: string;
  sourceSessionID?: string;
  childSession: boolean;
  childTitle?: string;
  transportType: "event" | "sync";
  syncSequence?: number;
};

export type NormalizedOpenCodeGlobalEvent = {
  directory?: string;
  payload: UnknownRecord;
};

export type OpenCodeChildSession = {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
};

export type OpenCodePermissionReply = "once" | "always" | "reject";

export function isOpenCodeExternalDirectoryPermission(event: unknown): boolean {
  const record = asRecord(event);
  if (record?.type !== "permission.asked") return false;
  const properties = asRecord(record.properties);
  return asNonEmptyString(properties?.permission)?.toLowerCase() === "external_directory";
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function compactPermissionValue(value: unknown, maxLength = 240): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

export function normalizeOpenCodePermissionQuestion(event: unknown): UnknownRecord | null {
  const record = asRecord(event);
  if (record?.type !== "permission.asked") return null;
  const properties = asRecord(record.properties);
  const requestId = asNonEmptyString(properties?.id);
  const sessionID = asNonEmptyString(properties?.sessionID);
  if (!properties || !requestId || !sessionID) return null;
  const permission = asNonEmptyString(properties.permission) ?? "use a protected capability";
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.map(compactPermissionValue).filter((value): value is string => Boolean(value))
    : [];
  const metadata = compactPermissionValue(properties.metadata);
  const detail = [
    patterns.length > 0 ? `Targets: ${patterns.join(", ")}` : undefined,
    metadata && metadata !== "{}" ? `Details: ${metadata}` : undefined,
  ].filter(Boolean).join("\n");
  return {
    type: "question.asked",
    properties: {
      id: requestId,
      sessionID,
      questions: [{
        header: "Permission",
        question: `OpenCode wants permission to ${permission}.${detail ? `\n${detail}` : ""}`,
        options: [
          { label: "Allow once" },
          { label: "Always allow" },
          { label: "Reject" },
        ],
        multiple: false,
        custom: false,
      }],
      odePermission: {
        permission,
        patterns,
      },
      odeContext: properties.odeContext,
    },
    odeContext: record.odeContext,
  };
}

export function parseOpenCodePermissionReply(answers: Array<Array<string>>): OpenCodePermissionReply {
  const answer = answers.flat().map((value) => value.trim().toLowerCase()).find(Boolean) ?? "";
  if (answer === "allow once" || answer === "once") return "once";
  if (answer === "always allow" || answer === "allow always" || answer === "always") return "always";
  return "reject";
}

function stripSyncSchemaVersion(type: string): string {
  return type.replace(/\.\d+$/, "");
}

function stringFingerprint(value: unknown): [number, string] | undefined {
  if (typeof value !== "string") return undefined;
  return [value.length, value.slice(-96)];
}

/**
 * OpenCode's global SSE stream contains both ordinary events and durable
 * `syncEvent` envelopes. Normalize the latter to the same `{type,properties}`
 * shape consumed by Ode's provider-neutral event parser.
 */
export function normalizeOpenCodeGlobalEvent(
  globalEvent: unknown,
  params: {
    rootSessionId: string;
    childTitle?: (sessionId: string) => string | undefined;
  }
): NormalizedOpenCodeGlobalEvent | null {
  const wrapper = asRecord(globalEvent);
  if (!wrapper) return null;
  const rawPayload = asRecord(wrapper.payload) ?? wrapper;
  const rawType = asNonEmptyString(rawPayload.type);
  if (!rawType) return null;

  let payload: UnknownRecord = rawPayload;
  let transportType: OpenCodeEventContext["transportType"] = "event";
  let syncSequence: number | undefined;
  let aggregateSessionId: string | undefined;

  if (rawType === "sync") {
    const syncEvent = asRecord(rawPayload.syncEvent);
    const syncType = asNonEmptyString(syncEvent?.type);
    const syncData = asRecord(syncEvent?.data);
    if (!syncEvent || !syncType || !syncData) return null;
    transportType = "sync";
    syncSequence = typeof syncEvent.seq === "number" ? syncEvent.seq : undefined;
    aggregateSessionId = asNonEmptyString(syncEvent.aggregateID);
    payload = {
      id: asNonEmptyString(syncEvent.id) ?? asNonEmptyString(rawPayload.id),
      type: stripSyncSchemaVersion(syncType),
      properties: syncData,
    };
  }

  const sourceSessionID = extractEventSessionId(payload) ?? aggregateSessionId;
  const context: OpenCodeEventContext = {
    rootSessionID: params.rootSessionId,
    sourceSessionID,
    childSession: Boolean(sourceSessionID && sourceSessionID !== params.rootSessionId),
    childTitle: sourceSessionID ? params.childTitle?.(sourceSessionID) : undefined,
    transportType,
    syncSequence,
  };

  const properties = asRecord(payload.properties);
  payload = {
    ...payload,
    ...(properties ? { properties: { ...properties, odeContext: context } } : {}),
    odeContext: context,
  };
  return {
    directory: asNonEmptyString(wrapper.directory),
    payload,
  };
}

export function getOpenCodeEventContext(event: unknown): OpenCodeEventContext | undefined {
  const record = asRecord(event);
  const context = asRecord(record?.odeContext);
  const rootSessionID = asNonEmptyString(context?.rootSessionID);
  if (!rootSessionID) return undefined;
  return {
    rootSessionID,
    sourceSessionID: asNonEmptyString(context?.sourceSessionID),
    childSession: context?.childSession === true,
    childTitle: asNonEmptyString(context?.childTitle),
    transportType: context?.transportType === "sync" ? "sync" : "event",
    syncSequence: typeof context?.syncSequence === "number" ? context.syncSequence : undefined,
  };
}

export function extractOpenCodeChildSession(event: unknown): OpenCodeChildSession | null {
  const record = asRecord(event);
  if (!record) return null;
  const properties = asRecord(record.properties) ?? {};
  const part = asRecord(properties.part);
  const state = asRecord(part?.state);
  const metadata = asRecord(state?.metadata);
  const tool = asNonEmptyString(part?.tool)?.toLowerCase();

  if (part?.type === "tool" && (tool === "task" || tool === "subtask" || tool === "subagent")) {
    const sessionId = asNonEmptyString(metadata?.sessionId)
      ?? asNonEmptyString(metadata?.sessionID)
      ?? asNonEmptyString(metadata?.session_id);
    if (sessionId) {
      return {
        sessionId,
        parentSessionId: asNonEmptyString(metadata?.parentSessionId)
          ?? asNonEmptyString(metadata?.parentSessionID),
        title: asNonEmptyString(state?.title)
          ?? asNonEmptyString((state?.input as UnknownRecord | undefined)?.description),
      };
    }
  }

  if (record.type === "session.created" || record.type === "session.updated") {
    const info = asRecord(properties.info) ?? asRecord(properties.session) ?? properties;
    const sessionId = asNonEmptyString(info.id) ?? asNonEmptyString(info.sessionID);
    const parentSessionId = asNonEmptyString(info.parentID) ?? asNonEmptyString(info.parentId);
    if (sessionId && parentSessionId) {
      return {
        sessionId,
        parentSessionId,
        title: asNonEmptyString(info.title),
      };
    }
  }

  return null;
}

export function isMeaningfulOpenCodeEvent(event: unknown): boolean {
  const record = asRecord(event);
  const type = asNonEmptyString(record?.type);
  if (!type) return false;
  return ![
    "server.connected",
    "server.heartbeat",
    "plugin.added",
    "catalog.updated",
    "reference.updated",
    "integration.updated",
    "project.directories.updated",
    "file.watcher.updated",
  ].includes(type);
}

export function getOpenCodeEventFingerprint(event: unknown): string | null {
  const record = asRecord(event);
  const type = asNonEmptyString(record?.type);
  if (!record || !type) return null;
  const properties = asRecord(record.properties) ?? {};
  const context = getOpenCodeEventContext(record);
  const source = context?.sourceSessionID ?? extractEventSessionId(record) ?? "global";

  if (type === "message.part.updated") {
    const part = asRecord(properties.part);
    const state = asRecord(part?.state);
    const time = asRecord(state?.time) ?? asRecord(part?.time);
    const id = asNonEmptyString(part?.id);
    if (!id) return null;
    return JSON.stringify([
      source,
      type,
      id,
      part?.type,
      stringFingerprint(part?.text),
      stringFingerprint(part?.snapshot),
      state?.status,
      state?.title,
      stringFingerprint(state?.output),
      time?.start,
      time?.end,
    ]);
  }

  if (type === "message.updated") {
    const info = asRecord(properties.info) ?? asRecord(properties.message);
    const id = asNonEmptyString(info?.id);
    if (!id) return null;
    return JSON.stringify([
      source,
      type,
      id,
      info?.finish,
      info?.error,
      info?.time,
      info?.tokens,
    ]);
  }

  if (type === "session.status" || type === "todo.updated") {
    return JSON.stringify([source, type, properties]);
  }

  return null;
}
