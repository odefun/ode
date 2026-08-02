---
name: qwen-code-skill
description: Reference guide for integrating and operating Qwen Code CLI in Ode, focused on headless mode, stream-json events, and session resume behavior.
---
## What I do
- Summarize Qwen Code headless invocation for Ode agent integrations.
- Document non-interactive command patterns for `stream-json` output.
- Explain session continuation (`--continue`, `--resume`) and project-scoped chat state.
- Highlight automation-safe defaults for CI scripts and long-running workflows.

## When to use me
Use this when adding or debugging Ode's `qwen` provider, especially command construction, parsing streamed JSON events, and live status compatibility.

## Recommended invocation pattern
- Base command: `qwen --output-format stream-json --include-partial-messages --approval-mode auto --max-wall-time 10m --max-tool-calls 100 -p <prompt>`
- Resume existing context: append `--resume <sessionId>` (or `--continue` for latest project session)
- Text-only one-shot output: omit `--output-format` and use default text mode

## Integration notes for Ode
- The locally validated Qwen Code 0.21.3 command surface does not expose an ACP entry point, so Ode must keep using `stream-json` for this version instead of advertising ACP support.
- Qwen headless supports `text`, `json`, and `stream-json`; use `stream-json` for live status updates.
- `--include-partial-messages` emits incremental events (for example `content_block_delta`) that map well to status rendering.
- Qwen Code 0.21.x still accepts `--include-partial-messages` and `--approval-mode` even when a bare `qwen --help` omits them from its abbreviated option list.
- Prefer `--approval-mode auto` for local headless automation: current Qwen uses a fail-closed classifier for risky operations while allowing low-risk work to proceed. Do not use `yolo` on an unsandboxed developer machine.
- Bound headless runs with `--max-wall-time` and `--max-tool-calls`; Qwen 0.21.x emits distinct structured budget failures.
- Use `--approval-mode plan` for read-only planning.
- Session history is project-scoped under `~/.qwen/projects/<sanitized-cwd>/chats`; restoring a session recovers history and tool context.
- Keep channel model selection disabled for Qwen in Ode UI; provider logic does not require per-channel model overrides.

## Sources
- https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
