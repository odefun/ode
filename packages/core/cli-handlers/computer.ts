import {
  getChannelComputerUse,
  getChannelAgentProvider,
  getComputerGatewayConfig,
  setChannelComputerUse,
  setComputerGatewayConfig,
  type ChannelComputerUseConfig,
} from "@/config";
import { runComputerMcpServerFromEnv } from "@/computer/mcp-server";
import {
  getComputerSetupStatus,
  isComputerProviderSupported,
  openComputerPermissionSettings,
  requestComputerPermissions,
  runComputerSelfTest,
  setupComputerGateway,
} from "@/computer";

type Flags = Record<string, string | boolean | string[]>;

function parseFlags(args: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {};
  const positional: string[] = [];
  const repeatable = new Set(["origin", "app"]);
  const boolean = new Set([
    "headed", "headless", "global", "browser-only", "desktop-only", "no-request", "request", "reinstall",
    "json",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = rawName ?? "";
    if (boolean.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (repeatable.has(name)) {
      const existing = Array.isArray(flags[name]) ? flags[name] as string[] : [];
      flags[name] = [...existing, value];
    } else {
      flags[name] = value;
    }
  }
  return { flags, positional };
}

function printHelp(): void {
  console.log([
    "ode computer - configure and diagnose the local Computer Gateway",
    "",
    "Usage:",
    "  ode computer setup [--browser-only|--desktop-only] [--no-request] [--reinstall]",
    "  ode computer status [--channel <channelId>]",
    "  ode computer doctor",
    "  ode computer permissions [--request]",
    "  ode computer open-settings <screen-recording|accessibility>",
    "  ode computer self-test",
    "  ode computer enable [--channel <channelId>] [--browser observe|interact] [--desktop observe|control] [--origin <pattern>]... [--app <name>]... [--approval consequential|always|never] [--headed|--headless]",
    "  ode computer disable --channel <channelId>",
    "  ode computer disable --global",
    "",
    "Defaults are fail-closed. Global enablement and per-channel browser/desktop access are both required.",
    "Origin patterns and application names form allowlists. Use '*' only when the channel is fully trusted.",
  ].join("\n"));
}

async function status(channelId?: string): Promise<void> {
  const global = getComputerGatewayConfig();
  const result: Record<string, unknown> = { global };
  if (channelId) {
    const provider = getChannelAgentProvider(channelId);
    result.channel = {
      id: channelId,
      provider,
      supported: isComputerProviderSupported(provider),
      computerUse: getChannelComputerUse(channelId),
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

async function doctor(): Promise<void> {
  const report: Record<string, unknown> = await getComputerSetupStatus();
  if ((report.desktop as Record<string, unknown> | undefined)?.ready === true) {
    try {
      report.selfTest = await runComputerSelfTest();
    } catch (error) {
      report.selfTest = { passed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

async function setup(flags: Flags): Promise<void> {
  if (flags["browser-only"] === true && flags["desktop-only"] === true) {
    throw new Error("--browser-only and --desktop-only cannot be used together");
  }
  const report = await setupComputerGateway({
    browser: flags["desktop-only"] !== true,
    desktop: flags["browser-only"] !== true,
    requestPermissions: flags["no-request"] !== true,
    reinstallApp: flags.reinstall === true,
  });
  console.log(JSON.stringify(report, null, 2));
  if (flags["browser-only"] !== true && !report.desktop.ready) {
    console.log("\nFinish authorization in System Settings, then run `ode computer doctor`.");
    console.log("Ode needs Screen & System Audio Recording and Accessibility. No Full Disk Access is required.");
  }
}

function enable(flags: Flags): void {
  const channelId = typeof flags.channel === "string" ? flags.channel : "";
  if (flags.headed === true && flags.headless === true) {
    throw new Error("--headed and --headless cannot be used together");
  }
  const nextGlobal = setComputerGatewayConfig((config) => ({
    ...config,
    enabled: true,
    browserHeaded: flags.headed === true ? true : flags.headless === true ? false : config.browserHeaded,
  }));
  if (!channelId) {
    console.log(JSON.stringify({ global: nextGlobal }, null, 2));
    return;
  }
  const provider = getChannelAgentProvider(channelId);
  if (!isComputerProviderSupported(provider)) {
    throw new Error(`Computer Gateway supports opencode, claudecode, and codex; channel uses ${provider}`);
  }
  const current = getChannelComputerUse(channelId);
  const requestedBrowser = parseEnum(flags.browser, ["off", "observe", "interact"] as const);
  const requestedDesktop = parseEnum(flags.desktop, ["off", "observe", "control"] as const);
  const browser = requestedBrowser ?? (current.browser === "off" && current.desktop === "off" && !requestedDesktop
    ? "observe"
    : current.browser);
  const desktop = requestedDesktop ?? current.desktop;
  const approvalPolicy = parseEnum(flags.approval, ["consequential", "always", "never"] as const) ?? current.approvalPolicy;
  const next: ChannelComputerUseConfig = {
    ...current,
    browser,
    desktop,
    approvalPolicy,
    allowedOrigins: Array.isArray(flags.origin) ? flags.origin : current.allowedOrigins,
    allowedApps: Array.isArray(flags.app) ? flags.app : current.allowedApps,
  };
  setChannelComputerUse(channelId, next);
  console.log(JSON.stringify({ enabled: true, channelId, computerUse: next }, null, 2));
}

function disable(flags: Flags): void {
  if (flags.global === true) {
    const next = setComputerGatewayConfig((config) => ({ ...config, enabled: false }));
    console.log(JSON.stringify({ global: next }, null, 2));
    return;
  }
  const channelId = typeof flags.channel === "string" ? flags.channel : "";
  if (!channelId) throw new Error("--channel is required (or pass --global)");
  const current = getChannelComputerUse(channelId);
  const next: ChannelComputerUseConfig = { ...current, browser: "off", desktop: "off" };
  setChannelComputerUse(channelId, next);
  console.log(JSON.stringify({ channelId, computerUse: next }, null, 2));
}

function parseEnum<T extends string>(value: string | boolean | string[] | undefined, values: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Expected one of: ${values.join(", ")}`);
  }
  return value as T;
}

export async function handleComputerCommand(args: string[]): Promise<number> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help") {
    printHelp();
    return 0;
  }
  try {
    if (subcommand === "mcp") {
      await runComputerMcpServerFromEnv();
      return 0;
    }
    const { flags, positional } = parseFlags(args.slice(1));
    if (subcommand === "setup") {
      await setup(flags);
      return 0;
    }
    if (subcommand === "status") {
      await status(typeof flags.channel === "string" ? flags.channel : undefined);
      return 0;
    }
    if (subcommand === "doctor") {
      await doctor();
      return 0;
    }
    if (subcommand === "permissions") {
      const result = flags.request === true
        ? await requestComputerPermissions()
        : (await getComputerSetupStatus()).desktop;
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    if (subcommand === "open-settings") {
      const kind = positional[0];
      if (kind !== "screen-recording" && kind !== "accessibility") {
        throw new Error("Expected: ode computer open-settings <screen-recording|accessibility>");
      }
      await openComputerPermissionSettings(kind);
      console.log(`Opened Ode ${kind} settings.`);
      return 0;
    }
    if (subcommand === "self-test") {
      console.log(JSON.stringify(await runComputerSelfTest(), null, 2));
      return 0;
    }
    if (subcommand === "enable") {
      enable(flags);
      return 0;
    }
    if (subcommand === "disable") {
      disable(flags);
      return 0;
    }
    throw new Error(`Unknown computer subcommand: ${subcommand}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
