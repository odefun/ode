---
name: codex-cli-reference
description: Reference guide for Codex CLI commands, global flags, and model/sandbox overrides.
---
## What I do
- Provide quick, accurate lookup for Codex CLI commands and flags from the official reference.
- Explain configuration precedence for CLI runs: `-c` overrides > explicit command flags (like `--model`) > profile/default config.
- Give safe command examples for interactive and non-interactive (`codex exec`) workflows.

## When to use me
Use this when you need to:
- pick the right Codex CLI command (`exec`, `resume`, `features`, `mcp`, etc.),
- confirm exact meanings of flags (`--model`, `--sandbox`, `--full-auto`, `--ask-for-approval`),
- map config values in `~/.codex/config.toml` to one-off overrides.

## Core flags at a glance
- `--model, -m <slug>`: override configured model for this run (example: `gpt-5-codex`).
- `--sandbox, -s <mode>`: set command sandbox (`read-only`, `workspace-write`, `danger-full-access`).
- `--ask-for-approval, -a <policy>`: control approval behavior (`untrusted`, `on-failure`, `on-request`, `never`).
- `--full-auto`: shorthand for lower-friction automation (`on-request` + `workspace-write`).
- `--dangerously-bypass-approvals-and-sandbox`: current explicit unattended `exec` flag; prefer it over the hidden legacy `--yolo` alias when Ode already provides the external isolation boundary.
- `-c, --config key=value`: one-off config override for the invocation.

## Common examples
```bash
# Interactive TUI with explicit model
codex --model gpt-5.3-codex

# Non-interactive run with JSON events
codex exec --json --model gpt-5.3-codex "summarize this repo"

# Resume most recent session with model override
codex resume --last --model gpt-5.3-codex
```

## Sources
- https://developers.openai.com/codex/cli/reference/
- https://developers.openai.com/codex/config-basic/
