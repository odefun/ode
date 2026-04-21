import { getWebHost, getWebPort } from "@/config";
import type {
  PrTrackerEventRecord,
  PrTrackerRecord,
  PrTrackerScanResult,
  PrTrackerSettings,
} from "@/config/local/pr-trackers";

// ---------------------------------------------------------------------------
// `ode pr-tracker` CLI handler.
//
// Thin HTTP client for /api/pr-trackers/*. The real work (DB writes,
// scheduling) happens in the daemon; this CLI exists so humans and agents
// can inspect and toggle trackers without opening the Web UI.
//
// Design mirrors `packages/core/cli-handlers/task.ts`: flag parser lifted
// verbatim, pretty-printed detail views, JSON flag on list/show for scripts.
// Intentionally does NOT support `create` — tracker rows are populated by
// the scan endpoint since each row is tied to a discovered repo.
// ---------------------------------------------------------------------------

type CliArgs = string[];

type FlagSpec = Record<string, boolean>;

function parseFlags(
  args: CliArgs,
  specs: FlagSpec,
): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      let name: string;
      let value: string | undefined;
      if (eqIdx >= 0) {
        name = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        name = arg.slice(2);
      }
      const takesValue = specs[name];
      if (takesValue === undefined) {
        throw new Error(`Unknown flag: --${name}`);
      }
      if (!takesValue) {
        flags[name] = true;
        continue;
      }
      if (value === undefined) {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`Flag --${name} requires a value`);
        }
        value = next;
        i += 1;
      }
      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function apiBase(): string {
  return `http://${getWebHost()}:${getWebPort()}`;
}

type ApiResponse<T> = { ok?: boolean; error?: string; result?: T };

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(
      `Failed to reach Ode daemon at ${url}. Is the daemon running? (Try \`ode status\` / \`ode start\`.) ${String(error)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  if (payload.result === undefined) {
    throw new Error("Empty response from Ode daemon");
  }
  return payload.result;
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "n/a";
  return new Date(value).toISOString();
}

function printTrackerRow(tracker: PrTrackerRecord): void {
  const state = tracker.missingSince
    ? "missing"
    : tracker.enabled
      ? "enabled"
      : "disabled";
  const source = `${tracker.sourceWorkspaceName || tracker.sourceWorkspaceId}/${tracker.sourceChannelName || tracker.sourceChannelId}`;
  const target = tracker.targetChannelId
    ? `${tracker.targetChannelName || tracker.targetChannelId}`
    : "(none)";
  console.log(
    [
      tracker.id,
      state.padEnd(9),
      `${tracker.repoOwner}/${tracker.repoName}`.padEnd(32),
      `from=${source}`,
      `to=${target}`,
      `lastPoll=${formatTimestamp(tracker.lastPolledAt)}`,
    ].join("  "),
  );
}

function printTrackerDetail(tracker: PrTrackerRecord, settings?: PrTrackerSettings): void {
  console.log(`id:               ${tracker.id}`);
  console.log(`repo:             ${tracker.repoOwner}/${tracker.repoName} (${tracker.repoHost})`);
  console.log(`enabled:          ${tracker.enabled}`);
  console.log(`missingSince:     ${formatTimestamp(tracker.missingSince)}`);
  console.log(
    `sourceChannel:    ${tracker.sourceWorkspaceName || tracker.sourceWorkspaceId} / ${tracker.sourceChannelName || tracker.sourceChannelId} (${tracker.sourceChannelId})`,
  );
  console.log(`workingDirectory: ${tracker.workingDirectory}`);
  console.log(
    `targetChannel:    ${tracker.targetChannelId ? `${tracker.targetChannelName || tracker.targetChannelId} (${tracker.targetChannelId})` : "(none)"}`,
  );
  console.log(
    `agent:            ${tracker.agentProvider ?? `(default: ${settings?.defaultAgentProvider ?? "opencode"})`}`,
  );
  console.log(
    `pollIntervalSec:  ${tracker.pollIntervalSec ?? `(default: ${settings?.defaultPollIntervalSec ?? "-"})`}`,
  );
  console.log(`githubToken:      ${tracker.githubToken ? "(set)" : "(default)"}`);
  console.log(`lastPolledAt:     ${formatTimestamp(tracker.lastPolledAt)}`);
  console.log(`lastSuccessAt:    ${formatTimestamp(tracker.lastSuccessAt)}`);
  console.log(`lastError:        ${tracker.lastError ?? "(none)"}`);
  console.log(`createdAt:        ${formatTimestamp(tracker.createdAt)}`);
  console.log(`updatedAt:        ${formatTimestamp(tracker.updatedAt)}`);
  console.log("--- prompt template ---");
  console.log(tracker.promptTemplate ?? "(default)");
}

function printEventRow(event: PrTrackerEventRecord): void {
  console.log(
    [
      formatTimestamp(event.createdAt),
      event.agentStatus.padEnd(8),
      `pr=${event.prNumber}`,
      event.eventType.padEnd(16),
      event.githubEventId,
      event.errorMessage ? `err=${event.errorMessage}` : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}

function printHelp(): void {
  console.log(
    [
      "ode pr-tracker - watch GitHub PR activity per channel",
      "",
      "Usage:",
      "  ode pr-tracker list [--enabled | --disabled | --missing] [--json]",
      "  ode pr-tracker show <id> [--json]",
      "  ode pr-tracker scan [--json]",
      "  ode pr-tracker enable <id> [--target-channel <channelId>]",
      "  ode pr-tracker disable <id>",
      "  ode pr-tracker update <id> [--agent <provider>] [--prompt <text>] [--prompt-file <path>]",
      "                             [--interval <seconds>] [--token <token>] [--target-channel <channelId>]",
      "  ode pr-tracker run <id>",
      "  ode pr-tracker delete <id>",
      "  ode pr-tracker events <id> [--limit N] [--json]",
      "  ode pr-tracker settings [--show | --set-interval <seconds> | --set-agent <provider>",
      "                           --set-prompt-file <path> | --set-token <token>]",
      "",
      "Notes:",
      "  Tracker rows are populated by `ode pr-tracker scan`, which walks every",
      "  configured channel's workingDirectory and extracts GitHub repos from",
      "  the origin remote. Each tracker is disabled by default.",
      "  Enabling a tracker requires a --target-channel (where the agent posts results).",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Subcommands.
// ---------------------------------------------------------------------------

type ListPayload = {
  trackers: PrTrackerRecord[];
  channels: Array<{ value: string; label: string }>;
  settings: PrTrackerSettings;
};

async function handleList(args: CliArgs): Promise<void> {
  const { flags } = parseFlags(args, {
    enabled: false,
    disabled: false,
    missing: false,
    json: false,
  });
  const result = await apiFetch<ListPayload>("/api/pr-trackers");
  let trackers = result.trackers;
  if (flags.enabled) trackers = trackers.filter((t) => t.enabled && !t.missingSince);
  if (flags.disabled) trackers = trackers.filter((t) => !t.enabled && !t.missingSince);
  if (flags.missing) trackers = trackers.filter((t) => t.missingSince !== null);

  if (flags.json) {
    console.log(JSON.stringify(trackers, null, 2));
    return;
  }
  if (trackers.length === 0) {
    console.log("No trackers. Run `ode pr-tracker scan` first.");
    return;
  }
  console.log("id  state  repo  source  target  lastPoll");
  console.log("-".repeat(80));
  for (const tracker of trackers) printTrackerRow(tracker);
}

async function handleShow(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { json: false });
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker show <id>");
  const result = await apiFetch<{
    tracker: PrTrackerRecord;
    events: PrTrackerEventRecord[];
    settings: PrTrackerSettings;
  }>(`/api/pr-trackers/${encodeURIComponent(id)}`);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printTrackerDetail(result.tracker, result.settings);
}

async function handleScan(args: CliArgs): Promise<void> {
  const { flags } = parseFlags(args, { json: false });
  const result = await apiFetch<{ scan: PrTrackerScanResult } & ListPayload>(
    "/api/pr-trackers/scan",
    { method: "POST" },
  );
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Scan: ${result.scan.scanned} channels scanned, ${result.scan.inserted} new, ${result.scan.reactivated} reactivated, ${result.scan.markedMissing} marked missing.`,
  );
}

async function handleUpdate(args: CliArgs, idFromCmd?: string): Promise<PrTrackerRecord> {
  const { flags, positional } = parseFlags(args, {
    agent: true,
    prompt: true,
    "prompt-file": true,
    interval: true,
    token: true,
    "target-channel": true,
  });
  const id = idFromCmd ?? positional[0];
  if (!id) throw new Error("Tracker id is required");

  const body: Record<string, unknown> = {};
  if (flags.agent !== undefined) {
    const raw = (flags.agent as string).trim().toLowerCase();
    body.agentProvider = raw === "default" ? null : raw;
  }
  if (flags["prompt-file"] !== undefined) {
    const file = Bun.file(flags["prompt-file"] as string);
    body.promptTemplate = (await file.text()).trim();
  } else if (flags.prompt !== undefined) {
    const raw = flags.prompt as string;
    body.promptTemplate = raw.trim().length === 0 ? null : raw;
  }
  if (flags.interval !== undefined) {
    const n = Number(flags.interval);
    if (!Number.isFinite(n)) throw new Error("--interval must be a positive number of seconds");
    body.pollIntervalSec = n;
  }
  if (flags.token !== undefined) {
    body.githubToken = (flags.token as string) || null;
  }
  if (flags["target-channel"] !== undefined) {
    const raw = (flags["target-channel"] as string).trim();
    body.targetChannelId = raw.length === 0 ? null : raw;
  }

  const result = await apiFetch<{ tracker: PrTrackerRecord; settings: PrTrackerSettings }>(
    `/api/pr-trackers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return result.tracker;
}

async function handleEnable(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { "target-channel": true });
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker enable <id>");
  const body: Record<string, unknown> = { enabled: true };
  if (flags["target-channel"] !== undefined) {
    body.targetChannelId = (flags["target-channel"] as string).trim() || null;
  }
  const result = await apiFetch<{ tracker: PrTrackerRecord }>(
    `/api/pr-trackers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  console.log(`Tracker ${id} enabled.`);
  printTrackerRow(result.tracker);
}

async function handleDisable(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker disable <id>");
  const result = await apiFetch<{ tracker: PrTrackerRecord }>(
    `/api/pr-trackers/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    },
  );
  console.log(`Tracker ${id} disabled.`);
  printTrackerRow(result.tracker);
}

async function handleRun(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker run <id>");
  await apiFetch(`/api/pr-trackers/${encodeURIComponent(id)}/run`, { method: "POST" });
  console.log(`Tracker ${id} triggered (poll runs asynchronously; use \`ode pr-tracker show ${id}\` to see the outcome).`);
}

async function handleDelete(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker delete <id>");
  await apiFetch(`/api/pr-trackers/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(`Tracker ${id} deleted.`);
}

async function handleEvents(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { limit: true, json: false });
  const id = positional[0];
  if (!id) throw new Error("Tracker id is required: ode pr-tracker events <id>");
  const result = await apiFetch<{ events: PrTrackerEventRecord[] }>(
    `/api/pr-trackers/${encodeURIComponent(id)}`,
  );
  let events = result.events;
  if (flags.limit !== undefined) {
    const n = Number(flags.limit);
    if (Number.isFinite(n) && n > 0) events = events.slice(0, n);
  }
  if (flags.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  if (events.length === 0) {
    console.log("No events.");
    return;
  }
  for (const event of events) printEventRow(event);
}

async function handleSettings(args: CliArgs): Promise<void> {
  const { flags } = parseFlags(args, {
    show: false,
    "set-interval": true,
    "set-agent": true,
    "set-prompt-file": true,
    "set-token": true,
  });

  const mutates =
    flags["set-interval"] !== undefined ||
    flags["set-agent"] !== undefined ||
    flags["set-prompt-file"] !== undefined ||
    flags["set-token"] !== undefined;

  if (mutates) {
    const body: Record<string, unknown> = {};
    if (flags["set-interval"] !== undefined) {
      const n = Number(flags["set-interval"]);
      if (!Number.isFinite(n)) throw new Error("--set-interval must be a number");
      body.defaultPollIntervalSec = n;
    }
    if (flags["set-agent"] !== undefined) {
      body.defaultAgentProvider = (flags["set-agent"] as string).trim();
    }
    if (flags["set-prompt-file"] !== undefined) {
      const file = Bun.file(flags["set-prompt-file"] as string);
      body.defaultPromptTemplate = (await file.text()).trim();
    }
    if (flags["set-token"] !== undefined) {
      body.defaultGithubToken = (flags["set-token"] as string) ?? "";
    }
    const result = await apiFetch<{ settings: PrTrackerSettings }>(
      "/api/pr-trackers/settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    console.log("Settings updated.");
    console.log(JSON.stringify(result.settings, null, 2));
    return;
  }

  const result = await apiFetch<{ settings: PrTrackerSettings }>("/api/pr-trackers/settings");
  console.log(JSON.stringify(result.settings, null, 2));
}

// ---------------------------------------------------------------------------
// Dispatcher.
// ---------------------------------------------------------------------------

export async function handlePrTrackerCommand(args: CliArgs): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printHelp();
    return 0;
  }
  try {
    const rest = args.slice(1);
    switch (sub) {
      case "list":
      case "ls":
        await handleList(rest);
        return 0;
      case "show":
      case "get":
        await handleShow(rest);
        return 0;
      case "scan":
        await handleScan(rest);
        return 0;
      case "enable":
        await handleEnable(rest);
        return 0;
      case "disable":
        await handleDisable(rest);
        return 0;
      case "update": {
        const tracker = await handleUpdate(rest);
        console.log(`Tracker ${tracker.id} updated.`);
        printTrackerRow(tracker);
        return 0;
      }
      case "run":
        await handleRun(rest);
        return 0;
      case "delete":
      case "rm":
        await handleDelete(rest);
        return 0;
      case "events":
        await handleEvents(rest);
        return 0;
      case "settings":
        await handleSettings(rest);
        return 0;
      default:
        console.error(`Unknown pr-tracker subcommand: ${sub}`);
        printHelp();
        return 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
