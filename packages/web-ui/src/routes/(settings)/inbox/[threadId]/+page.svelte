<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, RefreshCw } from "lucide-svelte";
  import { page } from "$app/stores";
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
    context: Record<string, unknown> | null;
  };

  type MessageDetailKind =
    | "user_prompt"
    | "agent_result"
    | "agent_question"
    | "question_reply";
  type MessageDetailStatus = "pending" | "completed" | "failed";

  type MessageDetail = {
    id: string;
    threadId: string;
    seq: number;
    kind: MessageDetailKind;
    status: MessageDetailStatus;
    isQuestion: boolean;
    questionSourceId: string | null;
    questionPayload: unknown;
    userId: string | null;
    messageId: string | null;
    promptText: string | null;
    resultText: string | null;
    errorText: string | null;
    providerId: string | null;
    model: string | null;
    workingDirectory: string | null;
    startTime: number;
    endTime: number | null;
    context: Record<string, unknown> | null;
    createdAt: number;
    updatedAt: number;
  };

  type DetailPage = {
    items: MessageDetail[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };

  const threadId = $derived(decodeURIComponent(($page.params as Record<string, string>).threadId ?? ""));

  let thread = $state<MessageThreadSummary | null>(null);
  let detailPage = $state<DetailPage>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  let isThreadLoading = $state(false);
  let isDetailLoading = $state(false);
  let statusMessage = $state("");

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  function formatTimestamp(timestamp: number | null | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp)) return t("Unknown time", "未知时间");
    return new Date(timestamp).toLocaleString($locale === "zh-CN" ? "zh-CN" : "en-US");
  }

  function formatDuration(startMs: number, endMs: number | null): string {
    if (!endMs || !Number.isFinite(endMs) || endMs < startMs) return "—";
    const ms = endMs - startMs;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  }

  function getProviderLabel(providerId: string | null): string {
    if (!providerId) return t("Unknown provider", "未知 Provider");
    return AGENT_PROVIDER_LABELS[providerId as AgentProviderId] ?? providerId;
  }

  function getThreadSourceLabel(t_: MessageThreadSummary): string {
    if (t_.sourceKind === "cron_job") {
      return t_.cronJobTitle
        ? `${t("Cron Job", "定时任务")}: ${t_.cronJobTitle}`
        : t("Cron Job", "定时任务");
    }
    if (t_.sourceKind === "task") {
      return t_.taskTitle
        ? `${t("One-time Task", "一次性任务")}: ${t_.taskTitle}`
        : t("One-time Task", "一次性任务");
    }
    return t("User Thread", "用户会话");
  }

  function getDetailKindLabel(kind: MessageDetailKind): string {
    switch (kind) {
      case "user_prompt":
        return t("User prompt", "用户消息");
      case "agent_result":
        return t("Agent result", "Agent 结果");
      case "agent_question":
        return t("Agent question", "Agent 提问");
      case "question_reply":
        return t("Answer", "用户回复");
    }
  }

  function getDetailStatusVariant(status: MessageDetailStatus): "secondary" | "success" | "destructive" {
    if (status === "completed") return "success";
    if (status === "failed") return "destructive";
    return "secondary";
  }

  function getDetailBodyText(detail: MessageDetail): string {
    if (detail.kind === "agent_result") {
      return detail.resultText || detail.errorText || t("No output yet", "暂无输出");
    }
    if (detail.kind === "agent_question") {
      return JSON.stringify(detail.questionPayload ?? null, null, 2);
    }
    return detail.promptText || "";
  }

  function formatContext(context: Record<string, unknown> | null): string {
    if (!context) return "";
    return JSON.stringify(context, null, 2);
  }

  async function loadThreadSummary(): Promise<void> {
    if (!threadId) return;
    isThreadLoading = true;
    try {
      const response = await fetch(`/api/message-threads/${encodeURIComponent(threadId)}/summary`);
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: MessageThreadSummary;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to load thread");
      }
      thread = payload.result;
    } catch (error) {
      statusMessage = `Thread load failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isThreadLoading = false;
    }
  }

  async function loadDetails(nextPage = detailPage.page): Promise<void> {
    if (!threadId) return;
    isDetailLoading = true;
    try {
      const response = await fetch(
        `/api/message-threads/${encodeURIComponent(threadId)}/details?page=${nextPage}&pageSize=${detailPage.pageSize}`,
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        result?: DetailPage;
      };
      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || "Failed to load details");
      }
      detailPage = payload.result;
    } catch (error) {
      statusMessage = `Details load failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      isDetailLoading = false;
    }
  }

  async function refresh(): Promise<void> {
    statusMessage = "";
    await Promise.all([loadThreadSummary(), loadDetails(detailPage.page)]);
  }

  onMount(() => {
    void refresh();
  });
</script>

<Card className="p-5">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-2">
      <a
        href="/inbox"
        class="inline-flex h-9 items-center justify-center gap-1 rounded-md border bg-transparent px-3 text-xs font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
      >
        <ArrowLeft class="h-3.5 w-3.5" />
        {t("Back to Inbox", "返回收件箱")}
      </a>
      <h2 class="text-lg font-semibold">{t("Thread Timeline", "会话时间线")}</h2>
    </div>

    <Button variant="outline" on:click={() => void refresh()} disabled={isDetailLoading || isThreadLoading}>
      <RefreshCw class="h-4 w-4" />
      {isDetailLoading || isThreadLoading ? t("Loading...", "加载中...") : t("Refresh", "刷新")}
    </Button>
  </div>

  {#if !thread && !isThreadLoading}
    <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("Thread not found.", "未找到该会话。")}</p>
  {:else if thread}
    <div class="mb-5 space-y-3 rounded-lg border p-4">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{getThreadSourceLabel(thread)}</Badge>
        <Badge variant="outline">{getProviderLabel(thread.providerId)}</Badge>
        <Badge variant="outline">{thread.platform}</Badge>
        <Badge variant={thread.pendingDetailCount > 0 ? "secondary" : "success"}>
          {thread.pendingDetailCount > 0
            ? `${t("Pending", "处理中")} (${thread.pendingDetailCount})`
            : t("Idle", "已结束")}
        </Badge>
        {#if thread.model}
          <Badge variant="outline">{thread.model}</Badge>
        {/if}
      </div>
      <div class="text-xs text-[hsl(var(--muted-foreground))] space-y-1">
        <p>{t("Thread id", "会话 id")}: <code>{thread.id}</code></p>
        {#if thread.sessionId}
          <p>{t("Session", "Session")}: <code>{thread.sessionId}</code></p>
        {/if}
        {#if thread.workingDirectory}
          <p>{t("Working dir", "工作目录")}: <code>{thread.workingDirectory}</code></p>
        {/if}
        {#if thread.branchName}
          <p>{t("Branch", "分支")}: <code>{thread.branchName}</code></p>
        {/if}
        <p>{t("Last activity", "最近活动")}: {formatTimestamp(thread.lastMessageAt)}</p>
        <p>{t("Details total", "消息总数")}: {thread.detailCount}</p>
      </div>
      {#if thread.context}
        <details>
          <summary class="cursor-pointer text-xs text-[hsl(var(--muted-foreground))]">{t("Thread context", "会话上下文")}</summary>
          <pre class="mt-2 max-h-[240px] overflow-auto rounded-md bg-[hsl(var(--muted)/0.45)] p-3 text-xs leading-6 whitespace-pre-wrap">{formatContext(thread.context)}</pre>
        </details>
      {/if}
    </div>

    {#if detailPage.items.length === 0 && !isDetailLoading}
      <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("No details for this thread yet.", "该会话暂无 detail。")}</p>
    {:else}
      <div class="space-y-3">
        {#each detailPage.items as detail}
          <div class="rounded-md border p-3">
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline">#{detail.seq}</Badge>
              <Badge variant="outline">{getDetailKindLabel(detail.kind)}</Badge>
              <Badge variant={getDetailStatusVariant(detail.status)}>{detail.status}</Badge>
              {#if detail.isQuestion}
                <Badge variant="outline">is_question</Badge>
              {/if}
              {#if detail.questionSourceId}
                <Badge variant="outline">question_source_id: {detail.questionSourceId}</Badge>
              {/if}
              <span class="text-xs text-[hsl(var(--muted-foreground))]">
                {formatTimestamp(detail.startTime)}
                {" → "}
                {detail.endTime ? formatTimestamp(detail.endTime) : t("(in progress)", "(进行中)")}
                {" · "}
                {formatDuration(detail.startTime, detail.endTime)}
              </span>
            </div>
            {#if detail.errorText}
              <p class="mb-2 text-xs text-[hsl(var(--destructive))]">error: {detail.errorText}</p>
            {/if}
            <pre class="max-h-[280px] overflow-auto rounded-md bg-[hsl(var(--muted)/0.45)] p-3 text-xs leading-6 whitespace-pre-wrap">{getDetailBodyText(detail)}</pre>
            {#if detail.context}
              <details class="mt-2">
                <summary class="cursor-pointer text-xs text-[hsl(var(--muted-foreground))]">{t("detail context", "详细上下文")}</summary>
                <pre class="mt-2 max-h-[200px] overflow-auto rounded-md bg-[hsl(var(--muted)/0.3)] p-2 text-xs leading-6 whitespace-pre-wrap">{formatContext(detail.context)}</pre>
              </details>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
      <p class="text-xs text-[hsl(var(--muted-foreground))]">
        {t("Total", "总计")} {detailPage.total} {t("details", "条 detail")}
        {" · "}
        {t("Page", "页码")} {detailPage.page}/{detailPage.totalPages}
      </p>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          disabled={isDetailLoading || detailPage.page <= 1}
          on:click={() => void loadDetails(detailPage.page - 1)}
        >
          {t("Previous", "上一页")}
        </Button>
        <Button
          variant="outline"
          disabled={isDetailLoading || detailPage.page >= detailPage.totalPages}
          on:click={() => void loadDetails(detailPage.page + 1)}
        >
          {t("Next", "下一页")}
        </Button>
      </div>
    </div>
  {/if}

  {#if statusMessage}
    <p class="mt-4 text-sm text-[hsl(var(--muted-foreground))]">{statusMessage}</p>
  {/if}
</Card>
