function getSessionIdFromRecord(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  if (typeof record.sessionID === "string") return record.sessionID;
  if (typeof record.sessionId === "string") return record.sessionId;
  if (typeof record.session_id === "string") return record.session_id;
  return undefined;
}

export function extractEventSessionId(event: Record<string, unknown> | undefined): string | undefined {
  if (!event) return undefined;
  const properties = event.properties && typeof event.properties === "object"
    ? event.properties as Record<string, unknown>
    : undefined;
  const fromProperties = getSessionIdFromRecord(properties);
  if (fromProperties) return fromProperties;

  const part = properties?.part && typeof properties.part === "object"
    ? properties.part as Record<string, unknown>
    : undefined;
  const fromPart = getSessionIdFromRecord(part);
  if (fromPart) return fromPart;

  const info = properties?.info && typeof properties.info === "object"
    ? properties.info as Record<string, unknown>
    : undefined;
  const fromInfo = getSessionIdFromRecord(info);
  if (fromInfo) return fromInfo;

  return getSessionIdFromRecord(event);
}

export function extractEventRootSessionId(
  event: Record<string, unknown> | undefined
): string | undefined {
  if (!event) return undefined;
  const context = event.odeContext && typeof event.odeContext === "object"
    ? event.odeContext as Record<string, unknown>
    : undefined;
  if (typeof context?.rootSessionID === "string") return context.rootSessionID;
  if (typeof context?.rootSessionId === "string") return context.rootSessionId;
  return undefined;
}
