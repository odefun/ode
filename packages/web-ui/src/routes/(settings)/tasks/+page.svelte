<script lang="ts">
  import { onMount } from "svelte";
  import { Ban, CalendarClock, ChevronDown, ChevronRight, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-svelte";
  import { Badge, Button, Card, Input, Label, Select, Textarea } from "$lib/components/ui";
  import { locale } from "$lib/i18n";
  import {
    AGENT_PROVIDERS,
    AGENT_PROVIDER_LABELS,
    isAgentProviderId,
    type AgentProviderId,
  } from "@/shared/agent-provider";
  import { localSettingStore } from "$lib/local-setting/store";

  type TaskPlatform = "slack" | "discord" | "lark";
  type TaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

  type TaskRecord = {
    id: string;
    title: string;
    scheduledAt: number;
    platform: TaskPlatform;
    workspaceId: string | null;
    workspaceName: string | null;
    channelId: string;
    channelName: string | null;
    threadId: string | null;
    messageText: string;
    agent: string | null;
    status: TaskStatus;
    lastError: string | null;
    triggeredAt: number | null;
    completedAt: number | null;
    createdAt: number;
    updatedAt: number;
  };

  type TaskChannelOption = {
    value: string;
    platform: TaskPlatform;
    workspaceId: string;
    workspaceName: string;
    channelId: string;
    channelName: string;
    label: string;
  };

  type TaskPayload = {
    tasks: TaskRecord[];
    channels: TaskChannelOption[];
  };

  let tasks = $state<TaskRecord[]>([]);
  let channels = $state<TaskChannelOption[]>([]);
  let isLoading = $state(false);
  let isSaving = $state(false);
  let message = $state("");

  let editingTaskId = $state<string | null>(null);
  let formTitle = $state("");
  let formChannelId = $state("");
  let formThreadId = $state("");
  let formMessageText = $state("");
  let formAgent = $state("");
  // datetime-local input value, local time (no timezone).
  let formScheduledLocal = $state("");
  let formRunImmediately = $state(false);
  let runningTaskIds = $state<Set<string>>(new Set());
  // Create/edit form is collapsible, collapsed by default. Auto-expands when editing.
  let isCreateFormOpen = $state(false);

  // Pagination: show 10 tasks at a time, "Load more" appends another 10.
  const TASKS_PAGE_SIZE = 10;
  let visibleCount = $state(TASKS_PAGE_SIZE);
  const visibleTasks = $derived(tasks.slice(0, visibleCount));
  // Per-task collapse state. Collapsed by default; click to expand message/details.
  let expandedTaskIds = $state<Set<string>>(new Set());

  function toggleTaskExpanded(taskId: string): void {
    const next = new Set(expandedTaskIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    expandedTaskIds = next;
  }

  function isProviderEnabled(provider: AgentProviderId): boolean {
    const agents = $localSettingStore.config.agents as Record<string, { enabled?: boolean }>;
    return agents[provider]?.enabled === true;
  }

  const enabledAgentProviders = $derived(
    AGENT_PROVIDERS.filter((provider) => isProviderEnabled(provider)),
  );

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  function formatTimestamp(value: number | null | undefined): string {
    if (!value || !Number.isFinite(value)) return t("n/a", "无");
    return new Date(value).toLocaleString($locale === "zh-CN" ? "zh-CN" : "en-US");
  }

  function toLocalDatetimeInput(epochMs: number): string {
    const d = new Date(epochMs);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fromLocalDatetimeInput(value: string): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }

  function getStatusVariant(status: TaskStatus): "secondary" | "success" | "destructive" | "outline" {
    if (status === "success") return "success";
    if (status === "failed") return "destructive";
    if (status === "cancelled") return "outline";
    return "secondary";
  }

  function getStatusLabel(status: TaskStatus): string {
    if (status === "pending") return t("Pending", "待执行");
    if (status === "running") return t("Running", "运行中");
    if (status === "success") return t("Success", "成功");
    if (status === "failed") return t("Failed", "失败");
    return t("Cancelled", "已取消");
  }

  function getChannelLabel(task: TaskRecord): string {
    const workspace = task.workspaceName || task.workspaceId || t("Unknown workspace", "未知工作区");
    const channel = task.channelName || task.channelId;
    return `${workspace} / ${channel}`;
  }

  function findChannelFormValue(task: TaskRecord): string {
    const exactMatch = channels.find((channel) =>
      channel.channelId === task.channelId
      && channel.workspaceId === (task.workspaceId || channel.workspaceId)
      && channel.platform === task.platform
    );
    if (exactMatch) return exactMatch.value;
    const fallbackMatch = channels.find((channel) => channel.channelId === task.channelId);
    return fallbackMatch?.value ?? task.channelId;
  }

  function applyPayload(payload: TaskPayload): void {
    tasks = payload.tasks;
    channels = payload.channels;

    const hasSelectedChannel = channels.some((channel) => channel.value === formChannelId);
    if (!hasSelectedChannel) {
      formChannelId = channels[0]?.value ?? "";
    }
  }

  function resetForm(): void {
    editingTaskId = null;
    formTitle = "";
    formChannelId = channels[0]?.value ?? "";
    formThreadId = "";
    formMessageText = "";
    formAgent = "";
    formRunImmediately = false;
    // Default to 15 minutes from now.
    formScheduledLocal = toLocalDatetimeInput(Date.now() + 15 * 60 * 1000);
  }

  function startEdit(task: TaskRecord): void {
    editingTaskId = task.id;
    formTitle = task.title;
    formChannelId = findChannelFormValue(task);
    formThreadId = task.threadId ?? "";
    formMessageText = task.messageText;
    formAgent = task.agent ?? "";
    formScheduledLocal = toLocalDatetimeInput(task.scheduledAt);
    formRunImmediately = false;
    message = "";
    isCreateFormOpen = true;
    // Make sure the edited task is visible and expanded, even if it's beyond
    // the current page window.
    const index = tasks.findIndex((item) => item.id === task.id);
    if (index >= 0 && index + 1 > visibleCount) {
      visibleCount = index + 1;
    }
    if (!expandedTaskIds.has(task.id)) {
      const next = new Set(expandedTaskIds);
      next.add(task.id);
      expandedTaskIds = next;
    }
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  async function loadTasks(): Promise<void> {
    isLoading = true;
    message = "";
    try {
      const response = await fetch("/api/tasks");
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: TaskPayload;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to load tasks");
      }
      applyPayload(payload.result);
      if (!editingTaskId && !formChannelId && payload.result.channels.length > 0) {
        formChannelId = payload.result.channels[0]!.value;
      }
    } catch (error) {
      message = `Tasks load failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isLoading = false;
    }
  }

  async function saveTask(): Promise<void> {
    if (channels.length === 0) {
      message = t("Add a workspace channel first before creating tasks.", "请先添加工作区和频道，再创建一次性任务。");
      return;
    }
    const scheduledAt = fromLocalDatetimeInput(formScheduledLocal);
    if (scheduledAt === null) {
      message = t("Please choose a valid scheduled time.", "请选择有效的执行时间。");
      return;
    }

    isSaving = true;
    message = "";
    try {
      const isCreate = !editingTaskId;
      const body: Record<string, unknown> = {
        title: formTitle,
        scheduledAt,
        channelId: formChannelId,
        threadId: formThreadId.trim() || null,
        messageText: formMessageText,
        agent: formAgent.trim() || null,
      };
      if (isCreate && formRunImmediately) {
        body.runImmediately = true;
      }
      const response = await fetch(editingTaskId ? `/api/tasks/${encodeURIComponent(editingTaskId)}` : "/api/tasks", {
        method: editingTaskId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: TaskPayload;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to save task");
      }
      applyPayload(payload.result);
      message = isCreate
        ? (formRunImmediately
            ? t("Task created and triggered.", "任务已创建并立即执行。")
            : t("Task created.", "任务已创建。"))
        : t("Task updated.", "任务已更新。");
      resetForm();
    } catch (error) {
      message = `Task save failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isSaving = false;
    }
  }

  async function runTaskNow(task: TaskRecord): Promise<void> {
    if (runningTaskIds.has(task.id)) return;
    runningTaskIds = new Set(runningTaskIds).add(task.id);
    message = "";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/run`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: TaskPayload;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        if (response.status === 409) {
          message = payload.error ?? t("This task is not runnable.", "此任务当前不可运行。");
        } else {
          throw new Error(payload.error || "Failed to run task");
        }
      } else {
        applyPayload(payload.result);
        message = t("Task triggered.", "任务已触发。");
      }
    } catch (error) {
      message = `Task run failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      const next = new Set(runningTaskIds);
      next.delete(task.id);
      runningTaskIds = next;
    }
  }

  async function cancelTaskById(task: TaskRecord): Promise<void> {
    const confirmText = $locale === "zh-CN"
      ? `确认取消任务「${task.title}」？`
      : `Cancel task '${task.title}'?`;
    if (!window.confirm(confirmText)) return;

    isSaving = true;
    message = "";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
        method: "POST",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: TaskPayload;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to cancel task");
      }
      applyPayload(payload.result);
      message = t("Task cancelled.", "任务已取消。");
    } catch (error) {
      message = `Task cancel failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isSaving = false;
    }
  }

  async function removeTask(task: TaskRecord): Promise<void> {
    const confirmText = $locale === "zh-CN"
      ? `确认删除任务「${task.title}」？`
      : `Delete task '${task.title}'?`;
    if (!window.confirm(confirmText)) return;

    isSaving = true;
    message = "";
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: TaskPayload;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to delete task");
      }
      applyPayload(payload.result);
      if (editingTaskId === task.id) {
        resetForm();
      }
      message = t("Task deleted.", "任务已删除。");
    } catch (error) {
      message = `Task delete failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isSaving = false;
    }
  }

  onMount(() => {
    // Default scheduled time = 15 minutes from now, unless overridden.
    if (!formScheduledLocal) {
      formScheduledLocal = toLocalDatetimeInput(Date.now() + 15 * 60 * 1000);
    }
    void loadTasks();
  });
</script>

<Card className="p-5">
  <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div class="flex items-start gap-2">
      <CalendarClock class="mt-1 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
      <div class="space-y-1">
        <h2 class="text-lg font-semibold">{t("One-time Tasks", "一次性任务")}</h2>
        <p class="text-xs text-[hsl(var(--muted-foreground))]">
          {t(
            "Most one-time tasks are created by agents themselves; you can also create them manually. Agents schedule one-time tasks to defer an operation, or to hand work off to a sub-agent.",
            "一次性任务大多是由 Agent 自己创建的，你也可以手动创建一次性任务。这些 Agent 可以通过创建一次性任务，来延后执行某个操作，或者调用其他的 sub-agent。",
          )}
        </p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <Button
        variant="outline"
        on:click={() => {
          resetForm();
          isCreateFormOpen = true;
        }}
        disabled={isSaving}
      >
        <Plus class="h-4 w-4" />
        {t("New Task", "新建任务")}
      </Button>
      <Button
        variant="outline"
        on:click={() => void loadTasks()}
        disabled={isLoading}
      >
        <RefreshCw class="h-4 w-4" />
        {isLoading ? t("Loading...", "加载中...") : t("Refresh", "刷新")}
      </Button>
    </div>
  </div>

  <div class="space-y-6">
    <!-- Create / edit form (collapsible, collapsed by default) -->
    <div class="rounded-lg border p-4">
      <button
        type="button"
        class="flex w-full items-center justify-between gap-2 text-left"
        onclick={() => {
          isCreateFormOpen = !isCreateFormOpen;
        }}
        aria-expanded={isCreateFormOpen}
      >
        <div>
          <p class="text-sm font-medium">
            {editingTaskId ? t("Edit Task", "编辑任务") : t("Create Task", "创建任务")}
          </p>
          <p class="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
            {t(
              "Tasks fire once at the scheduled time. When a thread is set, the task reuses that thread's session to keep context; otherwise it posts as a fresh channel message.",
              "任务会在设定的时间一次性触发。如填写 Thread，则会复用该 Thread 的会话保留上下文；否则作为新的频道消息发送。",
            )}
          </p>
        </div>
        {#if isCreateFormOpen}
          <ChevronDown class="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
        {:else}
          <ChevronRight class="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
        {/if}
      </button>

      {#if isCreateFormOpen}
        <div class="mt-4 space-y-4">
        <div class="space-y-2">
          <Label for="task-title">{t("Title", "标题")}</Label>
          <Input
            id="task-title"
            value={formTitle}
            placeholder={t("Check deploy status after 1 hour", "1 小时后检查部署状态")}
            on:input={(event) => {
              formTitle = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </div>

        <div class="space-y-2">
          <Label for="task-time">{t("Scheduled time", "执行时间")}</Label>
          <Input
            id="task-time"
            type="datetime-local"
            value={formScheduledLocal}
            on:input={(event) => {
              formScheduledLocal = (event.currentTarget as HTMLInputElement).value;
            }}
          />
          <p class="text-xs text-[hsl(var(--muted-foreground))]">
            {t("Uses your local timezone.", "使用你所在时区。")}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="task-channel">{t("Channel", "频道")}</Label>
          <Select id="task-channel" bind:value={formChannelId} disabled={channels.length === 0}>
            {#if channels.length === 0}
              <option value="">{t("No available channels", "暂无可用频道")}</option>
            {:else}
              {#each channels as channel}
                <option value={channel.value}>
                  {channel.label} ({channel.platform})
                </option>
              {/each}
            {/if}
          </Select>
        </div>

        <div class="space-y-2">
          <Label for="task-thread">{t("Thread (optional)", "Thread（可选）")}</Label>
          <Input
            id="task-thread"
            value={formThreadId}
            placeholder={t("Leave empty to post as a new channel message", "留空则作为新频道消息发送")}
            on:input={(event) => {
              formThreadId = (event.currentTarget as HTMLInputElement).value;
            }}
          />
          <p class="text-xs text-[hsl(var(--muted-foreground))]">
            {t(
              "When set, the task reuses the existing thread's session. Only Slack supports replying inside a thread; Discord and Lark will still post as a new channel message.",
              "设置 Thread 会复用该 Thread 已有的会话。仅 Slack 支持 thread 内回复，Discord / Lark 仍会作为新消息发到频道。",
            )}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="task-agent">{t("Agent (optional)", "Agent（可选）")}</Label>
          <Select id="task-agent" bind:value={formAgent}>
            <option value="">{t("Channel default", "使用频道默认")}</option>
            {#each enabledAgentProviders as provider}
              <option value={provider}>
                {AGENT_PROVIDER_LABELS[provider]} ({provider})
              </option>
            {/each}
            {#if formAgent && isAgentProviderId(formAgent) && !enabledAgentProviders.includes(formAgent as AgentProviderId)}
              <option value={formAgent}>
                {AGENT_PROVIDER_LABELS[formAgent as AgentProviderId]} ({formAgent}) — {t("not enabled", "未启用")}
              </option>
            {/if}
          </Select>
          <p class="text-xs text-[hsl(var(--muted-foreground))]">
            {t(
              "Leave empty to use the channel's default agent. Only enabled CLIs are listed.",
              "留空则使用频道默认的 agent。仅列出已启用的 CLI。",
            )}
          </p>
        </div>

        <div class="space-y-2">
          <Label for="task-message">{t("Message", "消息")}</Label>
          <Textarea
            id="task-message"
            className="min-h-[160px]"
            value={formMessageText}
            placeholder={t(
              "Run `gh pr list --state open` and summarize blockers.",
              "运行 `gh pr list --state open`，总结 blocker。",
            )}
            on:input={(event) => {
              formMessageText = (event.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </div>

        {#if !editingTaskId}
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formRunImmediately}
              onchange={(event) => {
                formRunImmediately = (event.currentTarget as HTMLInputElement).checked;
              }}
            />
            <span>{t("Also run this task once right after creating", "创建后立即执行一次")}</span>
          </label>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          <Button
            on:click={() => void saveTask()}
            disabled={isSaving || channels.length === 0}
          >
            {isSaving
              ? t("Saving...", "保存中...")
              : editingTaskId
                ? t("Update Task", "更新任务")
                : t("Create Task", "创建任务")}
          </Button>
          {#if editingTaskId}
            <Button
              variant="outline"
              on:click={resetForm}
              disabled={isSaving}
            >
              {t("Cancel Edit", "取消编辑")}
            </Button>
          {/if}
        </div>
      </div>
      {/if}
    </div>

    <!-- Task list -->
    <div class="rounded-lg border p-4">
      <div class="mb-3 flex items-center justify-between gap-2">
        <p class="text-sm font-medium">{t("Scheduled Tasks", "任务列表")}</p>
        <Badge variant="outline">
          {#if tasks.length > visibleTasks.length}
            {visibleTasks.length} / {tasks.length} {t("tasks", "个任务")}
          {:else}
            {tasks.length} {t("tasks", "个任务")}
          {/if}
        </Badge>
      </div>

      {#if isLoading && tasks.length === 0}
        <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("Loading tasks...", "正在加载任务...")}</p>
      {:else if tasks.length === 0}
        <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("No tasks yet.", "还没有任务。")}</p>
      {:else}
        <div class="space-y-3">
          {#each visibleTasks as task}
            {@const isExpanded = expandedTaskIds.has(task.id)}
            <div class="rounded-lg border p-4">
              <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
                <button
                  type="button"
                  class="flex flex-1 min-w-0 items-start gap-2 text-left"
                  onclick={() => toggleTaskExpanded(task.id)}
                  aria-expanded={isExpanded}
                >
                  {#if isExpanded}
                    <ChevronDown class="mt-1 h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
                  {:else}
                    <ChevronRight class="mt-1 h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]" />
                  {/if}
                  <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant={getStatusVariant(task.status)}>{getStatusLabel(task.status)}</Badge>
                      <Badge variant="outline">{task.platform}</Badge>
                      {#if task.agent}
                        <Badge variant="outline">
                          {isAgentProviderId(task.agent)
                            ? AGENT_PROVIDER_LABELS[task.agent as AgentProviderId]
                            : task.agent}
                        </Badge>
                      {/if}
                    </div>
                    <p class="text-sm font-medium truncate">{task.title}</p>
                    <p class="text-xs text-[hsl(var(--muted-foreground))]">
                      {t("Scheduled", "计划时间")}: {formatTimestamp(task.scheduledAt)}
                    </p>
                    <p class="text-xs text-[hsl(var(--muted-foreground))]">{getChannelLabel(task)}</p>
                    {#if task.threadId}
                      <p class="text-xs text-[hsl(var(--muted-foreground))]">
                        {t("Thread", "Thread")}: <code>{task.threadId}</code>
                      </p>
                    {/if}
                  </div>
                </button>

                <div class="flex flex-wrap items-center gap-2">
                  {#if task.status === "pending"}
                    <Button
                      variant="outline"
                      size="sm"
                      on:click={() => void runTaskNow(task)}
                      disabled={isSaving || runningTaskIds.has(task.id)}
                    >
                      <Play class="h-3.5 w-3.5" />
                      {runningTaskIds.has(task.id)
                        ? t("Running...", "运行中...")
                        : t("Run Now", "立即执行")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      on:click={() => startEdit(task)}
                    >
                      <Pencil class="h-3.5 w-3.5" />
                      {t("Edit", "编辑")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      on:click={() => void cancelTaskById(task)}
                      disabled={isSaving}
                    >
                      <Ban class="h-3.5 w-3.5" />
                      {t("Cancel", "取消")}
                    </Button>
                  {/if}
                  <Button
                    variant="outline"
                    size="sm"
                    on:click={() => void removeTask(task)}
                    disabled={isSaving}
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                    {t("Delete", "删除")}
                  </Button>
                </div>
              </div>

              {#if isExpanded}
                <div class="rounded-md bg-[hsl(var(--muted)/0.4)] p-3">
                  <p class="mb-1 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{t("Message", "消息内容")}</p>
                  <p class="text-sm leading-6 whitespace-pre-wrap">{task.messageText}</p>
                </div>

                <div class="mt-3 grid gap-2 text-xs text-[hsl(var(--muted-foreground))] md:grid-cols-2">
                  <p>{t("Triggered", "触发时间")}: {formatTimestamp(task.triggeredAt)}</p>
                  <p>{t("Completed", "完成时间")}: {formatTimestamp(task.completedAt)}</p>
                  <p>{t("Created", "创建于")}: {formatTimestamp(task.createdAt)}</p>
                  <p>{t("Updated", "更新于")}: {formatTimestamp(task.updatedAt)}</p>
                </div>

                {#if task.lastError}
                  <div class="mt-3 rounded-md border border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--destructive)/0.08)] p-3 text-sm text-[hsl(var(--destructive))]">
                    {task.lastError}
                  </div>
                {/if}
              {/if}
            </div>
          {/each}
        </div>

        {#if tasks.length > visibleTasks.length}
          <div class="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              on:click={() => {
                visibleCount = Math.min(tasks.length, visibleCount + TASKS_PAGE_SIZE);
              }}
            >
              {t(
                `Load more (${tasks.length - visibleTasks.length} remaining)`,
                `加载更多（还剩 ${tasks.length - visibleTasks.length} 个）`,
              )}
            </Button>
          </div>
        {/if}
      {/if}
    </div>
  </div>

  {#if message}
    <p class="mt-4 text-sm text-[hsl(var(--muted-foreground))]">{message}</p>
  {/if}
</Card>
