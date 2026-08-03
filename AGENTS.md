# Ode - Agent Notes

ODE is a project that connects many AI coding agents with IM message apps. When developing or validating end-to-end behavior, test the full flow from the IM app: send a real message in Slack, Discord, or Lark, let Ode receive it, route it to the selected coding agent, and verify the reply/status/file upload back in the same IM thread.

## Architecture
- Runtime entry: `packages/core/index.ts`
- CLI entry: `packages/core/cli.ts`
- Config: `packages/config/` (Zod env/config validation, local `ode.json`, channel settings)
- Core orchestration: `packages/core/` (daemon, kernel, runtime, tasks, cron, Web/API server)
- IM adapters: `packages/ims/` (`slack`, `discord`, `lark`, shared inbound/delivery/runtime helpers)
- Agent adapters: `packages/agents/` (`opencode`, `claude`, `codex`, `kimi`, `kilo`, `qwen`, `goose`, `pi`, `openhands`, `codebuddy`, `crush`)
- Shared utilities: `packages/shared/` and `packages/utils/`
- Web UI: `packages/web-ui/` (settings, sessions, local config views)
- Live status harness: `packages/live-status-harness/`

## Runtime behavior
- Ode runs as a local daemon with a settings UI, starts configured IM runtimes, and watches config changes.
- Local config lives at `~/.config/ode/ode.json`.
- SQLite state lives at `~/.config/ode/inbox.db` for tasks, cron jobs, and related scheduler data.
- Sessions live under `~/.config/ode/sessions/`.
- Channel details include agent provider, model when supported, working directory, base branch, and system message.
- Bot replies and status updates should stay in the originating IM thread.
- Runtime status and final replies use ordinary Markdown text messages on Slack, Discord, and Lark; do not reintroduce Slack AI Card/streaming message formatting.
- Status updates include phases, tool progress, elapsed time, and are preserved as an operation record.
- Slack workspaces default to AI card status messages; use the workspace Status Messages setting to switch a Slack workspace back to legacy message updates.
- SDK/CLI event loops handle permission or question flows where supported; OpenCode and Claude question replies are wired through the adapter.
- When capturing screenshots, save images to the system temp folder and upload them with `ode send file` to the current thread as soon as possible.
- When merging PRs, do not delete the branch if the current worktree is on that branch.
- Developer-only Web UI surfaces must be hidden from end users by default. The `/dev` page and Dev Tools navigation are only visible when the daemon is started with `ODE_DEV=1` (also accepts `true`, `yes`, or `on`); do not add a persistent Web UI setting for this.

## Supported Integrations
- IM apps: Slack, Discord, Lark/Feishu.
- Agent providers: `opencode`, `claude`/`claudecode`, `codex`, `kimi`, `kilo`, `qwen`, `goose`, `pi`, `openhands`, `codebuddy`, `crush`.
- Model selection is provider-specific. OpenCode, Codex, Kilo, Pi, OpenHands, CodeBuddy, and Crush expose configured model lists in the Web UI.
- Coding agent credentials/configuration belong to each agent's own CLI/config files; Ode should call the CLI and should not become the secret/config owner for those tools.
- Structured transports are preferred where locally supported: OpenCode SDK, Claude Agent SDK streaming input, Codex App Server, and ACP for Kimi/Kilo/Goose. Keep a CLI fallback when protocol startup is unavailable.
- Inbound images/files are downloaded by the IM adapter into Ode's private attachment store and passed as `AgentInputPart`; never pass expiring IM URLs or IM authorization headers to agent providers.

## Commands
- Install deps: `bun run setup`
- Dev runtime: `bun run dev`
- Dev runtime + Web UI dev server: `bun run web:dev`
- Prod/local start from repo: `bun run start`
- Installed CLI start: `ode` or `ode start`
- Foreground CLI start: `ode --foreground`
- Status/logs: `ode status`, `ode log [--info|--error] [--tail [N]]`
- Restart/stop: `ode restart`, `ode stop`
- Onboarding/config: `ode onboard`, `ode onboarding`, `ode config`
- Build embedded Web UI: `bun run build:web`
- Typecheck: `bun run typecheck`
- Tests: `bun test`

## IM Usage
- Users talk to Ode from an IM app, usually by mentioning the bot in a channel/thread.
- Slack supports `/setting` style configuration from the bot interaction surface.
- Discord and Lark should follow the same normalized inbound/outbound thread semantics through `packages/ims/shared/`.
- For end-to-end QA, prefer a real configured workspace/channel over direct adapter calls; direct unit tests are useful but do not prove the IM flow.

## One-time Tasks (`ode task`)
- A Task is a one-shot scheduled prompt: the scheduler fires it exactly once at an absolute time, then posts the agent result back to the channel (or thread, if anchored).
- CLI:
  - `ode task create --time <ISO8601> --channel <channelId> --message "<prompt>" [--thread <threadId>] [--title <title>] [--agent <agentId>] [--run-now]`
  - `ode task list [--status pending|running|success|failed|cancelled] [--json]`
  - `ode task show <id>` / `ode task cancel <id>` / `ode task delete <id>` / `ode task run <id>`
- When `--thread` is set, the scheduler reuses the existing thread's session so the agent wakes up with full context. When `--thread` is omitted, the task posts as a new channel message under a synthetic thread (`task:{id}`).
- Agents should prefer scheduling a Task instead of blocking on long waits such as deploys, overnight builds, or approvals.
- Persistence: SQLite at `~/.config/ode/inbox.db` (table `tasks`); scheduler polls every 10s and uses `UPDATE ... WHERE status='pending'` for cross-process idempotency.
- HTTP API mirrors the CLI under `/api/tasks*`; the Web UI lives at Settings -> Tasks.

## Recurring Cron Jobs (`ode cron`)
- A cron job is a recurring scheduled prompt (5-field cron expression) that re-runs the same prompt as a fresh agent turn on schedule.
- CLI:
  - `ode cron create --schedule "<cron>" --channel <channelId> --message "<prompt>" [--title <title>] [--disabled] [--run-now]`
  - `ode cron list [--enabled | --disabled] [--json]` / `ode cron show <id> [--json]`
  - `ode cron update <id> [--schedule ...] [--channel ...] [--message ...] [--title ...] [--enabled | --disabled]`
  - `ode cron enable <id>` / `ode cron disable <id>` / `ode cron run <id>` / `ode cron delete <id>`
- Every run creates a fresh session + worktree (see `packages/core/cron/scheduler.ts`) so jobs start clean.
- Persistence: same `~/.config/ode/inbox.db` (table `cron_jobs`); scheduler polls every 15s and claims runs at the SQL level.
- HTTP API mirrors the CLI under `/api/cron-jobs*`; the Web UI lives at Settings -> Cron.

## Sending Files / Images (`ode send`)
- `ode send file <path> --channel <channelId> [--thread <threadId>] [--filename <name>] [--title <title>] [--comment <text>]` uploads any file to a chat channel.
- The command resolves platform (Slack / Discord / Lark) from the channel's configured workspace; agents do not need to know the underlying SDK.
- Visual testing workflows should save screenshots to `os.tmpdir()` and upload them directly into the current thread.

## Fetching Messages (`ode messages`)
- `ode messages get <threadId> --channel <channelId> [--limit N] [--download-attachments] [--json]` returns a bounded root + latest-replies view of a thread (default 20 messages, maximum 50, maximum 64 KiB serialized output).
- `--download-attachments` stores files in Ode's private attachment store and adds stable `localPath` descriptors; without it, the command returns attachment metadata only and never exposes expiring/private IM URLs.
- Use it to re-read the current thread, pick up a follow-up comment posted while tools were running, or inspect another thread by root id.

## Reactions (`ode reaction`)
- `ode reaction add <messageId> --channel <channelId> --emoji <thumbsup|eyes|ok_hand> [--thread <threadId>]` reacts to a message.
- Useful acks: `eyes` = "I'm on it", `thumbsup` = "done", `ok_hand` = "acknowledged".

## Platform APIs
- Ode no longer exposes a generic `/api/action` bridge; agents must use the dedicated `ode <verb>` CLIs above instead of calling Slack/Discord/Lark APIs directly.
- Adding a new platform-facing capability means adding or extending an `ode` subcommand plus a matching daemon route.

## Bun Conventions
- Use Bun instead of Node.js.
- Run TypeScript with `bun run <file>` or package scripts.
- Prefer `Bun.file` over `node:fs` for new file IO where practical, while respecting existing local style.

## Skills
- Available repo skills include `agent-browser`, `slack-developer-researcher`, `opencode-developer-researcher`, `codex-cli-reference`, `qwen-code-skill`, `goose-cli-skill`, `kimi-cli-skill`, and `kilo-cli-skill`.
- Use `agent-browser` for browser automation tasks.
- Use the matching CLI skill when changing or debugging an agent provider integration.
- If you discover new Slack/OpenCode/CLI-agent updates during development, update the matching skill doc under `.agents/skills/` (mirrored via `.claude/skills/` when present).

## Agent Live Status Workflow
- Use `packages/live-status-harness/fixed-prompt.md` as the baseline stream-capture prompt.
- Capture stream events with `bun run live-status:capture --provider <opencode|claudecode|codex|kimi|kilo|qwen|goose|pi|openhands|codebuddy|crush>`.
- Store raw ordered events in Redis under the harness keyspace (`harness:live_status:*`).
- Render status outputs from captured events with `bun run live-status:render --run-id <runId>`.
- Generate combined reports with `bun run live-status:report`.
- Keep harness scripts in `packages/live-status-harness/` so stream capture/testing stays decoupled from the normal Ode runtime.
- Before changing live status parsing/formatting, replay a captured run and verify output changes intentionally.
- For new agent integrations, add at least one harness fixture and one deterministic render test.
