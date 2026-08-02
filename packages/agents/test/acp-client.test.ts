import { describe, expect, it } from "bun:test";
import type { AgentCapabilities as AcpAgentCapabilities } from "@agentclientprotocol/sdk";
import {
  appendAcpContentChunk,
  buildAcpPermissionQuestion,
  buildAcpPrompt,
  mapAcpCapabilities,
  prependSystemPrompt,
  scopeAcpSessionEvent,
  selectAcpPermissionOutcome,
  stringifyAcpToolContent,
} from "../runtime/acp-client";

describe("ACP client bridge", () => {
  it("maps negotiated lifecycle and attachment capabilities conservatively", () => {
    const capabilities: AcpAgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { resume: {}, close: {}, list: {} },
    };
    const mapped = mapAcpCapabilities(capabilities);

    expect(mapped.sessions).toEqual({
      create: true,
      resume: true,
      load: true,
      list: true,
      delete: false,
      close: true,
      fork: false,
    });
    expect(mapped.input.image).toBe(true);
    expect(mapped.interaction.question).toBe(false);
  });

  it("uses resource links when an ACP agent does not advertise image input", async () => {
    const blocks = await buildAcpPrompt([{
      type: "image",
      path: "/tmp/example.png",
      filename: "example.png",
      mimeType: "image/png",
      size: 10,
    }], {});

    expect(blocks).toEqual([{
      type: "resource_link",
      uri: "file:///tmp/example.png",
      name: "example.png",
      mimeType: "image/png",
      size: 10,
    }]);
  });

  it("keeps system instructions separate from binary prompt parts", () => {
    const parts = prependSystemPrompt([{
      type: "fileRef",
      path: "/tmp/archive.zip",
      filename: "archive.zip",
      mimeType: "application/zip",
      size: 100,
    }], "Follow Ode runtime rules.");

    expect(parts[0]).toEqual({
      type: "text",
      text: "<system-prompt>\nFollow Ode runtime rules.\n</system-prompt>",
    });
    expect(parts[1]?.type).toBe("fileRef");
  });

  it("routes ACP permission requests through a visible Ode question", () => {
    const event = buildAcpPermissionQuestion({
      providerName: "Kilo",
      requestId: "permission-1",
      sessionId: "native-session",
      request: {
        sessionId: "native-session",
        toolCall: {
          toolCallId: "tool-1",
          title: "run a shell command",
          rawInput: { command: "git status" },
        },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    }) as { type: string; properties: { questions: Array<{ question: string; custom: boolean }> } };

    expect(event.type).toBe("question.asked");
    expect(event.properties.questions[0]?.question).toContain("git status");
    expect(event.properties.questions[0]?.custom).toBe(false);
    expect(selectAcpPermissionOutcome([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
    ], [["Allow once"]])).toEqual({ outcome: "selected", optionId: "once" });
    expect(selectAcpPermissionOutcome([
      { optionId: "once", name: "Allow once", kind: "allow_once" },
    ], [["an unrecognized answer"]])).toEqual({ outcome: "cancelled" });
  });

  it("scopes canonical ACP events to every public session alias", () => {
    const scoped = scopeAcpSessionEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "text", type: "text", sessionID: "native-session", text: "hello" },
      },
    }, "public-session") as { properties: { part: { sessionID: string } } };
    const question = scopeAcpSessionEvent({
      type: "question.asked",
      properties: { id: "permission-1", sessionID: "native-session", questions: [] },
    }, "public-session") as { properties: { sessionID: string } };

    expect(scoped.properties.part.sessionID).toBe("public-session");
    expect(question.properties.sessionID).toBe("public-session");
  });

  it("keeps ACP tool progress content and file changes readable", () => {
    expect(stringifyAcpToolContent([
      { type: "content", content: { type: "text", text: "Reading the runtime" } },
      { type: "diff", path: "/tmp/repo/app.ts", oldText: "a", newText: "b" },
      { type: "terminal", terminalId: "terminal-1" },
    ])).toBe("Reading the runtime\nChanged /tmp/repo/app.ts\nTerminal: terminal-1");
  });

  it("accumulates chunks within a message and resets on a new ACP message id", () => {
    const first = appendAcpContentChunk({ text: "" }, {
      messageId: "message-1",
      content: { type: "text", text: "First " },
    });
    const completed = appendAcpContentChunk(first, {
      messageId: "message-1",
      content: { type: "text", text: "message" },
    });
    const second = appendAcpContentChunk(completed, {
      messageId: "message-2",
      content: { type: "text", text: "Second message" },
    });

    expect(completed.text).toBe("First message");
    expect(second).toEqual({ messageId: "message-2", text: "Second message" });
  });
});
