# Ode - Agent Notes

Ode is a Slack bot that bridges messages to OpenCode for AI-assisted coding.

## Architecture
- Entry: `src/index.ts`
- Config: `src/config/` (Zod env validation)
- Slack: `src/slack/` (Bolt app, commands, OAuth, formatting)
- OpenCode: `src/agents/opencode/` (SDK client)
- Storage: `src/storage/` (settings, sessions, active requests)

## Runtime behavior
- SDK event loop handles permission auto-approval
- Per-channel agents stored in `~/.config/ode/agents/{channelId}.md`
- Settings: `~/.config/ode/settings.json`
- Sessions: `~/.config/ode/sessions/`
- Bot replies in threads once mentioned
- Status updates include phases, tool progress, and elapsed time
- Status messages are preserved as an operation record
- When capturing screenshots, save images to the system temp folder and upload them to Slack as soon as possible

## Commands
- Dev: `bun run dev`
- Prod: `./start.sh`
- User: `@ode <message>` and `stop`

## Bun conventions
- Use Bun instead of Node.js
- Run: `bun run src/index.ts`
- Tests: `bun test`
- Prefer `Bun.file` over `node:fs`

## Skills
- Available skills: `agent-browser`, `slack-developer-researcher`, `opencode-developer-researcher`
- Use `agent-browser` for any browser automation tasks.
- If you discover new Slack/OpenCode updates during development, update the matching skill doc under `.opencode/skills/`.
