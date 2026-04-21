import { describe, expect, it } from "bun:test";
import { truncateEventPayload, truncateString } from "../event-truncation";

describe("truncateString", () => {
  it("returns the original string when under the cap", () => {
    expect(truncateString("hello", 1024)).toBe("hello");
  });

  it("truncates long strings and reports dropped bytes", () => {
    const big = "x".repeat(10_000);
    const out = truncateString(big, 1024);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[truncated");
    expect(out).toContain("bytes]");
    // head prefix preserved
    expect(out.startsWith("x")).toBeTrue();
  });

  it("handles multibyte utf-8 correctly", () => {
    const big = "中".repeat(5000); // each char is 3 bytes
    const out = truncateString(big, 2048);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThan(Buffer.byteLength(big, "utf8"));
    expect(out).toContain("[truncated");
  });
});

describe("truncateEventPayload", () => {
  it("leaves small payloads unchanged (reference equality)", () => {
    const input = { type: "t", id: "abc", status: "ok", nested: { n: 1 } };
    const out = truncateEventPayload(input);
    expect(out).toBe(input);
  });

  it("preserves all ids, types, statuses when truncating strings", () => {
    const big = "x".repeat(10_000);
    const event = {
      type: "opencode.message.part.updated",
      properties: {
        part: {
          id: "part-123",
          callID: "call-456",
          tool: "read",
          type: "tool",
          state: {
            status: "completed",
            title: "Read file",
            output: big,
            input: { filePath: "/tmp/a.txt" },
          },
        },
      },
    };
    const out = truncateEventPayload(event, { maxStringBytes: 1024 });
    const p: any = (out as any).properties.part;
    // structural identity fields preserved
    expect(p.id).toBe("part-123");
    expect(p.callID).toBe("call-456");
    expect(p.tool).toBe("read");
    expect(p.type).toBe("tool");
    expect(p.state.status).toBe("completed");
    expect(p.state.title).toBe("Read file");
    expect(p.state.input.filePath).toBe("/tmp/a.txt");
    // big string was cut down
    expect(p.state.output.length).toBeLessThan(big.length);
    expect(p.state.output).toContain("[truncated");
  });

  it("truncates strings inside arrays of content blocks", () => {
    const big = "x".repeat(10_000);
    const event = {
      type: "claude.raw.message",
      properties: {
        record: {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "abc", content: big, is_error: false },
              { type: "text", text: "short" },
            ],
          },
        },
      },
    };
    const out: any = truncateEventPayload(event, { maxStringBytes: 1024 });
    const blocks = out.properties.record.message.content;
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[0].tool_use_id).toBe("abc");
    expect(blocks[0].is_error).toBe(false);
    expect(blocks[0].content.length).toBeLessThan(big.length);
    expect(blocks[0].content).toContain("[truncated");
    expect(blocks[1]).toEqual({ type: "text", text: "short" });
  });

  it("keeps numbers, booleans, nulls, and undefined unchanged", () => {
    const event = {
      type: "t",
      properties: {
        usage: { input_tokens: 1234, output_tokens: 567, reasoning_tokens: 0 },
        isError: false,
        metadata: null,
        missing: undefined,
      },
    };
    const out: any = truncateEventPayload(event);
    expect(out.properties.usage.input_tokens).toBe(1234);
    expect(out.properties.usage.output_tokens).toBe(567);
    expect(out.properties.isError).toBe(false);
    expect(out.properties.metadata).toBeNull();
  });

  it("handles circular references without throwing", () => {
    const a: any = { type: "x" };
    a.self = a;
    const out: any = truncateEventPayload(a);
    // original is returned (or a copy) without stack overflow
    expect(out.type).toBe("x");
  });

  it("respects maxDepth as a safety net", () => {
    const deep: any = { v: 1 };
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      cur.next = { v: i };
      cur = cur.next;
    }
    const out = truncateEventPayload(deep, { maxDepth: 3 });
    expect(out).toBeDefined();
    // just ensures no stack overflow; exact shape beyond maxDepth is not asserted
  });

  it("honours preserveStringAtPath for whitelisted paths", () => {
    const big = "a".repeat(10_000);
    const event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "text",
          text: big,
        },
      },
    };
    const out: any = truncateEventPayload(event, {
      maxStringBytes: 512,
      preserveStringAtPath: (path) => path === "properties.part.text",
    });
    // whitelisted string kept verbatim
    expect(out.properties.part.text).toBe(big);
    expect(out.properties.part.id).toBe("p1");
  });

  it("truncates other strings while preserving whitelisted ones", () => {
    const big = "a".repeat(10_000);
    const alsoBig = "b".repeat(10_000);
    const event = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          text: big,
          // A sibling long string should still be truncated so callers only
          // opt-in to the exact path they need to keep verbatim.
          debug: alsoBig,
        },
      },
    };
    const out: any = truncateEventPayload(event, {
      maxStringBytes: 512,
      preserveStringAtPath: (path) => path === "properties.part.text",
    });
    expect(out.properties.part.text).toBe(big);
    expect(out.properties.part.debug.length).toBeLessThan(alsoBig.length);
    expect(out.properties.part.debug).toContain("[truncated");
  });
});
