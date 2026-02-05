# Ode

Ode is a Chat bot that bridges your coding agents (currently only opencode, more coming soon) to your favourite chat apps.

![Ode demo](static/ode-demo.png)

## Motivation

* Why sit in front of your Mac all the time when you have options to work from anywhere, collaborate with your team, and leverage AI-powered coding assistance?
* Just one setup on your Mac or VPS server, anyone in your team can work on it.
* Bring everyone to this agentic coding era, just chat.

## Why Slack & OpenCode

* Slack has thread based messaging, making it easy to port to sessions in coding agents. Just focus on one thing in one thread.
* OpenCode is open-source, powerful, and has server / client architecture, enabling seamless integration with IM clients like Slack.

## Features

- **Slack Socket Mode**: Secure real-time messaging without webhooks
- **OpenCode Integration**: Execute AI coding tasks via OpenCode's HTTP API
- **Thread Tracking**: Maintains context within conversation threads
- **Local Settings UI**: Web interface to manage Ode config in local mode
- **Live message updates**: OpenCode messages are updated real-time in slack messages
- **More than text**: Ode bot can send you images, give you buttons that utilize slack's interactive ability.

## Setup

### Prerequisites

- OpenCode installed configured
- Register a Slack Bot with Socket Mode enabled, give event permissions and some chat permissions.

### Installation

One-line install (macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/odefun/ode/main/scripts/install.sh | bash
```

Upgrade:

```bash
ode upgrade
```

## Running

Local mode (starts the settings UI automatically):

```bash
ode 
# ODE_WEB_HOST=0.0.0.0 ode if you want to expose setting page
```

Settings UI:

```
http://127.0.0.1:9293
```

## Usage

1. Invite the bot to a channel
2. Mention the bot or reply in an active thread
3. The bot will process your message with OpenCode and reply

## Worktrees

- Each session uses a dedicated git worktree at `<repoRoot>/.worktree/<sessionId>`
- On first use, Ode pulls `origin/main`, creates the worktree, and copies `.env` if it exists

## Local Settings UI

The local settings UI exposes `http://<ODE_WEB_HOST>:<ODE_WEB_PORT>/local-setting` and lets you edit:
- OpenCode server list and models
- Slack workspace tokens and channels
- Per-channel model + dev server selection
- Working directory per channel

## License

MIT
