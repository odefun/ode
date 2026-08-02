import { describe, expect, it } from "bun:test";
import { buildPromptParts, buildPromptText, buildSystemPrompt, buildSystemWrappedPrompt } from "../shared";
import { buildOpenCodeCommand } from "../opencode/client";
import { buildClaudeCommand, buildClaudeCommandArgs } from "../claude/client";
import { buildCodexCommand, buildCodexCommandArgs } from "../codex/client";
import { buildKimiCommand, buildKimiCommandArgs } from "../kimi/client";
import { buildKiloCommand, buildKiloCommandArgs } from "../kilo/client";
import { buildQwenCommand, buildQwenCommandArgs } from "../qwen/client";
import { buildGooseCommand, buildGooseCommandArgs } from "../goose/client";
import { buildPiCommand, buildPiCommandArgs, parsePiResponse } from "../pi/client";
import { buildOpenHandsCommand, buildOpenHandsCommandArgs, parseOpenHandsResponse } from "../openhands/client";
import { buildCodeBuddyCommand, buildCodeBuddyCommandArgs, parseCodeBuddyResponse } from "../codebuddy/client";
import { buildCrushCommand, buildCrushCommandArgs, parseCrushResponse } from "../crush/client";
import { createAgentInput } from "@/shared/agent-protocol";

describe("agent cli command formatting", () => {
  it("builds the final Claude CLI command", () => {
    const message = "hello world";
    const parts = buildPromptParts("C123", createAgentInput(message));
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
    expect(command).toContain("--append-system-prompt");
    expect(command).toContain("ode send file");
    expect(command).toContain("--session-id session-1");
    expect(command).toContain("--add-dir /tmp/project");
    expect(command).toContain("'hello world'");
  });

  it("injects Ode CLI capability guidance by default when platform context is present", () => {
    const systemPrompt = buildSystemPrompt({
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
    });

    expect(systemPrompt).toContain("ODE RUNTIME CONTEXT:");
    expect(systemPrompt).toContain("Channel: C123");
    expect(systemPrompt).toContain("Thread: T456");
    expect(systemPrompt).toContain("ODE CLI CAPABILITIES:");
    expect(systemPrompt).toContain("ode send file <path> --channel <channelId> --thread <threadId>");
    expect(systemPrompt).toContain("ode messages get <threadId> --channel <channelId>");
    expect(systemPrompt).toContain("ode reaction add <messageId> --channel <channelId>");
    expect(systemPrompt).toContain("ode task create --time <ISO8601>");
    expect(systemPrompt).toContain("ode cron create --schedule");
  });

  it("appends the explicit channel system message to Ode CLI guidance", () => {
    const systemPrompt = buildSystemPrompt({
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
      channelSystemMessage: "Always ask for confirmation before destructive file operations.",
    });

    expect(systemPrompt).toContain("ODE CLI CAPABILITIES:");
    expect(systemPrompt).toContain("CHANNEL SYSTEM MESSAGE:");
    expect(systemPrompt).toContain("Always ask for confirmation before destructive file operations.");
  });

  it("does not inject git or pull request guidance", () => {
    const systemPrompt = buildSystemPrompt({
      channelId: "C123",
      threadId: "1770543888.045599",
      userId: "U789",
    });

    expect(systemPrompt).not.toContain("Before creating any pull request");
    expect(systemPrompt).not.toContain("Preferred branch format before PR");
  });

  it("injects Discord runtime context without platform formatting guidance", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "discord",
      channelId: "C123",
      threadId: "T456",
      userId: "U789",
    });

    expect(systemPrompt).toContain("Platform: discord");
    expect(systemPrompt).toContain("ODE CLI CAPABILITIES:");
    expect(systemPrompt).not.toContain("FORMATTING:");
    expect(systemPrompt).not.toContain("Discord supports markdown");
  });

  it("injects Lark runtime context without platform formatting guidance", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "lark",
      channelId: "oc_123",
      threadId: "om_456",
      userId: "ou_789",
    });

    expect(systemPrompt).toContain("Platform: lark");
    expect(systemPrompt).toContain("ODE CLI CAPABILITIES:");
    expect(systemPrompt).not.toContain("FORMATTING:");
    expect(systemPrompt).not.toContain("Lark output should be plain text");
  });

  it("does not inject chat response style or task-list glyph guidance", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "slack",
      channelId: "C9XXX",
      threadId: "1700000000.000001",
      userId: "U42",
    });

    expect(systemPrompt).not.toContain("COMMUNICATION STYLE:");
    expect(systemPrompt).not.toContain("PROGRESS CHECKLIST:");
    expect(systemPrompt).not.toContain("TASK LISTS:");
    expect(systemPrompt).not.toContain("Slack uses *bold*");
    expect(systemPrompt).not.toContain("Use four states");
  });

  it("injects Ode CLI command guidance", () => {
    const systemPrompt = buildSystemPrompt({
      platform: "slack",
      channelId: "C9XXX",
      threadId: "1700000000.000001",
      userId: "U42",
    });

    expect(systemPrompt).toContain("ode task create");
    expect(systemPrompt).toContain("ode cron create");
    expect(systemPrompt).toContain("ode send file");
    expect(systemPrompt).toContain("ode messages get");
    expect(systemPrompt).toContain("ode reaction add");
    expect(systemPrompt).toContain("save it to the system temp folder and upload it with `ode send file`");
  });

  it("does not wrap prompts when no system prompt is present", () => {
    expect(buildSystemWrappedPrompt("", "hello")).toBe("hello");
  });

  it("wraps only explicit system prompts", () => {
    expect(buildSystemWrappedPrompt("custom rules", "hello")).toBe("<system-prompt>\ncustom rules\n</system-prompt>\n\nhello");
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
      isNewSession: false,
    });
    const command = buildCodexCommand(args);

    expect(command).toContain("codex exec --json --skip-git-repo-check");
    expect(command).toContain("--json");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
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
      isNewSession: false,
    });
    const command = buildCodexCommand(args);

    expect(command).toContain("codex exec --json --skip-git-repo-check");
    expect(command).toContain("--json");
    expect(command).toContain("--sandbox read-only");
    expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain("session-3");
    expect(command).toContain("'plan this change'");
  });

  it("omits the Codex model flag when no model is configured", () => {
    const args = buildCodexCommandArgs({
      sessionId: "session-3",
      prompt: "hello from codex",
      isNewSession: false,
    });
    const command = buildCodexCommand(args);

    expect(command).not.toContain("--model");
    expect(command).toContain("session-3");
    expect(command).toContain("'hello from codex'");
  });

  it("starts a new Codex exec session without resume", () => {
    const args = buildCodexCommandArgs({
      sessionId: "session-3",
      prompt: "hello from codex",
      isNewSession: true,
    });
    const command = buildCodexCommand(args);

    expect(command).toContain("codex exec --json --skip-git-repo-check");
    expect(command).not.toContain("resume session-3");
    expect(command).toContain("'hello from codex'");
  });

  it("builds the Kimi prompt command", () => {
    const args = buildKimiCommandArgs({
      sessionId: "session-4",
      workingPath: "/tmp/project",
      prompt: "hello from kimi",
      isNewSession: false,
    });
    const command = buildKimiCommand(args);

    expect(command).not.toContain("--print");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--session session-4");
    expect(command).not.toContain("--work-dir");
    expect(command).toContain("-p 'hello from kimi'");
  });

  it("starts a new Kimi prompt without a resume session", () => {
    const args = buildKimiCommandArgs({
      sessionId: "session-4",
      workingPath: "/tmp/project",
      prompt: "hello from kimi",
      isNewSession: true,
    });
    const command = buildKimiCommand(args);

    expect(command).toContain("--output-format stream-json");
    expect(command).not.toContain("--session session-4");
    expect(command).toContain("-p 'hello from kimi'");
  });

  it("builds the Kilo run command", () => {
    const args = buildKiloCommandArgs({
      sessionId: "session-7",
      prompt: "hello from kilo",
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-4" },
    });
    const command = buildKiloCommand(args);

    expect(command).toContain("kilo run --format json");
    expect(command).not.toContain("--auto");
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
    expect(command).not.toContain("--approval-mode yolo");
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

    expect(command).toContain("--approval-mode auto");
    expect(command).not.toContain("--approval-mode yolo");
    expect(command).not.toContain("--approval-mode plan");
    expect(command).toContain("--max-wall-time 10m --max-tool-calls 100");
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

  it("builds the Pi json command", () => {
    const args = buildPiCommandArgs({
      sessionId: "session-12",
      prompt: "hello from pi",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" },
    });
    const command = buildPiCommand(args);

    expect(command).toContain("pi --mode json --print");
    expect(command).toContain("--session-id session-12");
    expect(command).toContain("--model anthropic/claude-sonnet-4-5-20250929");
    expect(command).toContain("--tools read,grep,find,ls");
    expect(command).toContain("'hello from pi'");
  });

  it("builds the OpenHands headless command", () => {
    const args = buildOpenHandsCommandArgs({
      prompt: "hello from openhands",
    });
    const command = buildOpenHandsCommand(args);

    expect(command).toContain("openhands --headless --json --override-with-envs");
    expect(command).toContain("--exit-without-confirmation");
    expect(command).toContain("-t 'hello from openhands'");
  });

  it("builds the CodeBuddy stream-json command", () => {
    const args = buildCodeBuddyCommandArgs({
      sessionId: "session-13",
      prompt: "hello from codebuddy",
      model: { providerID: "codebuddy", modelID: "gpt-5.1" },
    });
    const command = buildCodeBuddyCommand(args);

    expect(command).toContain("codebuddy --print");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--include-partial-messages");
    expect(command).toContain("--session-id session-13");
    expect(command).toContain("--model gpt-5.1");
    expect(command).toContain("--permission-mode dontAsk");
    expect(command).not.toContain("bypassPermissions");
  });

  it("builds the Crush run command", () => {
    const args = buildCrushCommandArgs({
      sessionId: "session-14",
      prompt: "hello from crush",
      model: { providerID: "chainbot", modelID: "gpt-5.1" },
      isNewSession: false,
    });
    const command = buildCrushCommand(args);

    expect(command).toContain("crush run --verbose");
    expect(command).toContain("--model chainbot/gpt-5.1");
    expect(command).toContain("--session session-14");
    expect(command).toContain("'hello from crush'");
  });

  it("lets Crush use its own configured default model", () => {
    const command = buildCrushCommand(buildCrushCommandArgs({
      sessionId: "session-14",
      prompt: "hello from crush",
      isNewSession: true,
    }));

    expect(command).toContain("crush run --verbose");
    expect(command).not.toContain("--model");
  });

  it("parses new provider final responses", () => {
    expect(parsePiResponse([
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }),
      JSON.stringify({ type: "agent_end" }),
    ].join("\n"))).toBe("OK");

    expect(parseCodeBuddyResponse(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
    }))).toBe("OK");

    expect(parseOpenHandsResponse(`--JSON Event--\n${JSON.stringify({
      kind: "MessageEvent",
      source: "agent",
      llm_message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
    }, null, 2)}`).text).toBe("OK");

    expect(parseCrushResponse("OK\n")).toBe("OK");
  });
});
