# Ode

[English](README.md)

Ode 是一个编程代理工具，可将你的编码Agent（OpenCode、Claude Code、Codex 等）连接到你常用的聊天应用中（Slack、Discord、Lark）。非常适合个人开发者或团队在移动场景下协作开发。

![Ode demo](static/ode-demo.png)

## 核心特性

* 🏖️ 随时随地编码，在 Slack 中聊天即可获得响应。
* 🖇️ **将编码会话与 Slack 线程 1:1 映射**，并结合 worktree 实现隔离开发，轻松并行协作。
* 👬 频道内任何人都可以直接参与编码，无需额外配置，**一个账号可供团队成员共享使用**。
* 📝 **消息实时更新**，不再盲等回复，你可以通过实时文本更新持续跟踪进度。
* 📎 **图片和文件输入**，可直接在 Slack、Discord 或飞书消息中附加截图、文档和源码文件，并以结构化输入传给编码代理。
* 🐙 **按用户设置git信息**，由谁发起线程，就以谁作为对应提交作者。 (Run @bot /gh)

Ode 会优先使用各代理的结构化接口：Codex App Server、Claude Agent SDK Streaming Input、OpenCode SDK，以及 Kimi、Kilo、Goose 的 ACP。其他代理继续使用各自支持的流式 CLI 格式。编码代理凭据仍由本机 CLI 自己管理，Ode 不保存 API Key。

## 和OpenClaw的比较

* Ode专注于基于**线程**的消息列表，更适合编程或者需要管理不同任务的工作。一个线程只聚焦一件事。
* 支持**动态消息更新**、类Markdown文本渲染，Ode非常适合展示编码相关信息，给你更多的信心。
* **基于频道的设置**，可在同一台机器和同一个Slack工作区中轻松配置多个工作目录。
* 我们也希望后续支持尽可能多的聊天工具。

## 安装与配置

### 前置要求

- 已配置 OpenCode / Claude Code / Codex / Kimi Code... 至少一个编码 CLI。
- 选择并配置一个Chat App
  - **Slack** - follow [doc](https://ode.fun/docs/chat-app-setup/slack) and to get your APP TOKEN (xapp...) and BOT TOKEN (xbot..).
  - **Discord** - follow [doc](https://ode.fun/docs/chat-app-setup/discord) and to get your BOT TOKEN.
  - **飞书** - Just CN version for now, as Lark global is not supportting long connection with socket yet. Prepare the larkAppId and larkAppSecret.

### 安装与运行

一行安装（macOS/Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/odefun/ode/main/scripts/install.sh | bash
```

```bash
ode
# 如果你想暴露设置页面，可使用 ODE_WEB_HOST=0.0.0.0 ode
```

设置界面可通过 http://127.0.0.1:9293 访问，或在 Slack 中使用 `/setting` 命令，例如 `@bot /setting`。

## 代理列表

| 代理 | Logo | Link |
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

## 聊天应用列表

| 聊天应用 | Logo | Link |
| --- | --- | --- |
| Slack | <img src="https://img.shields.io/badge/Slack-111111?style=for-the-badge&logo=slack&logoColor=white" alt="Slack logo" /> | [slack.com](https://slack.com/) |
| Discord | <img src="https://img.shields.io/badge/Discord-111111?style=for-the-badge&logo=discord&logoColor=white" alt="Discord logo" /> | [discord.com](https://discord.com/) |
| 飞书（CN） | <img src="https://img.shields.io/badge/Lark-111111?style=for-the-badge&logo=lark&logoColor=white" alt="Lark logo" /> | [www.larksuite.com](https://www.larksuite.com/) |

## 使用方式

1. 邀请机器人进入一个频道。
2. 执行 `@bot /setting`，选择频道设置，选择你的编码 CLI（OpenCode 也可选择模型）以及工作目录。
3. 使用 `@bot` 并附上你的提示词，也可以同时添加图片或文件附件。
4. 机器人会调用编码代理处理你的消息。

## Worktree

- 每个 Slack 线程都会使用一个独立的 git worktree，路径为 `<repoRoot>/.worktree/<threadId>`。
- 如果你不想使用 worktree，可执行 `@bot /setting`，进入通用设置并选择默认模式。

## 许可证

MIT
