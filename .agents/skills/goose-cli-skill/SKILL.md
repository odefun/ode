---
name: goose-cli-skill
description: Reference guide for integrating and operating Goose CLI in Ode, focused on run/session commands, stream-json automation, and session lifecycle behavior.
---
## What I do
- Summarize Goose session lifecycle commands for automation and troubleshooting.
- Document non-interactive `goose run` usage with `--output-format stream-json`.
- Explain safe session resume patterns for thread-to-session mapping in Ode.
- Highlight Goose config behavior (user-managed provider/model in `~/.config/goose/config.yaml`).

## When to use me
Use this when adding or debugging Ode's `goose` provider, especially command construction, session resume behavior, and stream-event parsing for live status.

## Recommended invocation pattern
- Preferred Ode integration: `goose acp`, using ACP over stdio.
- Non-interactive run: `goose run --output-format stream-json --name <sessionName> -t <prompt>`
- Resume existing run session: `goose run --output-format stream-json --name <sessionName> --resume -t <prompt>`
- Open Goose web UI session: `goose web --open`

## Session management summary
- Start interactive CLI session: `goose session`
- Resume most recent: `goose session -r`
- Resume named session: `goose session -r --name <name>`
- List sessions: `goose session list --format json`
- Fork from an existing session: `goose session --resume --fork [--name <name>]`
- Remove session(s): `goose session remove --session-id <id>` or `--name <name>`
- Export session history: `goose session export --format json|yaml|markdown`

## Integration notes for Ode
- Goose uses user-managed model/provider config by default; do not require per-channel model selection.
- Keep channel model config empty for Goose in Slack/Discord/Web settings UI.
- Use `stream-json` output so live status can consume incremental events.
- Session IDs can be represented by a stable session name in Ode (`--name`) and resumed with `--resume`.
- Goose stores sessions in local storage (SQLite-backed in recent versions), so CLI and Desktop/Web can share context.
- Prefer ACP for native session IDs, cancellation, attachments, and structured updates. Use `goose run --output-format stream-json` only as the compatibility fallback.
- Route ACP `session/request_permission` back to the originating user and wait for an explicit option; cancellation must resolve a pending permission as cancelled.

## Sources
- https://block.github.io/goose/docs/guides/sessions/session-management
- https://block.github.io/goose/docs/guides/goose-cli-commands
- https://block.github.io/goose/docs/guides/running-tasks
