---
name: opencode-developer-researcher
description: Research OpenCode server and SDK documentation for debugging or integration work.
---
## What I do
- Review OpenCode server docs for connection, configuration, and debugging guidance.
- Read SDK docs for integration patterns, APIs, and workflow updates.
- Summarize relevant findings with links and practical troubleshooting steps.
- For Ode attachment input, map local images/resources/files to OpenCode SDK `FilePart` values with a `file://` URL, MIME type, and filename; keep text as `TextPart`.
- Consume `/global/event` as a mixed transport: ordinary events expose `payload.type` and `payload.properties`, while synchronized child-session updates can arrive as `payload.type = "sync"` with the real event nested in `payload.syncEvent.type` and `payload.syncEvent.data`.
- Treat sessions created with `parentID` as part of the root run. Task/subagent tool metadata can identify the child `sessionId`; normalize those events to the root run while preserving the source child session and title for status rendering.
- Use `/session/status` together with meaningful-event timestamps for idle detection. Do not infer completion from an empty status map alone, and do not time out while a question or permission interaction is pending.
- Treat `permission.asked` with `permission = "external_directory"` as a common automation event when agents read files under `/tmp` or another path outside the working directory. Ode auto-approves this permission with `reply = "always"` for ordinary IM, cron, and one-time task runs; all other permissions remain explicit IM questions.
- Give pending interactions their own bounded wait and retain the request id, permission, target patterns, last tool, and last meaningful event in run diagnostics. Cron/task runners must subscribe to the same session stream as ordinary IM requests and abort the native session when their outer deadline expires.
- Treat `permission.asked` with `permission = "external_directory"` as a common automation event when agents read files under `/tmp` or another path outside the working directory. Ode auto-approves this permission with `reply = "always"` for ordinary IM, cron, and one-time task runs; all other permissions remain explicit IM questions.
- Give pending interactions their own bounded wait and retain the request id, permission, target patterns, last tool, and last meaningful event in run diagnostics. Cron/task runners must subscribe to the same session stream as ordinary IM requests and abort the native session when their outer deadline expires.

## When to use me
Use this when you need to diagnose issues communicating with OpenCode servers or implement SDK features.
Ask clarifying questions if you need focus on a specific endpoint, transport, or SDK language.

## Sources
- https://opencode.ai/docs/server/
- https://opencode.ai/docs/sdk/
