# Ode

Ode is a Slack bot that bridges chat messages to OpenCode, enabling AI-assisted coding directly from Slack channels.

## Features

- **Slack Socket Mode**: Secure real-time messaging without webhooks
- **OpenCode Integration**: Execute AI coding tasks via OpenCode's HTTP API
- **Per-Channel Agents.md**: Custom system instructions per Slack channel
- **Thread Tracking**: Maintains context within conversation threads
- **OAuth Flow**: Connect OpenAI Codex for provider authentication
- **Auto-Restart**: Built-in nodemon integration for reliability

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- OpenCode installed and in PATH
- Slack App with Socket Mode enabled

### Installation

```bash
bun install
```

### Configuration

Copy `.env.example` to `.env` and fill in your Slack credentials:

```bash
cp .env.example .env
```

Required environment variables:
- `SLACK_BOT_TOKEN` - Bot User OAuth Token (xoxb-...)
- `SLACK_APP_TOKEN` - App-Level Token with Socket Mode (xapp-...)
- `SLACK_SIGNING_SECRET` - Signing secret from Slack app settings

Optional:
- `SLACK_TARGET_CHANNELS` - Comma-separated channel IDs to restrict bot
- `OPENCODE_BINARY` - Path to opencode (default: "opencode")
- `OPENCODE_PORT` - OpenCode server port (default: 4096)
- `DEFAULT_CWD` - Default working directory

### Running

Development mode (with hot reload):
```bash
bun run dev
```

Production mode (with nodemon auto-restart):
```bash
./start.sh
```

Check status:
```bash
./status.sh
```

Stop:
```bash
./stop.sh
```

## Slack Commands

- `/ode help` - Show available commands
- `/ode cwd [path]` - View or set working directory
- `/ode agents` - View channel's agents.md
- `/ode agents edit` - Edit channel's agents.md (opens modal)
- `/ode agents clear` - Clear channel's agents.md
- `/ode stop` - Stop current operation
- `/ode clear` - Clear all sessions
- `/ode config` - View OpenCode configuration
- `/ode config edit` - Edit OpenCode config (agent, model, provider)
- `/ode gh auth` - Authenticate GitHub CLI (per Slack user, with base fallback, SSH)
- `/ode oauth` - Start OpenAI Codex OAuth flow

GitHub auth notes: Git operations use SSH, so ensure your SSH key is added to GitHub. PAT should include `repo`, plus `read:org` for org repositories, and `workflow` if managing Actions.

## Usage

1. Invite the bot to a channel
2. Mention the bot or reply in an active thread
3. The bot will process your message with OpenCode and reply

### Per-Channel Instructions

Use `/ode agents edit` to set custom system instructions for a channel. These are prepended to every OpenCode request in that channel.

## Architecture

```
src/
├── config/       # Environment configuration
├── opencode/     # OpenCode server management and HTTP client
├── slack/        # Slack app, commands, and formatting
├── storage/      # Settings and session persistence
└── index.ts      # Main entry point
```

## License

MIT
