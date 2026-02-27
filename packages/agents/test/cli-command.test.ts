import { describe, expect, it } from "bun:test";
import { buildPromptParts, buildPromptText, buildSystemPrompt } from "../shared";
import { buildOpenCodeCommand } from "../opencode";
import { buildClaudeCommand, buildClaudeCommandArgs } from "../claude";
import { buildCodexCommand, buildCodexCommandArgs } from "../codex/client";
import { buildKimiCommand, buildKimiCommandArgs } from "../kimi/client";
import { buildKiroCommand, buildKiroCommandArgs } from "../kiro/client";
import { buildKiloCommand, buildKiloCommandArgs } from "../kilo/client";
import { buildQwenCommand, buildQwenCommandArgs } from "../qwen/client";
import { buildGooseCommand, buildGooseCommandArgs } from "../goose/client";
import { buildGeminiCommand, buildGeminiCommandArgs } from "../gemini/client";

describe("agent cli command formatting", () => {
  it("builds the final Claude CLI command", () => {
    const message = "hello world";
    const parts = buildPromptParts("C123", message);
    const prompt = buildPromptText(parts);
    const systemPrompt = buildSystemPrompt({
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

  it("appends channel system message into system prompt", () => {
    const systemPrompt = buildSystemPrompt({
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      channelSystemMessage: "Always ask for confirmation before destructive file operations.",
    });

    expect(systemPrompt).toContain("Always ask for confirmation before destructive file operations.");
    expect(systemPrompt).not.toContain("CHANNEL SYSTEM MESSAGE:");
  });

  it("includes branch rename guidance before creating pull requests", () => {
    const systemPrompt = buildSystemPrompt({
      channelId: "C123",
      threadId: "1770543888.045599",
      userId: "U789",
    });

    expect(systemPrompt).toContain("Before creating any pull request, make sure the current branch name is meaningful.");
    expect(systemPrompt).toContain("Preferred branch format before PR: `feat/<short-slug>-<threadShortId>`");
  });

  it("builds Discord action instructions for Discord context", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "discord",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
    });

    expect(systemPrompt).toContain("DISCORD CONTEXT:");
    expect(systemPrompt).toContain("DISCORD ACTIONS:");
    expect(systemPrompt).toContain('"platform":"discord"');
    expect(systemPrompt).toContain("Supported actions: get_guilds, get_channels, post_message");
  });

  it("builds Lark action instructions for Lark context", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "lark",
      channelId: "oc_123",
      threadId: "om_456",
      userId: "ou_789",
    });

    expect(systemPrompt).toContain("LARK CONTEXT:");
    expect(systemPrompt).toContain("LARK ACTIONS:");
    expect(systemPrompt).toContain('"platform":"lark"');
    expect(systemPrompt).toContain("Supported actions: get_channels, post_message, update_message, get_thread_messages, ask_user, add_reaction, get_user_info, upload_file.");
    expect(systemPrompt).toContain("Lark output should be plain text for now; do not rely on markdown styling.");
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

  it("builds the Codex exec command", () => {
    const args = buildCodexCommandArgs({
      sessionId: "session-3",
      model: "gpt-5-codex",
      prompt: "hello from codex",
    });
    const command = buildCodexCommand(args);

    expect(command).toContain("codex exec --json --skip-git-repo-check");
    expect(command).toContain("--json");
    expect(command).toContain("--full-auto");
    expect(command).toContain("--model gpt-5-codex");
    expect(command).toContain("session-3");
    expect(command).toContain("'hello from codex'");
  });

  it("builds the Codex plan command", () => {
    const args = buildCodexCommandArgs({
      sessionId: "session-3",
      model: "gpt-5-codex",
      prompt: "plan this change",
      planMode: true,
    });
    const command = buildCodexCommand(args);

    expect(command).toContain("codex exec --json --skip-git-repo-check");
    expect(command).toContain("--json");
    expect(command).toContain("--sandbox read-only");
    expect(command).not.toContain("--full-auto");
    expect(command).toContain("session-3");
    expect(command).toContain("'plan this change'");
  });

  it("builds the Kimi print command", () => {
    const args = buildKimiCommandArgs({
      sessionId: "session-4",
      workingPath: "/tmp/project",
      prompt: "hello from kimi",
    });
    const command = buildKimiCommand(args);

    expect(command).toContain("kimi --print");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--session session-4");
    expect(command).toContain("--work-dir /tmp/project");
    expect(command).toContain("-p 'hello from kimi'");
  });

  it("builds the Kiro non-interactive command", () => {
    const args = buildKiroCommandArgs({
      isNewSession: false,
      prompt: "hello from kiro",
      agent: "plan",
    });
    const command = buildKiroCommand("kiro-cli", args);

    expect(command).toContain("kiro-cli chat");
    expect(command).toContain("--no-interactive");
    expect(command).toContain("--trust-all-tools");
    expect(command).toContain("--resume");
    expect(command).toContain("--agent plan");
    expect(command).toContain("'hello from kiro'");
  });

  it("builds the Kilo run command", () => {
    const args = buildKiloCommandArgs({
      sessionId: "session-7",
      prompt: "hello from kilo",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-4" },
    });
    const command = buildKiloCommand(args);

    expect(command).toContain("kilo run --auto --format json");
    expect(command).toContain("--session session-7");
    expect(command).toContain("--agent plan");
    expect(command).toContain("--model openai/gpt-4");
    expect(command).toContain("'hello from kilo'");
  });

  it("builds the Qwen plan-mode command", () => {
    const args = buildQwenCommandArgs({
      sessionId: "session-5",
      isNewSession: false,
      prompt: "plan migration",
      approvalMode: "plan",
    });
    const command = buildQwenCommand(args);

    expect(command).toContain("--approval-mode plan");
    expect(command).not.toContain("--yolo");
    expect(command).toContain("--resume session-5");
    expect(command).toContain("-p 'plan migration'");
  });

  it("builds the Qwen default automation command", () => {
    const args = buildQwenCommandArgs({
      sessionId: "session-6",
      isNewSession: true,
      prompt: "implement feature",
    });
    const command = buildQwenCommand(args);

    expect(command).toContain("--yolo");
    expect(command).not.toContain("--approval-mode plan");
  });

  it("builds the Goose run command", () => {
    const args = buildGooseCommandArgs({
      sessionId: "session-8",
      isNewSession: true,
      prompt: "hello from goose",
    });
    const command = buildGooseCommand(args);

    expect(command).toContain("goose run --output-format stream-json");
    expect(command).toContain("--name session-8");
    expect(command).toContain("-t 'hello from goose'");
    expect(command).not.toContain("--resume");
  });

  it("builds the Goose resume command", () => {
    const args = buildGooseCommandArgs({
      sessionId: "session-9",
      isNewSession: false,
      prompt: "resume this",
    });
    const command = buildGooseCommand(args);

    expect(command).toContain("--resume");
    expect(command).toContain("--name session-9");
  });

  it("builds the Gemini plan-mode command", () => {
    const args = buildGeminiCommandArgs({
      sessionId: "session-10",
      isNewSession: false,
      prompt: "plan migration",
      approvalMode: "plan",
    });
    const command = buildGeminiCommand(args);

    expect(command).toContain("gemini");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--approval-mode plan");
    expect(command).toContain("--resume session-10");
    expect(command).toContain("-p 'plan migration'");
  });

  it("builds the Gemini default automation command", () => {
    const args = buildGeminiCommandArgs({
      sessionId: "session-11",
      isNewSession: true,
      prompt: "implement feature",
    });
    const command = buildGeminiCommand(args);

    expect(command).toContain("--approval-mode yolo");
    expect(command).not.toContain("--resume");
  });
});
