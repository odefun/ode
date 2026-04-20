import { getWebHost, getWebPort } from "@/config";
import type { TaskRecord } from "@/config/local/tasks";

type CliArgs = string[];

type FlagSpec = Record<string, boolean>; // name -> whether it takes a value

function parseFlags(args: CliArgs, specs: FlagSpec): { flags: Record<string, string | boolean>; positional: string[] } {
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

function parseIsoTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("--time is required");
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid --time value: ${value} (expected ISO 8601, e.g. 2026-04-18T23:30:00+08:00)`);
  }
  return ms;
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "n/a";
  return new Date(value).toISOString();
}

function statusLabel(task: TaskRecord): string {
  return task.status;
}

function printTaskRow(task: TaskRecord): void {
  const channel = task.channelName || task.channelId;
  const workspace = task.workspaceName || task.workspaceId || "-";
  const thread = task.threadId ?? "(none)";
  console.log(
    [
      task.id,
      statusLabel(task).padEnd(9),
      formatTimestamp(task.scheduledAt),
      `${workspace}/${channel}`,
      `thread=${thread}`,
      task.title,
    ].join("  "),
  );
}

function printTaskDetail(task: TaskRecord): void {
  console.log(`id:            ${task.id}`);
  console.log(`title:         ${task.title}`);
  console.log(`status:        ${task.status}`);
  console.log(`scheduledAt:   ${formatTimestamp(task.scheduledAt)}`);
  console.log(`platform:      ${task.platform}`);
  console.log(`workspace:     ${task.workspaceName || task.workspaceId || "-"}`);
  console.log(`channel:       ${task.channelName || task.channelId} (${task.channelId})`);
  console.log(`thread:        ${task.threadId ?? "(none)"}`);
  console.log(`agent:         ${task.agent ?? "(default)"}`);
  console.log(`triggeredAt:   ${formatTimestamp(task.triggeredAt)}`);
  console.log(`completedAt:   ${formatTimestamp(task.completedAt)}`);
  console.log(`createdAt:     ${formatTimestamp(task.createdAt)}`);
  console.log(`updatedAt:     ${formatTimestamp(task.updatedAt)}`);
  if (task.retryCount > 0) {
    console.log(`retryCount:    ${task.retryCount}`);
  }
  if (task.lastError) {
    console.log(`lastError:     ${task.lastError}`);
  }
  console.log("--- message ---");
  console.log(task.messageText);
}

function printTaskHelp(): void {
  console.log(
    [
      "ode task - one-time scheduled tasks",
      "",
      "Usage:",
      "  ode task create --time <ISO8601> --channel <channelId> --message <text> [--thread <threadId>] [--title <title>] [--agent <provider>] [--run-now]",
      "  ode task list [--status <status>] [--json]",
      "  ode task show <id> [--json]",
      "  ode task cancel <id>",
      "  ode task delete <id>",
      "  ode task run <id>",
      "",
      "Notes:",
      "  --time accepts ISO 8601, e.g. 2026-04-18T23:30:00+08:00",
      "  --thread is optional. When set, the task reuses the thread's session; when omitted, it posts as a fresh channel message.",
      "  --channel accepts either a raw channel id or a \"workspaceId::channelId\" value.",
      "  --agent is optional; accepts a CLI provider id: opencode | claudecode | codex | kimi | kiro | kilo | qwen | goose | gemini.",
      "           When omitted, the task uses the channel's default agent.",
    ].join("\n"),
  );
}

async function handleCreate(args: CliArgs): Promise<void> {
  const { flags } = parseFlags(args, {
    time: true,
    channel: true,
    thread: true,
    message: true,
    title: true,
    agent: true,
    "run-now": false,
  });

  const timeRaw = flags.time as string | undefined;
  const channel = flags.channel as string | undefined;
  const message = flags.message as string | undefined;
  const threadId = (flags.thread as string | undefined) ?? null;
  const agent = (flags.agent as string | undefined) ?? null;
  const runNow = flags["run-now"] === true;

  if (!timeRaw) throw new Error("--time is required");
  if (!channel) throw new Error("--channel is required");
  if (!message) throw new Error("--message is required");

  const scheduledAt = parseIsoTime(timeRaw);
  const title = (flags.title as string | undefined)?.trim()
    || message.split("\n")[0]!.slice(0, 80)
    || "Scheduled task";

  const result = await apiFetch<{ task: TaskRecord }>("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      scheduledAt,
      channelId: channel,
      threadId,
      messageText: message,
      agent,
      runImmediately: runNow,
    }),
  });
  printTaskDetail(result.task);
}

async function handleList(args: CliArgs): Promise<void> {
  const { flags } = parseFlags(args, { status: true, json: false });
  const result = await apiFetch<{ tasks: TaskRecord[] }>("/api/tasks");
  let tasks = result.tasks;
  const statusFilter = flags.status as string | undefined;
  if (statusFilter) {
    tasks = tasks.filter((task) => task.status === statusFilter);
  }
  if (flags.json) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }
  if (tasks.length === 0) {
    console.log("No tasks.");
    return;
  }
  console.log(`id  status  scheduled_at  workspace/channel  thread  title`);
  console.log("-".repeat(80));
  for (const task of tasks) {
    printTaskRow(task);
  }
}

async function handleShow(args: CliArgs): Promise<void> {
  const { flags, positional } = parseFlags(args, { json: false });
  const id = positional[0];
  if (!id) throw new Error("Task id is required: ode task show <id>");
  const result = await apiFetch<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}`);
  if (flags.json) {
    console.log(JSON.stringify(result.task, null, 2));
    return;
  }
  printTaskDetail(result.task);
}

async function handleCancel(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Task id is required: ode task cancel <id>");
  const result = await apiFetch<{ task: TaskRecord }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  console.log(`Task ${id} cancelled.`);
  if (result.task) printTaskDetail(result.task);
}

async function handleDelete(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Task id is required: ode task delete <id>");
  await apiFetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  console.log(`Task ${id} deleted.`);
}

async function handleRunNow(args: CliArgs): Promise<void> {
  const { positional } = parseFlags(args, {});
  const id = positional[0];
  if (!id) throw new Error("Task id is required: ode task run <id>");
  await apiFetch(`/api/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });
  console.log(`Task ${id} triggered.`);
}

export async function handleTaskCommand(args: CliArgs): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printTaskHelp();
    return 0;
  }
  try {
    const rest = args.slice(1);
    if (sub === "create") {
      await handleCreate(rest);
      return 0;
    }
    if (sub === "list" || sub === "ls") {
      await handleList(rest);
      return 0;
    }
    if (sub === "show" || sub === "get") {
      await handleShow(rest);
      return 0;
    }
    if (sub === "cancel") {
      await handleCancel(rest);
      return 0;
    }
    if (sub === "delete" || sub === "rm") {
      await handleDelete(rest);
      return 0;
    }
    if (sub === "run") {
      await handleRunNow(rest);
      return 0;
    }
    console.error(`Unknown task subcommand: ${sub}`);
    printTaskHelp();
    return 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
