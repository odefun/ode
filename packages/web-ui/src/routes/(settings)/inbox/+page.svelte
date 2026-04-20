<script lang="ts">
  import { onMount } from "svelte";
  import { Inbox, RefreshCw } from "lucide-svelte";
  import { AGENT_PROVIDER_LABELS, type AgentProviderId } from "@/shared/agent-provider";
  import { Badge, Button, Card } from "$lib/components/ui";
  import { locale } from "$lib/i18n";

  type ThreadSourceKind = "user" | "cron_job" | "task";

  type MessageThreadSummary = {
    id: string;
    platform: "slack" | "discord" | "lark";
    workspaceId: string | null;
    workspaceName: string | null;
    channelId: string;
    channelName: string | null;
    rawChannelId: string | null;
    threadId: string;
    replyThreadId: string;
    sessionId: string | null;
    providerId: string | null;
    model: string | null;
    workingDirectory: string | null;
    threadOwnerUserId: string | null;
    branchName: string | null;
    sourceKind: ThreadSourceKind;
    cronJobId: string | null;
    cronJobTitle: string | null;
    taskId: string | null;
    taskTitle: string | null;
    detailCount: number;
    firstMessageAt: number;
    lastMessageAt: number;
    createdAt: number;
    updatedAt: number;
    latestPromptPreview: string | null;
    latestResultPreview: string | null;
    pendingDetailCount: number;
  };

  type ThreadPage = {
    items: MessageThreadSummary[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  let threadPage = $state<ThreadPage>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  let isLoading = $state(false);
  let statusMessage = $state("");

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  function formatTimestamp(timestamp: number | null | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp)) return t("Unknown time", "未知时间");
    return new Date(timestamp).toLocaleString($locale === "zh-CN" ? "zh-CN" : "en-US");
  }

  function getProviderLabel(providerId: string | null): string {
    if (!providerId) return t("Unknown provider", "未知 Provider");
    return AGENT_PROVIDER_LABELS[providerId as AgentProviderId] ?? providerId;
  }

  function getThreadSourceLabel(thread: MessageThreadSummary): string {
    if (thread.sourceKind === "cron_job") {
      return thread.cronJobTitle
        ? `${t("Cron Job", "定时任务")}: ${thread.cronJobTitle}`
        : t("Cron Job", "定时任务");
    }
    if (thread.sourceKind === "task") {
      return thread.taskTitle
        ? `${t("One-time Task", "一次性任务")}: ${thread.taskTitle}`
        : t("One-time Task", "一次性任务");
    }
    return t("User Thread", "用户会话");
  }

  function getThreadLocation(thread: MessageThreadSummary): string {
    const workspace = thread.workspaceName || thread.workspaceId || t("Unknown workspace", "未知工作区");
    const channel = thread.channelName || thread.channelId;
    return `${workspace} / ${channel}`;
  }

  async function loadThreads(page = threadPage.page): Promise<void> {
    isLoading = true;
    statusMessage = "";
    try {
      const response = await fetch(`/api/message-threads?page=${page}&pageSize=${threadPage.pageSize}`);
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: ThreadPage;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to load threads");
      }
      threadPage = payload.result;
    } catch (error) {
      statusMessage = `Inbox load failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    void loadThreads(1);
  });
</script>

<Card className="p-5">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <Inbox class="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
      <h2 class="text-lg font-semibold">{t("Inbox", "收件箱")}</h2>
    </div>

    <Button
      variant="outline"
      on:click={() => void loadThreads(threadPage.page)}
      disabled={isLoading}
    >
      <RefreshCw class="h-4 w-4" />
      {isLoading ? t("Loading...", "加载中...") : t("Refresh", "刷新")}
    </Button>
  </div>

  <div class="space-y-3">
    {#if isLoading && threadPage.items.length === 0}
      <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("Loading inbox...", "正在加载收件箱...")}</p>
    {:else if threadPage.items.length === 0}
      <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("No threads yet.", "暂时还没有会话记录。")}</p>
    {:else}
      {#each threadPage.items as thread}
        <div class="rounded-lg border p-4">
          <div class="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{getThreadSourceLabel(thread)}</Badge>
                <Badge variant="outline">{getProviderLabel(thread.providerId)}</Badge>
                <Badge variant="outline">{thread.platform}</Badge>
                <Badge variant={thread.pendingDetailCount > 0 ? "secondary" : "success"}>
                  {thread.pendingDetailCount > 0
                    ? `${t("Pending", "处理中")} (${thread.pendingDetailCount})`
                    : t("Idle", "已结束")}
                </Badge>
              </div>
              <p class="text-sm font-medium">{getThreadLocation(thread)}</p>
              <p class="text-xs text-[hsl(var(--muted-foreground))]">
                {t("Model", "模型")}: {thread.model || t("Default", "默认")}
                {" · "}
                {t("Details", "消息数")}: {thread.detailCount}
                {" · "}
                {t("Last", "最近活动")}: {formatTimestamp(thread.lastMessageAt)}
              </p>
            </div>

            <a
              href={`/inbox/${encodeURIComponent(thread.id)}`}
              class="inline-flex h-10 shrink-0 items-center justify-center rounded-md border bg-transparent px-4 text-sm font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
            >
              {t("View Timeline", "查看时间线")}
            </a>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            <div class="rounded-md bg-[hsl(var(--muted)/0.4)] p-3">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{t("Latest user prompt", "最新用户消息")}</p>
              <p class="text-sm leading-6">{thread.latestPromptPreview || t("(none)", "(无)")}</p>
            </div>

            <div class="rounded-md bg-[hsl(var(--muted)/0.4)] p-3">
              <p class="mb-1 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{t("Latest agent result", "最新 Agent 结果")}</p>
              <p class="text-sm leading-6">
                {thread.latestResultPreview || t("Waiting for final result.", "等待最终结果中。")}
              </p>
            </div>
          </div>
        </div>
      {/each}
    {/if}

    <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <p class="text-xs text-[hsl(var(--muted-foreground))]">
        {t("Total", "总计")} {threadPage.total} {t("threads", "条会话")}
        {" · "}
        {t("Page", "页码")} {threadPage.page}/{threadPage.totalPages}
      </p>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={isLoading || threadPage.page <= 1}
          on:click={() => void loadThreads(threadPage.page - 1)}
        >
          {t("Previous", "上一页")}
        </Button>
        <Button
          variant="outline"
          disabled={isLoading || threadPage.page >= threadPage.totalPages}
          on:click={() => void loadThreads(threadPage.page + 1)}
        >
          {t("Next", "下一页")}
        </Button>
      </div>
    </div>
  </div>

  {#if statusMessage}
    <p class="mt-4 text-sm text-[hsl(var(--muted-foreground))]">{statusMessage}</p>
  {/if}
</Card>
