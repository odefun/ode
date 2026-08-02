---
name: kilo-cli-skill
description: Reference guide for integrating and operating Kilo CLI in Ode, focused on non-interactive runs, session usage, and JSON event streaming.
---
## What I do
- Summarize the Kilo CLI command surface for Ode integrations.
- Recommend automation-safe invocation patterns for `kilo run`.
- Document session behavior (`--session`, `--continue`) and troubleshooting commands.
- Highlight config paths, auth flow, and environment overrides.

## When to use me
Use this when implementing or debugging the `kilo` provider in Ode, especially CLI command construction, session behavior, and JSON output handling.

## Recommended invocation pattern for Ode
- Preferred structured transport: `kilo acp` from the target working directory.
- Compatibility fallback: `kilo run --format json --session <id> "<prompt>"`
- Add `--agent <agent>` when a plan/build agent is requested.
- Add `--model <provider/model>` when a model override is configured.
- Run with `cwd` set to the target workspace path.

## Key CLI references
- Start TUI: `kilo` (or `kilo [project]`)
- Non-interactive: `kilo run [message..]` with `--format json`; `--auto` grants all permissions and should not be added on an unsandboxed developer machine.
- Server mode: `kilo serve`, attach with `kilo attach <url>`
- Auth: `kilo auth`, provider setup via `/connect` in the TUI
- Models: `kilo models [provider]`
- Sessions: `kilo session`, export/import via `kilo export` / `kilo import`

## Config + auth
- Config file: `~/.kilocode/config.json`
- First-time provider setup from the TUI using `/connect`

## Environment overrides
- `KILO_PROVIDER` to override active provider
- `KILOCODE_<FIELD>` for `kilocode` provider settings
- `KILO_<FIELD>` for other provider settings (e.g., `KILO_API_KEY`)

## Integration notes for Ode
- Kilo does not require channel-level model selection in Ode config.
- Emit `session.status` and `message.part.updated` events for live status.
- Prefer ACP for session lifecycle, content blocks, and structured tool/plan/message updates. Keep `kilo run --format json` as the compatibility fallback when ACP setup fails.
- ACP `session/request_permission` must be surfaced to the originating user and answered explicitly; never select an allow option automatically.

## Source
- https://kilo.ai/docs/code-with-ai/platforms/cli
