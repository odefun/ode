---
name: kimi-cli-skill
description: Reference guide for integrating and operating Kimi Code CLI in Ode, with focus on prompt mode, sessions, and automation-safe defaults.
---
## What I do
- Provide Kimi CLI integration guidance for Ode agent providers.
- Document reliable non-interactive invocation patterns using `-p/--prompt`.
- Explain session reuse (`--session`) and JSONL output parsing for current Kimi Code CLI.
- Call out automation implications for prompt mode.

## When to use me
Use this when adding or debugging the `kimi` provider in Ode, especially command construction, streaming output parsing, or script/CI behavior.
Ask clarifying questions if you need model/auth-specific setup beyond CLI invocation.

## Recommended invocation pattern
- Preferred Ode integration: `kimi acp`, using ACP `session/new`, `session/load`, `session/prompt`, `session/update`, and `session/cancel` over stdio.
- New session: `kimi --output-format stream-json -p <prompt>` from the target working directory.
- Resume session: `kimi --output-format stream-json --session <session_...> -p <prompt>`.
- Kimi Code 0.31.x continues to use prompt mode and does not support the older `--print` or `--work-dir` flags.
- The CLI stores sessions in `~/.kimi-code/session_index.jsonl`; new session IDs use the `session_...` shape.

## Integration notes for Ode
- Prefer ACP for structured session lifecycle, plan/tool/message updates, and image/resource prompt blocks. Fall back to the JSONL prompt mode only when ACP initialization or session setup fails.
- ACP `session/request_permission` is bidirectional and must pause for the originating user; do not silently select `allow_once` or `allow_always`.
- Treat prompt mode as the automation surface; add `--auto`/`--yolo` only when the target CLI version requires it for tool approval.
- Parse stdout as JSONL message stream (`assistant` and optional `tool` messages).
- Keep provider model input hidden in UI unless explicitly needed.
- Keep session IDs stable per Slack thread and rotate when environment changes.

## Sources
- https://moonshotai.github.io/kimi-cli/zh/customization/print-mode.html
- https://moonshotai.github.io/kimi-cli/zh/reference/kimi-command.html
- https://moonshotai.github.io/kimi-cli/zh/customization/print-mode.md
