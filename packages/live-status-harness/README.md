# Live Status Harness

Standalone harness for collecting real agent stream events and replaying them into live status messages. OpenCode sync envelopes are normalized during capture so root and child-session events replay through the same provider-neutral path used by Ode.

## Why

This module isolates stream capture and status rendering from the normal Ode runtime so agent live-status changes are testable, deterministic, and safe to iterate.

## Fixed Prompt

The baseline prompt is stored in `packages/live-status-harness/fixed-prompt.md`.

## Capture stream data into Redis

```bash
bun run packages/live-status-harness/scripts/capture-stream.ts --provider opencode --model openai/gpt-5.3-codex
```

When `--provider opencode` is used, the harness starts its own dedicated OpenCode server at `http://127.0.0.1:40960` for that capture run.

In local mode, `opencode` capture should include `--model` unless your channel model is already configured in `~/.config/ode/ode.json`.

Optional flags:

- `--provider opencode|claudecode|codex|kimi|kilo|qwen|goose|pi|openhands|codebuddy|crush`
- `--cwd <path>`
- `--channel <id>`
- `--thread <id>`
- `--user <id>`
- `--run-id <id>`
- `--prompt-file <path>`
- `--model <provider/model>` (or `<model>`, defaults provider to `openai`)
- `--agent <id>` (for example `plan`)
- `--redis-prefix <prefix>`

## Render captured data into live status output

```bash
bun run packages/live-status-harness/scripts/render-status.ts --run-id <runId>
```

If `--run-id` is omitted, the latest run in Redis is used.

## Generate a full provider report markdown

```bash
bun run packages/live-status-harness/scripts/generate-report.ts
```

This runs capture + render for each provider (`opencode`, `claudecode`, `codex`, `kimi`, `kilo`, `qwen`, `goose`, `pi`, `openhands`, `codebuddy`, `crush`).

When possible, report generation reuses the latest Redis run for each provider and skips capture. If no Redis stream data exists for a provider, it captures a new run.

By default, it writes one report per provider:

- `packages/live-status-harness/reports/opencode.md`
- `packages/live-status-harness/reports/claudecode.md`
- `packages/live-status-harness/reports/codex.md`
- `packages/live-status-harness/reports/kimi.md`
- `packages/live-status-harness/reports/kilo.md`
- `packages/live-status-harness/reports/qwen.md`
- `packages/live-status-harness/reports/goose.md`
- `packages/live-status-harness/reports/pi.md`
- `packages/live-status-harness/reports/openhands.md`
- `packages/live-status-harness/reports/codebuddy.md`
- `packages/live-status-harness/reports/crush.md`

Use `--providers <list>` to run only specific providers.

For `opencode`, the report run forces model `openai/gpt-5.3-codex` so it does not depend on channel-level model config.

For `pi` and `openhands`, the report run forces `anthropic/claude-sonnet-4-5-20250929`; for `codebuddy` and `crush`, it forces `gpt-5.1` through their configured OpenAI-compatible providers.

Optional flags:

- `--providers opencode,claudecode,codex,kimi,kilo,qwen,goose,pi,openhands,codebuddy,crush`
- `--run-id <id>` reuse an existing captured run (requires exactly one provider and skips capture)
- `--layout split|combined|both` (default: `split`)
- `--output-dir <path>` for provider files (default: `packages/live-status-harness/reports`)
- `--output <path>` for combined file (default: `packages/live-status-harness/reports/agent-live-status.md`)
- `--cwd <path>`
- `--prompt-file <path>`
- `--redis-prefix <prefix>`
- `--fail-fast` to stop on first provider failure

## Redis keys

- `<prefix>:runs:index` sorted set of run ids
- `<prefix>:runs:<runId>:meta` run metadata JSON
- `<prefix>:runs:<runId>:events` ordered stream events (OpenCode transport envelopes are normalized)
- `<prefix>:runs:<runId>:rendered` rendered live statuses JSON
