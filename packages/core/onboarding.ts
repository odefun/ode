import { createInterface, type Interface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import {
  getWebHost,
  getWebPort,
  isLocalMode,
  loadOdeConfig,
  saveOdeConfig,
  type OdeConfig,
  type WorkspaceConfig,
} from "@/config";
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_COMMANDS,
  getAgentProviderLabel,
  type AgentProviderId,
} from "@/shared/agent-provider";
import { getInstalledAgentStatus } from "@/core/web/agent-check";
import { discoverDiscordWorkspace, discoverLarkWorkspace, discoverSlackWorkspace } from "./web/local-settings";

type AgentOption = {
  id: AgentProviderId;
  label: string;
  command: string;
  installed: boolean;
};

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(rl: Interface, prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function selectSingleOptionWithKeyboard(
  title: string,
  options: string[],
  defaultIndex = 0
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultIndex;
  }

  return new Promise((resolve) => {
    let cursor = Math.max(0, Math.min(defaultIndex, options.length - 1));
    const lineCount = options.length + 2;

    const render = (initial = false): void => {
      if (!initial) {
        process.stdout.write(`\x1b[${lineCount}F`);
      }
      process.stdout.write("\x1b[J");
      console.log(title);
      console.log("Use Up/Down to move, Enter to confirm.");
      for (const [index, option] of options.entries()) {
        const pointer = index === cursor ? ">" : " ";
        console.log(` ${pointer} ${option}`);
      }
    };

    const cleanup = (): void => {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const finalize = (): void => {
      const selected = cursor;
      cleanup();
      process.stdout.write("\n");
      resolve(selected);
    };

    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (key.name === "up") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
        return;
      }

      if (key.name === "down") {
        cursor = (cursor + 1) % options.length;
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finalize();
      }
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render(true);
  });
}

async function askYesNo(rl: Interface, prompt: string, defaultValue: boolean): Promise<boolean> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    rl.pause();
    try {
      const yesIndex = defaultValue ? 0 : 1;
      const choice = await selectSingleOptionWithKeyboard(prompt, ["Yes", "No"], yesIndex);
      return choice === 0;
    } finally {
      rl.resume();
    }
  }

  const suffix = defaultValue ? " [Y/n]: " : " [y/N]: ";
  while (true) {
    const answer = (await ask(rl, `${prompt}${suffix}`)).toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("Please enter y or n.");
  }
}

async function askRequired(rl: Interface, prompt: string): Promise<string> {
  while (true) {
    const value = await ask(rl, prompt);
    if (value.length > 0) return value;
    console.log("Value is required.");
  }
}

function detectAgents(): AgentOption[] {
  const installed = getInstalledAgentStatus();
  return AGENT_PROVIDERS.map((id) => ({
    id,
    label: getAgentProviderLabel(id),
    command: AGENT_PROVIDER_COMMANDS[id],
    installed: installed[id],
  }));
}

async function selectAgentsWithKeyboard(agents: AgentOption[], defaultSelected: number[]): Promise<number[]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return defaultSelected;
  }

  return new Promise((resolve) => {
    const selected = new Set(defaultSelected.map((index) => index - 1));
    let cursor = 0;
    const lineCount = agents.length + 2;

    const render = (initial = false): void => {
      if (!initial) {
        process.stdout.write(`\x1b[${lineCount}F`);
      }
      process.stdout.write("\x1b[J");
      console.log("Step 2/2: Select coding agents to enable.");
      console.log("Use Up/Down to move, Space to toggle, Enter to confirm.");
      for (const [index, agent] of agents.entries()) {
        const pointer = index === cursor ? ">" : " ";
        const checked = selected.has(index) ? "x" : " ";
        const status = agent.installed ? "installed" : "not found";
        console.log(` ${pointer} [${checked}] ${agent.label} (${agent.command}) - ${status}`);
      }
    };

    const cleanup = (): void => {
      process.stdin.off("keypress", onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const finalize = (): void => {
      cleanup();
      process.stdout.write("\n");
      resolve(Array.from(selected).sort((a, b) => a - b).map((index) => index + 1));
    };

    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.kill(process.pid, "SIGINT");
        return;
      }

      if (key.name === "up") {
        cursor = (cursor - 1 + agents.length) % agents.length;
        render();
        return;
      }

      if (key.name === "down") {
        cursor = (cursor + 1) % agents.length;
        render();
        return;
      }

      if (key.name === "space") {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finalize();
      }
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    render(true);
  });
}

async function askWorkspaceType(rl: Interface): Promise<"slack" | "discord" | "lark"> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    rl.pause();
    try {
      const choice = await selectSingleOptionWithKeyboard(
        "Workspace type:",
        ["Slack", "Discord", "Lark"],
        0
      );
      return choice === 0 ? "slack" : choice === 1 ? "discord" : "lark";
    } finally {
      rl.resume();
    }
  }

  while (true) {
    const value = (await ask(rl, "Workspace type ([s]lack / [d]iscord / [l]ark): ")).toLowerCase();
    if (value === "s" || value === "slack") return "slack";
    if (value === "d" || value === "discord") return "discord";
    if (value === "l" || value === "lark") return "lark";
    console.log("Please enter slack, discord, or lark.");
  }
}

function printConnectedWorkspaces(workspaces: WorkspaceConfig[]): void {
  if (workspaces.length === 0) {
    console.log("No workspaces connected yet.");
    return;
  }

  console.log("Connected workspaces:");
  for (const workspace of workspaces) {
    const label = workspace.name || workspace.id;
    const domain = workspace.domain ? ` (${workspace.domain})` : "";
    const typeLabel = workspace.type === "discord" ? "Discord" : workspace.type === "lark" ? "Lark" : "Slack";
    const indicator = "\x1b[32m●\x1b[0m";
    console.log(`${indicator} [${typeLabel}] ${label}${domain}`);
  }
}

async function setupWorkspaces(rl: Interface, config: OdeConfig): Promise<OdeConfig> {
  console.log("Step 1/2: Workspace setup.");
  console.log("");
  let nextConfig = config;
  const existingWorkspaces = nextConfig.workspaces;
  printConnectedWorkspaces(existingWorkspaces);

  console.log("");

  const addWorkspace = await askYesNo(
    rl,
    "Add a new workspace now? You can skip and configure it later in the web UI.",
    existingWorkspaces.length === 0
  );

  if (!addWorkspace) {
    console.log("Skipped adding a new workspace.");
    return config;
  }

  while (true) {
    const workspaceType = await askWorkspaceType(rl);

    try {
      const discoveredWorkspace = workspaceType === "discord"
        ? await discoverDiscordWorkspace(await askRequired(rl, "Paste Discord bot token: "))
        : workspaceType === "lark"
          ? await discoverLarkWorkspace(
            await askRequired(rl, "Paste Lark app key: "),
            await askRequired(rl, "Paste Lark app secret: ")
          )
        : await discoverSlackWorkspace(
          await askRequired(rl, "Paste Slack app token (xapp-...): "),
          await askRequired(rl, "Paste Slack bot token (xoxb-...): ")
        );
      const workspace: WorkspaceConfig = {
        ...discoveredWorkspace,
        type: discoveredWorkspace.type,
        slackStatusMode: discoveredWorkspace.slackStatusMode === "legacy" ? "legacy" : "ai_card",
        slackAppToken: discoveredWorkspace.slackAppToken ?? "",
        slackBotToken: discoveredWorkspace.slackBotToken ?? "",
        discordBotToken: discoveredWorkspace.discordBotToken ?? "",
        larkAppKey: discoveredWorkspace.larkAppKey ?? discoveredWorkspace.larkAppId ?? "",
        larkAppId: discoveredWorkspace.larkAppKey ?? discoveredWorkspace.larkAppId ?? "",
        larkAppSecret: discoveredWorkspace.larkAppSecret ?? "",
        channelDetails: discoveredWorkspace.channelDetails.map((channel) => ({
          ...channel,
          agentProvider: channel.agentProvider ?? "opencode",
          baseBranch: channel.baseBranch?.trim() || "main",
          channelSystemMessage: channel.channelSystemMessage ?? "",
          ambientMode: false,
        })),
      };
      const existingWorkspace = nextConfig.workspaces.find((item) => item.id === workspace.id);
      if (existingWorkspace) {
        console.log(`Workspace already exists: ${existingWorkspace.name || existingWorkspace.id}`);
      } else {
        nextConfig = {
          ...nextConfig,
          workspaces: [...nextConfig.workspaces, workspace],
        };
        saveOdeConfig(nextConfig);
        const typeLabel = workspace.type === "discord" ? "Discord" : workspace.type === "lark" ? "Lark" : "Slack";
        console.log(`Connected ${typeLabel} workspace: ${workspace.name || workspace.id}`);
      }

      console.log("");
      printConnectedWorkspaces(nextConfig.workspaces);
      console.log("");

      const addAnother = await askYesNo(rl, "Add another workspace?", false);
      if (!addAnother) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Workspace setup failed: ${message}`);
      const retry = await askYesNo(rl, "Try workspace setup again?", true);
      if (!retry) break;
    }
  }

  return nextConfig;
}

async function setupCodingAgents(rl: Interface, config: OdeConfig): Promise<OdeConfig> {
  const agents = detectAgents();
  const defaultSelected = agents
    .map((agent, index) => ({ index, installed: agent.installed }))
    .filter((entry) => entry.installed)
    .map((entry) => entry.index + 1);

  rl.pause();
  let finalIndices: number[];
  try {
    finalIndices = await selectAgentsWithKeyboard(agents, defaultSelected);
  } finally {
    rl.resume();
  }
  const selectedIds = new Set<AgentProviderId>(
    finalIndices.map((index) => agents[index - 1]!.id)
  );

  if (selectedIds.size === 0) {
    selectedIds.add("opencode");
    console.log("No agents selected; defaulting to OpenCode.");
  }

  const nextConfig: OdeConfig = {
    ...config,
    agents: {
      ...config.agents,
      ...Object.fromEntries(
        AGENT_PROVIDERS.map((provider) => [
          provider,
          {
            ...config.agents[provider],
            enabled: selectedIds.has(provider),
          },
        ])
      ) as OdeConfig["agents"],
    },
  };

  saveOdeConfig(nextConfig);
  const enabledLabels = agents.filter((agent) => selectedIds.has(agent.id)).map((agent) => agent.label);
  console.log(`Enabled agents: ${enabledLabels.join(", ")}`);
  return nextConfig;
}

export async function runOnboarding(options?: { force?: boolean }): Promise<void> {
  if (!isLocalMode()) return;

  const force = options?.force === true;
  const config = loadOdeConfig();
  if (config.completeOnboarding && !force) return;

  if (!isInteractiveTerminal()) {
    console.log("Onboarding skipped: no interactive terminal detected.");
    console.log("Run ode in a terminal to complete onboarding.");
    return;
  }

  console.log("Welcome to Ode.");
  console.log("Let's run a quick setup.");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let nextConfig = config;
    nextConfig = await setupWorkspaces(rl, nextConfig);
    nextConfig = await setupCodingAgents(rl, nextConfig);
    nextConfig = {
      ...nextConfig,
      completeOnboarding: true,
    };
    saveOdeConfig(nextConfig);

    const enabledAgents = AGENT_PROVIDERS
      .filter((provider) => nextConfig.agents[provider].enabled)
      .map((provider) => getAgentProviderLabel(provider));
    console.log("Onboarding complete.");
    console.log(`Workspaces: ${nextConfig.workspaces.length}`);
    console.log(`Agents enabled: ${enabledAgents.join(", ")}`);
    console.log(`You can update settings later at http://${getWebHost()}:${getWebPort()}/.`);
  } finally {
    rl.close();
  }
}

export async function runOnboardingIfNeeded(): Promise<void> {
  await runOnboarding({ force: false });
}
