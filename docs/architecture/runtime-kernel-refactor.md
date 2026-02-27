# Runtime Kernel Refactor (High Risk / High Return)

## Core goals

- Collapse overlapping runtime concepts into a small OO model.
- Isolate runtime state by `(bot + channel + thread)`.
- Move inbound policy to explicit platform adapters.
- Remove callback-heavy orchestration and string-scoped channel hacks.

## Target model

- `RuntimeKernel`: top-level orchestrator for all bot runtimes.
- `BotRuntime`: per bot lane (`BotKey`), owns inbound adapter + thread registry.
- `ThreadRuntimeRegistry`: lifecycle and TTL for thread actors.
- `ThreadRuntime`: actor queue per `ThreadKey`.
- `RequestRun`: one active model run (open request, stream processing, finalize).
- `KernelRuntimeFacade`: runtime ingress orchestration and delegation to kernel services.

## Key value objects

- `BotKey = { platform, botId }`
- `ThreadKey = { botKey, channelId, threadId }`
- `RawInboundEvent` (platform-neutral ingress payload)
- `InboundDecision = ignore | command | stop | message`

## Inbound flow

1. `PlatformGateway` emits `RawInboundEvent`.
2. `RuntimeKernel` resolves `BotRuntime` by `BotKey`.
3. `BotRuntime` uses platform `InboundAdapter` to evaluate inbound.
4. `message/stop` routes to `ThreadRuntime` via `ThreadRuntimeRegistry`.
5. stop handling is delegated to `stop-command` service.
6. `ThreadRuntime` serializes execution and launches `RequestRun`.

## Planned removals after parity

- `CoreStateMachine` (removed).
- `incoming-message-processor.execute(...)` callback style (removed).
- `scopeChannelId/parseScopedChannelId` string scoping (removed).
- monolithic `createCoreRuntime` closure as primary runtime model (replaced by `KernelRuntimeFacade`).

## Current status

- Kernel-only inbound path is live across Slack/Discord/Lark.
- Runtime execution lifecycle is consolidated in `packages/core/kernel/request-run.ts`.
- Session bootstrap, pending-question handling, stop handling, and recovery are in `packages/core/kernel/*`.
- `packages/core/runtime.ts` is a thin wrapper around `KernelRuntimeFacade`.

## Remaining gaps

- Migrate remaining platform-specific `/setting` launch UX from client-level handlers to gateway + kernel command handling end-to-end.

## Completed in this slice

- Added concrete platform gateway classes:
  - `packages/ims/slack/slack-gateway.ts`
  - `packages/ims/discord/discord-gateway.ts`
  - `packages/ims/lark/lark-gateway.ts`
- Added concrete inbound adapters for all platforms:
  - `packages/ims/slack/slack-inbound-adapter.ts`
  - `packages/ims/discord/discord-inbound-adapter.ts`
  - `packages/ims/lark/lark-inbound-adapter.ts`
- Introduced a kernel command service and wired `BotRuntime` command branch through it:
  - `packages/core/kernel/command-service.ts`
  - `packages/core/kernel/runtime-facade.ts`
- Added parity tests (ignore/stop/forward) per platform adapter:
  - `packages/ims/slack/slack-inbound-adapter.test.ts`
  - `packages/ims/discord/discord-inbound-adapter.test.ts`
  - `packages/ims/lark/lark-inbound-adapter.test.ts`

## Suggested next slice

1. Implement concrete platform gateways (`slack/discord/lark`) against `PlatformGateway`.
2. Add `DiscordInboundAdapter` and `LarkInboundAdapter` and move inline rules out of clients.
3. Introduce a real kernel `CommandService` and route setting commands through it.
4. Keep one parity test per platform for ignore/stop/forward behavior before removing remaining inline logic.

## Migration slices

1. Add value objects + new kernel skeleton (no behavior change).
2. Introduce `RuntimeKernel` behind compatibility wrapper.
3. Route one platform through adapters + `BotRuntime`.
4. Cut over remaining platforms.
5. Remove legacy concepts after test/harness parity.
