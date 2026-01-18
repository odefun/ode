import { describe, expect, it } from "bun:test";
import { buildPromptParts, buildPromptText, buildSlackSystemPrompt } from "../shared";
import { buildOpenCodeCommand } from "../opencode/client";
import { buildClaudeCommand, buildClaudeCommandArgs } from "../claude/client";

describe("agent cli command formatting", () => {
  it("builds the final Claude CLI command", () => {
    const message = "hello world";
    const parts = buildPromptParts("C123", message);
    const prompt = buildPromptText(parts);
    const systemPrompt = buildSlackSystemPrompt({
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
    });

    const baseArgs = buildClaudeCommandArgs({
      sessionId: "session-1",
      isNewSession: true,
      systemPrompt,
      workingPath: "/tmp/project",
      prompt,
    });

    const { command } = buildClaudeCommand(baseArgs, "dontAsk");
    console.log('=== claude command ===')
    console.log(command)

    expect(command).toContain("claude");
    expect(command).toContain("--permission-mode dontAsk --");
    expect(command).toContain("--session-id session-1");
    expect(command).toContain("--add-dir /tmp/project");
    expect(command).toContain("'hello world'");
  });

  it("builds the OpenCode curl command", () => {
    const command = buildOpenCodeCommand("http://127.0.0.1:8080", "session-2", {
      directory: "/tmp/project",
      parts: [{ type: "text", text: "ping" }],
    });
    console.log('=== opencode command ===')
    console.log(command)

    expect(command).toContain("curl -s -X POST");
    expect(command).toContain("/session/session-2/prompt");
    expect(command).toContain("--data-raw");
    expect(command).toContain("\"ping\"");
  });
});
