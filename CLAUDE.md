# Ode - Project Context

Ode is a Slack bot that bridges messages to OpenCode for AI-assisted coding.

## Architecture

- **Entry**: `src/index.ts` - Main entry point, sets up Slack app and handlers
- **Config**: `src/config/` - Environment validation with Zod
- **Slack**: `src/slack/` - Slack Bolt app, commands, OAuth, formatting
- **OpenCode**: `src/opencode/` - SDK-based client using @opencode-ai/sdk
- **Storage**: `src/storage/` - Settings, session persistence, active request tracking

## Key Concepts

- Uses Slack Socket Mode (no public endpoints needed)
- OpenCode started via SDK (createOpencode) - auto-selects port
- SDK event loop handles permission auto-approval
- Per-channel agents.md stored in `~/.local/state/ode/agents/{channelId}.md`
- Settings stored in `~/.local/state/ode/settings.json`
- Sessions persisted to `~/.local/state/ode/sessions/`
- Thread tracking: bot responds in threads once mentioned

## User Experience Features

### Rich Progress Indicators
- Real-time status updates showing current operation phase
- Tool execution visibility with status icons (pending/running/completed/error)
- Todo/task list display with completion status
- Response preview during generation
- Elapsed time tracking

### Status Message Preservation
- Status messages are kept (not deleted) as operation record
- Shows final summary with tool/task completion counts
- Error messages include actionable suggestions

### Stability Features
- Session persistence to disk for crash recovery
- Message deduplication prevents double-processing
- Update throttling (500ms) prevents Slack rate limits
- Automatic recovery check on startup
- "stop" command to abort running requests

## Commands

Development: `bun run dev` (with hot reload)
Production: `./start.sh` (nodemon for auto-restart)

## User Commands

- `@ode <message>` - Start a conversation
- `stop` - Abort current running request in thread

## Bun Conventions

Default to using Bun instead of Node.js:
- `bun run src/index.ts` to run
- `bun test` for testing
- Bun automatically loads .env, no dotenv needed
- Prefer `Bun.file` over `node:fs` where applicable

## Testing

```bash
bun test
```
