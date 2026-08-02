import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProviderId } from "@/agents/registry";
import {
  AGENT_PROVIDERS,
  isAgentProviderId,
} from "@/shared/agent-provider";
import { buildHarnessRunId, HarnessRedisStore } from "../redis-store";
import { renderStatusesFromRun } from "../renderer";
import { buildSessionMessageState } from "@/utils/session-inspector";

const DEFAULT_OUTPUT_PATH = "packages/live-status-harness/reports/agent-live-status.md";
const DEFAULT_OUTPUT_DIR = "packages/live-status-harness/reports";
const DEFAULT_PROVIDERS: AgentProviderId[] = [...AGENT_PROVIDERS];
const OPENCODE_REPORT_MODEL = "openai/gpt-5.3-codex";
const REPORT_LAYOUTS = ["split", "combined", "both"] as const;

type ReportLayout = typeof REPORT_LAYOUTS[number];

type ProviderRunSummary = {
  provider: AgentProviderId;
  runId: string;
  eventCount: number;
  statusCount: number;
  finalStatus: string;
  resultMessage: string;
  reusedRun?: boolean;
  error?: string;
};

function parseArg(name: string): string | undefined {
  const exact = `--${name}`;
  const prefix = `--${name}=`;
  const index = Bun.argv.findIndex((value) => value === exact || value.startsWith(prefix));
  if (index < 0) return undefined;
  const value = Bun.argv[index] ?? "";
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return Bun.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(`--${name}`);
}

function parseProviders(raw: string | undefined): AgentProviderId[] {
  if (!raw) return DEFAULT_PROVIDERS;
  const parsed = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);

  const providers = parsed.filter(isAgentProviderId);

  return providers.length > 0 ? providers : DEFAULT_PROVIDERS;
}

function parseLayout(raw: string | undefined): ReportLayout {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return "split";
  return REPORT_LAYOUTS.includes(normalized as ReportLayout)
    ? normalized as ReportLayout
    : "split";
}

async function runHarnessScript(scriptPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", scriptPath, ...args],
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

  if (exitCode === 0) return;

  const details = stderr.trim() || stdout.trim() || "Unknown error";
  throw new Error(details);
}

function toMarkdownCodeBlock(text: string): string {
  const normalized = text.trim();
  const safe = normalized.length > 0 ? normalized.replaceAll("```", "` ` `") : "(empty)";
  return `\`\`\`text\n${safe}\n\`\`\``;
}

function buildMarkdown(
  summaries: ProviderRunSummary[],
  generatedAt: Date,
  options: { promptFile?: string; cwd: string; redisPrefix?: string }
): string {
  const lines: string[] = [];
  lines.push("# Live Status Harness Report");
  lines.push("");
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push(`Working directory: ${options.cwd}`);
  lines.push(`Providers: ${summaries.map((summary) => summary.provider).join(", ")}`);
  if (options.promptFile) {
    lines.push(`Prompt file: ${options.promptFile}`);
  }
  if (options.redisPrefix) {
    lines.push(`Redis prefix: ${options.redisPrefix}`);
  }
  lines.push("");
  lines.push("| Provider | Run ID | Events | Statuses | Source | State |");
  lines.push("| --- | --- | ---: | ---: | --- | --- |");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.provider} | ${summary.runId} | ${summary.eventCount} | ${summary.statusCount} | ${summary.reusedRun ? "redis" : "new capture"} | ${summary.error ? "failed" : "ok"} |`
    );
  }
  lines.push("");

  for (const summary of summaries) {
    lines.push(`## ${summary.provider}`);
    lines.push("");
    lines.push(`- Run ID: ${summary.runId}`);
    lines.push(`- Source: ${summary.reusedRun ? "Reused Redis stream data" : "Captured new stream data"}`);
    lines.push(`- Events captured: ${summary.eventCount}`);
    lines.push(`- Status updates rendered: ${summary.statusCount}`);
    if (summary.error) {
      lines.push(`- Error: ${summary.error}`);
      lines.push("");
      continue;
    }

    lines.push("");
    lines.push("### Final Live Status Message");
    lines.push("");
    lines.push(toMarkdownCodeBlock(summary.finalStatus));
    lines.push("");
    lines.push("### Result Message");
    lines.push("");
    lines.push(toMarkdownCodeBlock(summary.resultMessage));
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildProviderMarkdown(
  summary: ProviderRunSummary,
  generatedAt: Date,
  options: { promptFile?: string; cwd: string; redisPrefix?: string }
): string {
  const lines: string[] = [];
  lines.push(`# Live Status Harness Report - ${summary.provider}`);
  lines.push("");
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push(`Provider: ${summary.provider}`);
  lines.push(`Working directory: ${options.cwd}`);
  if (options.promptFile) {
    lines.push(`Prompt file: ${options.promptFile}`);
  }
  if (options.redisPrefix) {
    lines.push(`Redis prefix: ${options.redisPrefix}`);
  }
  lines.push("");
  lines.push(`- Run ID: ${summary.runId}`);
  lines.push(`- Source: ${summary.reusedRun ? "Reused Redis stream data" : "Captured new stream data"}`);
  lines.push(`- Events captured: ${summary.eventCount}`);
  lines.push(`- Status updates rendered: ${summary.statusCount}`);

  if (summary.error) {
    lines.push(`- Error: ${summary.error}`);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push("");
  lines.push("## Final Live Status Message");
  lines.push("");
  lines.push(toMarkdownCodeBlock(summary.finalStatus));
  lines.push("");
  lines.push("## Result Message");
  lines.push("");
  lines.push(toMarkdownCodeBlock(summary.resultMessage));

  return `${lines.join("\n").trimEnd()}\n`;
}

async function runProvider(
  provider: AgentProviderId,
  capturePath: string,
  renderPath: string,
  store: HarnessRedisStore,
  options: { cwd: string; promptFile?: string; redisPrefix?: string; runId?: string }
): Promise<ProviderRunSummary> {
  let runId = options.runId || "";
  let reusedRun = false;

  if (!options.runId) {
    const existingRunId = await store.getLatestRunIdByProvider(provider);
    if (existingRunId) {
      runId = existingRunId;
      reusedRun = true;
    } else {
      runId = buildHarnessRunId(provider);
    }
  }

  if (!reusedRun && !options.runId) {
    const captureArgs = ["--provider", provider, "--run-id", runId, "--cwd", options.cwd];
    if (provider === "codebuddy") {
      captureArgs.push("--model", "codebuddy/gpt-5.1");
    }
    if (provider === "crush") {
      captureArgs.push("--model", "chainbot/gpt-5.1");
    }
    if (provider === "pi" || provider === "openhands") {
      captureArgs.push("--model", "anthropic/claude-sonnet-4-5-20250929");
    }
    if (provider === "opencode") {
      captureArgs.push("--model", OPENCODE_REPORT_MODEL);
    }
    if (options.promptFile) {
      captureArgs.push("--prompt-file", options.promptFile);
    }
    if (options.redisPrefix) {
      captureArgs.push("--redis-prefix", options.redisPrefix);
    }

    await runHarnessScript(capturePath, captureArgs);
  }

  const renderArgs = ["--run-id", runId];
  if (options.redisPrefix) {
    renderArgs.push("--redis-prefix", options.redisPrefix);
  }
  await runHarnessScript(renderPath, renderArgs);

  const meta = await store.getRunMeta(runId);
  if (!meta) {
    throw new Error(`Run metadata missing for ${runId}`);
  }
  if (options.runId && meta.provider !== provider) {
    throw new Error(`Run ${runId} belongs to provider ${meta.provider}, expected ${provider}`);
  }

  const events = await store.getRunEvents(runId);
  const statuses = renderStatusesFromRun(meta, events);
  const finalStatus = statuses[statuses.length - 1]?.text ?? "";
  const finalState = buildSessionMessageState(
    events
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((event) => {
        const payload = event.event;
        const data = payload && typeof payload === "object"
          ? payload as Record<string, unknown>
          : { value: payload };
        const type = typeof (data as { type?: unknown }).type === "string"
          ? (data as { type?: string }).type ?? "unknown"
          : "unknown";
        return {
          timestamp: event.timestamp,
          type,
          data,
        };
      }),
    {
      workingDirectory: options.cwd,
      provider: meta.provider,
      baseState: { startedAt: meta.startedAt },
    }
  );
  const inferredResult = finalState.currentText?.trim() ?? "";
  const resultMessage = inferredResult || meta.finalText || "";

  return {
    provider,
    runId,
    eventCount: events.length,
    statusCount: statuses.length,
    finalStatus,
    resultMessage,
    reusedRun,
  };
}

async function main(): Promise<void> {
  const providers = parseProviders(parseArg("providers"));
  const runIdArg = parseArg("run-id");
  const layout = parseLayout(parseArg("layout"));
  const redisPrefix = parseArg("redis-prefix");
  const promptFile = parseArg("prompt-file");
  const outputPath = parseArg("output") || DEFAULT_OUTPUT_PATH;
  const outputDir = parseArg("output-dir") || DEFAULT_OUTPUT_DIR;
  const cwd = parseArg("cwd") || process.cwd();
  const failFast = hasFlag("fail-fast");

  const absoluteOutputPath = resolve(outputPath);
  const absoluteOutputDir = resolve(outputDir);
  const capturePath = fileURLToPath(new URL("./capture-stream.ts", import.meta.url));
  const renderPath = fileURLToPath(new URL("./render-status.ts", import.meta.url));

  const store = new HarnessRedisStore(redisPrefix);
  await store.connect();

  const summaries: ProviderRunSummary[] = [];

  try {
    if (runIdArg && providers.length !== 1) {
      throw new Error("--run-id requires exactly one provider in --providers");
    }

    for (const provider of providers) {
      try {
        const summary = await runProvider(provider, capturePath, renderPath, store, {
          cwd,
          promptFile,
          redisPrefix,
          runId: runIdArg,
        });
        summaries.push(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summaries.push({
          provider,
          runId: "(not completed)",
          eventCount: 0,
          statusCount: 0,
          finalStatus: "",
          resultMessage: "",
          error: message,
        });
        if (failFast) throw error;
      }
    }

    const generatedAt = new Date();
    const outputPaths: string[] = [];

    if (layout === "split" || layout === "both") {
      await mkdir(absoluteOutputDir, { recursive: true });
      for (const summary of summaries) {
        const providerOutputPath = resolve(absoluteOutputDir, `${summary.provider}.md`);
        const providerMarkdown = buildProviderMarkdown(summary, generatedAt, { cwd, promptFile, redisPrefix });
        await Bun.write(providerOutputPath, providerMarkdown);
        outputPaths.push(providerOutputPath);
      }
    }

    if (layout === "combined" || layout === "both") {
      const markdown = buildMarkdown(summaries, generatedAt, { cwd, promptFile, redisPrefix });
      await mkdir(dirname(absoluteOutputPath), { recursive: true });
      await Bun.write(absoluteOutputPath, markdown);
      outputPaths.push(absoluteOutputPath);
    }

    process.stdout.write(
      `${JSON.stringify({ layout, outputPaths, providers: summaries.map((summary) => summary.provider), failures: summaries.filter((summary) => Boolean(summary.error)).length }, null, 2)}\n`
    );
  } finally {
    await store.close();
  }
}

await main();
