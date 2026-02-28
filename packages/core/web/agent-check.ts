import { getAnyServerUrl, startServer as startOpenCodeServer } from "@/agents/opencode";
import { extractOpenCodeModels } from "@/shared/provider-models";

export type AgentInstallStatus = {
  opencode: boolean;
  claudecode: boolean;
  codex: boolean;
  kimi: boolean;
  kiro: boolean;
  kilo: boolean;
  qwen: boolean;
  goose: boolean;
  gemini: boolean;
};

export type AgentCheckResult = AgentInstallStatus & {
  readonly claude?: boolean;
  opencodeModels: string[];
  opencodeModelError?: string;
  kiloModels: string[];
  kiloModelError?: string;
};

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

export function getInstalledAgentStatus(): AgentInstallStatus {
  return {
    opencode: Boolean(Bun.which("opencode")),
    claudecode: Boolean(Bun.which("claude")),
    codex: Boolean(Bun.which("codex")),
    kimi: Boolean(Bun.which("kimi")),
    kiro: Boolean(Bun.which("kiro-cli") || Bun.which("kiro")),
    kilo: Boolean(Bun.which("kilo")),
    qwen: Boolean(Bun.which("qwen") || Bun.which("qwen-code")),
    goose: Boolean(Bun.which("goose")),
    gemini: Boolean(Bun.which("gemini")),
  };
}

export async function runAgentCheck(): Promise<AgentCheckResult> {
  const installed = getInstalledAgentStatus();
  let opencodeModels: string[] = [];
  let opencodeModelError: string | undefined;
  let kiloModels: string[] = [];
  let kiloModelError: string | undefined;

  if (installed.opencode) {
    try {
      await startOpenCodeServer();
      const baseUrl = await getAnyServerUrl();
      const providersUrl = new URL("/config/providers", baseUrl).toString();
      const response = await fetch(providersUrl);
      if (!response.ok) {
        throw new Error(`providers endpoint returned ${response.status}`);
      }
      const payload = await response.json();
      opencodeModels = extractOpenCodeModels(payload);
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

  return {
    ...installed,
    claude: installed.claudecode,
    opencodeModels,
    opencodeModelError,
    kiloModels,
    kiloModelError,
  };
}
