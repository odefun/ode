---
name: slack-developer-researcher
description: Research Slack developer docs for updated APIs and AI app development guidance.
---
## What I do
- Read Slack developer documentation for current API updates and deprecations.
- Check the AI app development docs for the latest Slack AI bot workflow.
- Summarize relevant changes with links and practical migration notes.

## When to use me
Use this when you need to validate Slack API changes or plan updates for the new AI bot stack.
Ask clarifying questions if you need to focus on specific endpoints, scopes, or platform features.

## Sources
- https://docs.slack.dev/apis/
- https://docs.slack.dev/reference/events
- https://docs.slack.dev/ai/developing-ai-apps

## Current thread pagination note
- `conversations.replies` is cursor-paginated and returns the earliest messages first. To read the latest replies from a long thread, traverse `response_metadata.next_cursor` and retain a bounded tail.
- Slack recommends pages of no more than 200. Marketplace and internal customer-built apps use Tier 3 limits; commercially distributed non-Marketplace apps may be restricted to 1 request/minute and 15 items per page.
