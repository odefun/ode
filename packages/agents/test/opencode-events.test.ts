import { describe, expect, it } from "bun:test";
import {
  extractOpenCodeChildSession,
  getOpenCodeEventContext,
  getOpenCodeEventFingerprint,
  normalizeOpenCodeGlobalEvent,
  normalizeOpenCodePermissionQuestion,
  parseOpenCodePermissionReply,
} from "../opencode/events";
import { extractEventRootSessionId, extractEventSessionId } from "@/utils/session-id";

describe("OpenCode global event normalization", () => {
  it("unwraps sync events and preserves root/child session context", () => {
    const normalized = normalizeOpenCodeGlobalEvent({
      directory: "/tmp/repo",
      payload: {
        type: "sync",
        id: "outer-1",
        syncEvent: {
          id: "event-1",
          type: "message.part.updated.1",
          seq: 42,
          aggregateID: "child-1",
          data: {
            sessionID: "child-1",
            part: {
              id: "part-1",
              sessionID: "child-1",
              messageID: "message-1",
              type: "text",
              text: "Auditing routes",
            },
          },
        },
      },
    }, {
      rootSessionId: "root-1",
      childTitle: () => "Repository audit",
    });

    expect(normalized?.payload.type).toBe("message.part.updated");
    expect(extractEventSessionId(normalized?.payload)).toBe("child-1");
    expect(extractEventRootSessionId(normalized?.payload)).toBe("root-1");
    expect(getOpenCodeEventContext(normalized?.payload)).toEqual({
      rootSessionID: "root-1",
      sourceSessionID: "child-1",
      childSession: true,
      childTitle: "Repository audit",
      transportType: "sync",
      syncSequence: 42,
    });
  });

  it("discovers an OpenCode task child session", () => {
    expect(extractOpenCodeChildSession({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          tool: "task",
          state: {
            title: "Audit docs",
            metadata: { parentSessionId: "root-1", sessionId: "child-1" },
          },
        },
      },
    })).toEqual({
      sessionId: "child-1",
      parentSessionId: "root-1",
      title: "Audit docs",
    });
  });

  it("gives direct and sync copies the same semantic fingerprint", () => {
    const part = {
      id: "part-1",
      sessionID: "root-1",
      type: "tool",
      tool: "read",
      state: { status: "completed", title: "README.md", output: "done" },
    };
    const direct = normalizeOpenCodeGlobalEvent({
      payload: { type: "message.part.updated", properties: { sessionID: "root-1", part } },
    }, { rootSessionId: "root-1" });
    const sync = normalizeOpenCodeGlobalEvent({
      payload: {
        type: "sync",
        syncEvent: {
          id: "event-2",
          type: "message.part.updated.1",
          seq: 9,
          aggregateID: "root-1",
          data: { sessionID: "root-1", part },
        },
      },
    }, { rootSessionId: "root-1" });

    expect(getOpenCodeEventFingerprint(direct?.payload)).toBe(
      getOpenCodeEventFingerprint(sync?.payload)
    );
  });

  it("turns permission requests into explicit user questions", () => {
    const question = normalizeOpenCodePermissionQuestion({
      type: "permission.asked",
      properties: {
        id: "permission-1",
        sessionID: "session-1",
        permission: "run shell commands",
        patterns: ["git status"],
        metadata: { cwd: "/tmp/repo" },
      },
    });

    expect(question?.type).toBe("question.asked");
    expect(question?.properties).toMatchObject({
      id: "permission-1",
      sessionID: "session-1",
      questions: [{
        custom: false,
        options: [
          { label: "Allow once" },
          { label: "Always allow" },
          { label: "Reject" },
        ],
      }],
    });
    expect(parseOpenCodePermissionReply([["Allow once"]])).toBe("once");
    expect(parseOpenCodePermissionReply([["Always allow"]])).toBe("always");
    expect(parseOpenCodePermissionReply([["unexpected free-form reply"]])).toBe("reject");
  });
});
