# Ode

[Official Doc](https://ode.fun/docs/quickstart)

Ode is a agent tool that bridges your coding agents (OpenCode, Claude Code, Codex and much more) to your favorite chat apps (Slack, Discord, and Lark). Perfect for personal or team developers working on the go.

![Ode demo](static/ode-demo.png)

## Highlight features

* 🏖️ Coding from anywhere, just chat and get response in slack or discord.
* 🖇️ **Map coding sessions 1 - 1 to chat threads**, and use worktree to get isolated, parallel coding is so easy.
* 👬 Anyone in the channel can join coding without any extra setup, **pay one account for all team members**.
* 📝 **Message live message updates**, you don't wait for response without any information, you can monitor from real-time text updates.
* 📎 **Image and file input**, attach screenshots, documents, or source files in Slack, Discord, or Lark and Ode forwards structured content to the coding agent.
* 🐙 **Per user git config**, who start the thread becomes corresponding git commit author. (Run @bot /setting)

Ode prefers each agent's structured integration surface: Codex App Server, Claude Agent SDK streaming input, OpenCode SDK, and ACP for Kimi, Kilo, and Goose. Other agents continue to use their supported streaming CLI format. Agent credentials remain owned by the local CLI; Ode does not store API keys.

## Compare with OpenClaw

* OpenClaw is greate, but Ode utilize **thread based** messaging to organize things better, making it easy to port sessions in coding agents directly to chat apps. Just work on one thing in one thread.
* Ode provide **live message updates**, you can monitor from real-time text updates for more confident.
* **Channel based settings** lets you configure multiple work directories easily in one machine and one slack workspace.
* **Work in parallel**, multiple threads can work together and isolated by worktree, multiple channels can also work together, just send messages.
* **Team focused**, just allow people to join channel to give them permissions to work together.
* Ode supports multiple chat tools including Slack, Discord, and Lark.

## Setup

### Prerequisites

- Configured OpenCode / Claude Code / Codex / Kimi Code... at least 1 coding cli.
- Choose one chatting app.
  - **Slack** - follow [this doc](https://ode.fun/docs/chat-app-setup/slack) to get your APP TOKEN (xapp...) and BOT TOKEN (xbot..).
  - **Discord** - follow [this doc](https://ode.fun/docs/chat-app-setup/discord) to get your BOT TOKEN.
  - **飞书** - Just CN version for now, as Lark global is not supportting long connection with socket yet. Prepare the larkAppId and larkAppSecret.

### Installation and Running

One-line install (macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/odefun/ode/main/scripts/install.sh | bash
```

```bash
ode 
# ODE_WEB_HOST=0.0.0.0 ode if you want to expose setting page
```

Settings UI can be accessible via http://127.0.0.1:9293 or use `/setting` command in slack like `@bot /setting`.

## Agent List

| Agent | Logo | Link |
| --- | --- | --- |
| Claude Code | <img src="https://img.shields.io/badge/Claude_Code-111111?style=for-the-badge&logo=anthropic&logoColor=white" alt="Claude Code logo" /> | [docs.anthropic.com/claude-code](https://docs.anthropic.com/en/docs/claude-code/overview) |
| CodeBuddy | <img src="https://img.shields.io/badge/CodeBuddy-111111?style=for-the-badge&logo=codebuddy&logoColor=white" alt="CodeBuddy logo" /> | [codebuddy.ai/docs/cli](https://www.codebuddy.ai/docs/cli/overview) |
| Codex | <img src="https://img.shields.io/badge/Codex-111111?style=for-the-badge&logo=openai&logoColor=white" alt="Codex logo" /> | [github.com/openai/codex](https://github.com/openai/codex) |
| Crush | <img src="https://img.shields.io/badge/Crush-111111?style=for-the-badge&logo=charm&logoColor=white" alt="Crush logo" /> | [github.com/charmbracelet/crush](https://github.com/charmbracelet/crush) |
| Goose CLI | <img src="https://img.shields.io/badge/Goose_CLI-111111?style=for-the-badge&logo=go&logoColor=white" alt="Goose CLI logo" /> | [block.github.io/goose](https://block.github.io/goose/) |
| Kimi Code | <img src="https://img.shields.io/badge/Kimi_Code-111111?style=for-the-badge&logo=moonrepo&logoColor=white" alt="Kimi Code logo" /> | [moonshotai.github.io/kimi-cli](https://moonshotai.github.io/kimi-cli/) |
| Kilo Code | <img src="https://img.shields.io/badge/Kilo_Code-111111?style=for-the-badge&logo=codeium&logoColor=white" alt="Kilo Code logo" /> | [kilo.ai/docs/code-with-ai/platforms/cli](https://kilo.ai/docs/code-with-ai/platforms/cli) |
| OpenCode | <img src="https://img.shields.io/badge/OpenCode-111111?style=for-the-badge&logo=opencollective&logoColor=white" alt="OpenCode logo" /> | [opencode.ai](https://opencode.ai/) |
| OpenHands | <img src="https://img.shields.io/badge/OpenHands-111111?style=for-the-badge&logo=openai&logoColor=white" alt="OpenHands logo" /> | [docs.openhands.dev](https://docs.openhands.dev/) |
| Pi | <img src="https://img.shields.io/badge/Pi-111111?style=for-the-badge&logo=pi&logoColor=white" alt="Pi logo" /> | [github.com/earendil-works/pi](https://github.com/earendil-works/pi) |
| Qwen Code | <img src="https://img.shields.io/badge/Qwen_Code-111111?style=for-the-badge&logo=alibabacloud&logoColor=white" alt="Qwen Code logo" /> | [github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) |

## Chat App List

| Chat App | Logo | Link |
| --- | --- | --- |
| Slack | <img src="https://img.shields.io/badge/Slack-111111?style=for-the-badge&logo=slack&logoColor=white" alt="Slack logo" /> | [slack.com](https://slack.com/) |
| Discord | <img src="https://img.shields.io/badge/Discord-111111?style=for-the-badge&logo=discord&logoColor=white" alt="Discord logo" /> | [discord.com](https://discord.com/) |
| 飞书（CN） | <img src="https://img.shields.io/badge/Lark-111111?style=for-the-badge&logo=lark&logoColor=white" alt="Lark logo" /> | [www.larksuite.com](https://www.larksuite.com/) |

## Usage

1. Invite the bot to a channel.
2. Run `@bot /setting`, select channel setting, choose your coding cli (opencode also can choose model) and working directory.
3. @ your bot with the prompt you want, optionally with image or file attachments.
4. The bot will process your message with the coding agent.

## Computer Gateway (local)

Ode can expose the same policy-controlled browser and macOS desktop tools to Codex, Claude Code, and OpenCode. Browser automation uses a local, pinned [`agent-browser`](https://github.com/vercel-labs/agent-browser) installation. Desktop capture and control run inside the signed `Ode.app`; there is no cloud browser or separately authorized desktop provider.

1. Run `ode computer setup`, or choose **Set up Ode** under Settings → General → Computer Gateway. Ode installs the browser driver and registers `Ode.app` on macOS.
2. Allow **Ode** under Screen & System Audio Recording and Accessibility when macOS asks. These are the only two required macOS permissions; Full Disk Access is not requested. Run `ode computer permissions --request` to show the prompts again, or use `ode computer open-settings <screen-recording|accessibility>`.
3. In the workspace channel settings, choose browser `Observe` or `Interact`, desktop `Observe` or `Control`, then configure allowed origins/apps and an approval policy. The CLI equivalent starts with `ode computer enable --channel <channelId>` (safe default: browser observe-only).
4. Verify installation, permissions, screen capture, and Accessibility probing with `ode computer doctor` or `ode computer self-test`; inspect the active policy with `ode computer status`.

The gateway listens only on loopback, authenticates every provider call with a per-context token, rejects origins/apps outside each channel's allowlist, invalidates stale observations before actions, serializes desktop control, and sends approval requests back to the originating IM thread. Audit records are written to `~/.config/ode/computer-audit.jsonl` without action values.

### macOS release credentials

Release builds require a Developer ID Application identity and Apple notarization. Configure these GitHub Actions secrets before publishing a release:

- `MACOS_CERTIFICATE_P12`: base64-encoded PKCS#12 identity.
- `MACOS_CERTIFICATE_PASSWORD`: PKCS#12 export password.
- `MACOS_CODESIGN_IDENTITY`: the full Developer ID Application identity name.
- `APPLE_NOTARIZATION_ID`: Apple Account email used for notarization.
- `APPLE_NOTARIZATION_PASSWORD`: app-specific password for `notarytool`, not the Apple Account password.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

The release workflow signs every nested executable, submits the app archive to Apple's notary service, staples the accepted ticket to `Ode.app`, validates it with `stapler` and Gatekeeper, and only then creates the published zip.

## Worktrees

- Each slack thread uses a dedicated git worktree at `<repoRoot>/.worktree/<threadId>`
- If you don't want to use worktree, can run `@bot /setting` and select general setting, choose default.

## License

MIT
