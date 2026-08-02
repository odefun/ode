import { getAnyServerUrl, startServer as startOpenCodeServer } from "@/agents/opencode";
import { type AgentProviderId } from "@/shared/agent-provider";

export type AgentInstallStatus = {
  opencode: boolean;
  claudecode: boolean;
  codex: boolean;
  kimi: boolean;
  kilo: boolean;
  qwen: boolean;
  goose: boolean;
  pi: boolean;
  openhands: boolean;
  codebuddy: boolean;
  crush: boolean;
};

export type AgentCheckResult = AgentInstallStatus & {
  readonly claude?: boolean;
  opencodeModels: string[];
  opencodeModelError?: string;
  kiloModels: string[];
  kiloModelError?: string;
  piModels: string[];
  piModelError?: string;
  openhandsModels: string[];
  openhandsModelError?: string;
  codebuddyModels: string[];
  codebuddyModelError?: string;
  crushModels: string[];
  crushModelError?: string;
};

export type AgentCheckProviderResult = Partial<AgentCheckResult>;

function extractProviderModelIds(providerId: string, models: unknown): string[] {
  if (Array.isArray(models)) {
    return models
      .map((entry) => {
        if (typeof entry === "string") return `${providerId}/${entry}`;
        if (!entry || typeof entry !== "object") return "";
        const model = entry as Record<string, unknown>;
        const modelId =
          (typeof model.id === "string" && model.id)
          || (typeof model.modelID === "string" && model.modelID)
          || (typeof model.modelId === "string" && model.modelId)
          || "";
        return modelId ? `${providerId}/${modelId}` : "";
      })
      .filter(Boolean);
  }

  if (models && typeof models === "object") {
    const record = models as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return extractProviderModelIds(providerId, record.items);
    }
    return Object.entries(record)
      .map(([key, value]) => {
        if (typeof value === "string") return `${providerId}/${value}`;
        if (value && typeof value === "object") {
          const model = value as Record<string, unknown>;
          const modelId =
            (typeof model.id === "string" && model.id)
            || (typeof model.modelID === "string" && model.modelID)
            || (typeof model.modelId === "string" && model.modelId)
            || key;
          return modelId ? `${providerId}/${modelId}` : "";
        }
        return key ? `${providerId}/${key}` : "";
      })
      .filter(Boolean);
  }

  return [];
}

function extractOpenCodeModels(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = payload as Record<string, unknown>;
  const providersRaw = Object.prototype.hasOwnProperty.call(data, "providers") ? data.providers : data;
  const models = new Set<string>();

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object") continue;
      const provider = entry as Record<string, unknown>;
      const providerId =
        (typeof provider.id === "string" && provider.id)
        || (typeof provider.providerID === "string" && provider.providerID)
        || (typeof provider.providerId === "string" && provider.providerId)
        || "";
      if (!providerId) continue;
      for (const model of extractProviderModelIds(providerId, provider.models)) {
        models.add(model);
      }
    }
  } else if (providersRaw && typeof providersRaw === "object") {
    for (const [providerId, providerValue] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (!providerValue || typeof providerValue !== "object") continue;
      const provider = providerValue as Record<string, unknown>;
      for (const model of extractProviderModelIds(providerId, provider.models)) {
        models.add(model);
      }
    }
  }

  return Array.from(models).sort();
}

async function fetchKiloModels(): Promise<string[]> {
  const child = Bun.spawn({
    cmd: ["kilo", "models"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const details = stderr.trim() || stdout.trim() || "Unknown error";
    throw new Error(details);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

async function runModelCommand(cmd: string[]): Promise<string> {
  const child = Bun.spawn({
    cmd,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const details = stderr.trim() || stdout.trim() || "Unknown error";
    throw new Error(details);
  }
  return stdout;
}

function parsePiModels(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0] !== "provider")
    .map((parts) => `${parts[0]}/${parts[1]}`)
    .filter(Boolean)
    .sort();
}

async function fetchPiModels(): Promise<string[]> {
  return parsePiModels(await runModelCommand(["pi", "--list-models", "anthropic"]));
}

async function fetchCrushModels(): Promise<string[]> {
  return (await runModelCommand(["crush", "models"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((model) => model.startsWith("chainbot/") || model.startsWith("openai/") || model === "gpt-5.1")
    .sort();
}

function extractCodeBuddyModels(helpText: string): string[] {
  const match = helpText.match(/Currently supported:\s*\(([^)]+)\)/);
  const safeDefaults = ["gpt-5.1", "gpt-5.1-chat-latest", "gpt-5", "gpt-4.1"];
  if (!match) return safeDefaults;
  const supported = (match[1] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((model) => safeDefaults.includes(model));
  const combined = [...safeDefaults, ...supported];
  return Array.from(new Set(combined)).sort();
}

async function fetchCodeBuddyModels(): Promise<string[]> {
  return extractCodeBuddyModels(await runModelCommand(["codebuddy", "--help"]));
}

async function fetchOpenHandsModels(): Promise<string[]> {
  return [
    "anthropic/claude-sonnet-4-5-20250929",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-sonnet-4-20250514",
  ];
}

export function getInstalledAgentStatus(): AgentInstallStatus {
  return {
    opencode: Boolean(Bun.which("opencode")),
    claudecode: Boolean(Bun.which("claude")),
    codex: Boolean(Bun.which("codex")),
    kimi: Boolean(Bun.which("kimi")),
    kilo: Boolean(Bun.which("kilo")),
    qwen: Boolean(Bun.which("qwen") || Bun.which("qwen-code")),
    goose: Boolean(Bun.which("goose")),
    pi: Boolean(Bun.which("pi")),
    openhands: Boolean(Bun.which("openhands")),
    codebuddy: Boolean(Bun.which("codebuddy") || Bun.which("cbc")),
    crush: Boolean(Bun.which("crush")),
  };
}

async function fetchOpenCodeModels(): Promise<string[]> {
  await startOpenCodeServer();
  const baseUrl = await getAnyServerUrl();
  const providersUrl = new URL("/config/providers", baseUrl).toString();
  const response = await fetch(providersUrl);
  if (!response.ok) {
    throw new Error(`providers endpoint returned ${response.status}`);
  }
  const payload = await response.json();
  return extractOpenCodeModels(payload);
}

export async function runSingleAgentCheck(provider: AgentProviderId): Promise<AgentCheckProviderResult> {
  const installed = getInstalledAgentStatus();

  if (provider === "claudecode") {
    return { claudecode: installed.claudecode, claude: installed.claudecode };
  }
  if (provider === "codex") return { codex: installed.codex };
  if (provider === "kimi") return { kimi: installed.kimi };
  if (provider === "qwen") return { qwen: installed.qwen };
  if (provider === "goose") return { goose: installed.goose };

  if (provider === "opencode") {
    const result: AgentCheckProviderResult = { opencode: installed.opencode, opencodeModels: [] };
    if (!installed.opencode) return result;
    try {
      result.opencodeModels = await fetchOpenCodeModels();
    } catch (error) {
      result.opencodeModelError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  if (provider === "kilo") {
    const result: AgentCheckProviderResult = { kilo: installed.kilo, kiloModels: [] };
    if (!installed.kilo) return result;
    try {
      result.kiloModels = await fetchKiloModels();
    } catch (error) {
      result.kiloModelError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  if (provider === "pi") {
    const result: AgentCheckProviderResult = { pi: installed.pi, piModels: [] };
    if (!installed.pi) return result;
    try {
      result.piModels = await fetchPiModels();
    } catch (error) {
      result.piModelError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  if (provider === "openhands") {
    const result: AgentCheckProviderResult = { openhands: installed.openhands, openhandsModels: [] };
    if (!installed.openhands) return result;
    try {
      result.openhandsModels = await fetchOpenHandsModels();
    } catch (error) {
      result.openhandsModelError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  if (provider === "codebuddy") {
    const result: AgentCheckProviderResult = { codebuddy: installed.codebuddy, codebuddyModels: [] };
    if (!installed.codebuddy) return result;
    try {
      result.codebuddyModels = await fetchCodeBuddyModels();
    } catch (error) {
      result.codebuddyModelError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  const result: AgentCheckProviderResult = { crush: installed.crush, crushModels: [] };
  if (!installed.crush) return result;
  try {
    result.crushModels = await fetchCrushModels();
  } catch (error) {
    result.crushModelError = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function runAgentCheck(): Promise<AgentCheckResult> {
  const installed = getInstalledAgentStatus();
  let opencodeModels: string[] = [];
  let opencodeModelError: string | undefined;
  let kiloModels: string[] = [];
  let kiloModelError: string | undefined;
  let piModels: string[] = [];
  let piModelError: string | undefined;
  let openhandsModels: string[] = [];
  let openhandsModelError: string | undefined;
  let codebuddyModels: string[] = [];
  let codebuddyModelError: string | undefined;
  let crushModels: string[] = [];
  let crushModelError: string | undefined;

  if (installed.opencode) {
    try {
      opencodeModels = await fetchOpenCodeModels();
    } catch (error) {
      opencodeModelError = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed.kilo) {
    try {
      kiloModels = await fetchKiloModels();
    } catch (error) {
      kiloModelError = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed.pi) {
    try {
      piModels = await fetchPiModels();
    } catch (error) {
      piModelError = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed.openhands) {
    try {
      openhandsModels = await fetchOpenHandsModels();
    } catch (error) {
      openhandsModelError = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed.codebuddy) {
    try {
      codebuddyModels = await fetchCodeBuddyModels();
    } catch (error) {
      codebuddyModelError = error instanceof Error ? error.message : String(error);
    }
  }

  if (installed.crush) {
    try {
      crushModels = await fetchCrushModels();
    } catch (error) {
      crushModelError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...installed,
    claude: installed.claudecode,
    opencodeModels,
    opencodeModelError,
    kiloModels,
    kiloModelError,
    piModels,
    piModelError,
    openhandsModels,
    openhandsModelError,
    codebuddyModels,
    codebuddyModelError,
    crushModels,
    crushModelError,
  };
}
