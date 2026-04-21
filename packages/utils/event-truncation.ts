/**
 * Memory-saving truncation for buffered session events.
 *
 * Context: `packages/core/kernel/request-run.ts` keeps every raw provider event
 * of a turn in `eventHistory: SessionEvent[]` (unbounded within a turn) so the
 * renderer can re-fold the whole stream every flush. Some events carry multi-KB
 * blobs (tool output, command stdout, file contents, streamed assistant text).
 * Over a long turn these can accumulate to many MB per active turn.
 *
 * The live-status renderer (`status.ts::buildLiveStatusMessage`) never displays
 * `tool.output` or full assistant body; it only renders a short preview of
 * `tool.input` (truncated to 30-200 chars) and the thinking text (first 90
 * chars). So truncating long strings inside `event.data` to a few KB is lossless
 * for the UI. It only affects the string content that later lands in
 * `SessionTool.output` for session persistence / replay.
 *
 * This utility walks the event payload once and replaces any overlong string
 * with a marker string of the form `<...[truncated Nbytes]>`, keeping all ids,
 * types, statuses, and other discriminators intact.
 */

const DEFAULT_MAX_STRING_BYTES = 4 * 1024; // 4 KB per string
const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_ARRAY_LENGTH = 2048; // guardrail, not usually hit

export type TruncateEventOptions = {
  /**
   * Maximum byte length (utf-8) for any string inside the payload. Strings
   * longer than this are replaced with a shorter marker. Defaults to 4 KB.
   */
  maxStringBytes?: number;
  /**
   * Maximum recursion depth. Beyond this, nested structures are replaced with
   * "[truncated: max depth reached]". Safety net against pathological input.
   */
  maxDepth?: number;
  /**
   * Maximum array length to walk into. Longer arrays keep the first N items
   * and append a count marker. Safety net only.
   */
  maxArrayLength?: number;
  /**
   * Optional escape hatch for strings that must be kept verbatim. Called with
   * the dotted JSON path to the string (e.g. `properties.part.text`). Return
   * `true` to skip truncation for this string. Used by the request runner to
   * preserve assistant text / reasoning parts that feed the Slack final-reply
   * fallback.
   */
  preserveStringAtPath?: (path: string) => boolean;
};

/**
 * Recursively truncate long strings inside an arbitrary JSON-like value.
 *
 * - Preserves all keys, types, numbers, booleans, nulls, and the overall tree
 *   shape.
 * - Strings longer than `maxStringBytes` are replaced with
 *   "<first N-64 chars>...[truncated Mbytes]" (keeps a head snippet for debug).
 * - Circular references are short-circuited via a `WeakSet`.
 *
 * Returns a new value (or the original reference if nothing needed changing).
 */
export function truncateEventPayload<T>(value: T, options: TruncateEventOptions = {}): T {
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const preserveStringAtPath = options.preserveStringAtPath;
  const seen = new WeakSet<object>();

  function visit(node: unknown, depth: number, path: string): unknown {
    if (depth > maxDepth) {
      return "[truncated: max depth reached]";
    }
    if (node === null || node === undefined) return node;
    const t = typeof node;
    if (t === "string") {
      if (preserveStringAtPath && preserveStringAtPath(path)) {
        return node;
      }
      return truncateString(node as string, maxStringBytes);
    }
    if (t !== "object") return node; // number, boolean, bigint, symbol, function
    if (seen.has(node as object)) {
      return "[truncated: circular]";
    }
    seen.add(node as object);

    if (Array.isArray(node)) {
      const arr = node as unknown[];
      const limit = Math.min(arr.length, maxArrayLength);
      const out: unknown[] = new Array(limit);
      let changed = arr.length !== limit;
      for (let i = 0; i < limit; i++) {
        const childPath = path ? `${path}[${i}]` : `[${i}]`;
        const next = visit(arr[i], depth + 1, childPath);
        out[i] = next;
        if (next !== arr[i]) changed = true;
      }
      if (arr.length > maxArrayLength) {
        out.push(`[truncated: ${arr.length - maxArrayLength} more items]`);
      }
      return changed ? out : arr;
    }

    // Plain object. Only walk own enumerable keys.
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const next = visit(obj[key], depth + 1, childPath);
      out[key] = next;
      if (next !== obj[key]) changed = true;
    }
    return changed ? out : obj;
  }

  return visit(value, 0, "") as T;
}

/**
 * Truncate a single utf-8 string to at most `maxBytes` bytes, appending a
 * marker that records the dropped size. Returns the original reference if the
 * string is short enough.
 */
export function truncateString(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return value;
  // Fast path: if the string is clearly short enough to fit in maxBytes even
  // assuming every char becomes 4 bytes, return as-is. Avoids encoding cost.
  if (value.length * 4 <= maxBytes) return value;
  const byteLen = Buffer.byteLength(value, "utf8");
  if (byteLen <= maxBytes) return value;
  // Keep a head snippet (leave room for the marker suffix). The head is
  // measured in characters, not bytes, which is fine because the marker itself
  // is tiny and we only need an approximate cap — this buffer is a memory
  // safeguard, not a strict contract.
  const headChars = Math.max(0, Math.floor(maxBytes / 4) - 64);
  const head = value.slice(0, headChars);
  const droppedBytes = byteLen - Buffer.byteLength(head, "utf8");
  return `${head}...[truncated ${droppedBytes} bytes]`;
}
