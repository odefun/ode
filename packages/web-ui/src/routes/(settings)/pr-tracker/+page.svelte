<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronDown, ChevronRight, Play, RefreshCw, Trash2 } from "lucide-svelte";
  import { Badge, Button, Card, Input, Label, Select, Textarea } from "$lib/components/ui";
  import { locale } from "$lib/i18n";
  import {
    AGENT_PROVIDERS,
    AGENT_PROVIDER_LABELS,
    type AgentProviderId,
  } from "@/shared/agent-provider";

  type PrTrackerPlatform = "slack" | "discord" | "lark";

  type PrTrackerRecord = {
    id: string;
    sourceWorkspaceId: string;
    sourceWorkspaceName: string | null;
    sourceChannelId: string;
    sourceChannelName: string | null;
    sourcePlatform: PrTrackerPlatform;
    workingDirectory: string;
    repoOwner: string;
    repoName: string;
    repoHost: string;
    enabled: boolean;
    agentProvider: string | null;
    promptTemplate: string | null;
    pollIntervalSec: number | null;
    githubToken: string | null;
    targetWorkspaceId: string | null;
    targetChannelId: string | null;
    targetChannelName: string | null;
    targetPlatform: PrTrackerPlatform | null;
    lastPolledAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    missingSince: number | null;
    createdAt: number;
    updatedAt: number;
  };

  type ChannelOption = {
    value: string;
    label: string;
    channelId: string;
    channelName: string;
    workspaceId: string;
    workspaceName: string;
  };

  type PrTrackerSettings = {
    defaultPollIntervalSec: number;
    defaultAgentProvider: string;
    defaultPromptTemplate: string;
    defaultGithubToken: string;
    updatedAt: number;
  };

  type ListPayload = {
    trackers: PrTrackerRecord[];
    channels: ChannelOption[];
    settings: PrTrackerSettings;
  };

  let trackers = $state<PrTrackerRecord[]>([]);
  let channels = $state<ChannelOption[]>([]);
  let settings = $state<PrTrackerSettings | null>(null);
  let isLoading = $state(false);
  let isSaving = $state(false);
  let isScanning = $state(false);
  let message = $state("");
  let runningIds = $state<Set<string>>(new Set());
  let expandedIds = $state<Set<string>>(new Set());

  // Settings form.
  let formDefaultInterval = $state(1800);
  let formDefaultAgent = $state("");
  let formDefaultPrompt = $state("");
  let formDefaultToken = $state("");
  let isSettingsOpen = $state(false);

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  function formatTimestamp(ms: number | null | undefined): string {
    if (!ms || !Number.isFinite(ms)) return "n/a";
    return new Date(ms).toLocaleString();
  }

  function formatRelative(ms: number | null | undefined): string {
    if (!ms) return t("never", "从未");
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60_000);
    if (min < 1) return t("just now", "刚刚");
    if (min < 60) return `${min}${t("m ago", " 分钟前")}`;
    const hours = Math.floor(min / 60);
    if (hours < 24) return `${hours}${t("h ago", " 小时前")}`;
    return `${Math.floor(hours / 24)}${t("d ago", " 天前")}`;
  }

  async function loadTrackers(): Promise<void> {
    isLoading = true;
    message = "";
    try {
      const res = await fetch("/api/pr-trackers");
      const payload = (await res.json()) as { ok: boolean; result?: ListPayload; error?: string };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      trackers = payload.result.trackers;
      channels = payload.result.channels;
      settings = payload.result.settings;
      formDefaultInterval = settings.defaultPollIntervalSec;
      formDefaultAgent = settings.defaultAgentProvider;
      formDefaultPrompt = settings.defaultPromptTemplate;
      formDefaultToken = settings.defaultGithubToken;
    } catch (error) {
      message = t("Failed to load PR trackers: ", "加载 PR 追踪器失败：") + String(error);
    } finally {
      isLoading = false;
    }
  }

  async function rescan(): Promise<void> {
    isScanning = true;
    message = "";
    try {
      const res = await fetch("/api/pr-trackers/scan", { method: "POST" });
      const payload = (await res.json()) as {
        ok: boolean;
        result?: ListPayload & { scan: { scanned: number; inserted: number; reactivated: number; markedMissing: number } };
        error?: string;
      };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      trackers = payload.result.trackers;
      channels = payload.result.channels;
      settings = payload.result.settings;
      const s = payload.result.scan;
      message = t(
        `Scanned ${s.scanned} channel(s), ${s.inserted} new, ${s.reactivated} reactivated, ${s.markedMissing} marked missing.`,
        `扫描 ${s.scanned} 个频道，新增 ${s.inserted}，恢复 ${s.reactivated}，标记缺失 ${s.markedMissing}。`,
      );
    } catch (error) {
      message = t("Scan failed: ", "扫描失败：") + String(error);
    } finally {
      isScanning = false;
    }
  }

  async function saveTracker(tracker: PrTrackerRecord, patch: Partial<PrTrackerRecord>): Promise<void> {
    isSaving = true;
    message = "";
    try {
      const body: Record<string, unknown> = {};
      if ("enabled" in patch) body.enabled = patch.enabled;
      if ("agentProvider" in patch) body.agentProvider = patch.agentProvider;
      if ("promptTemplate" in patch) body.promptTemplate = patch.promptTemplate;
      if ("pollIntervalSec" in patch) body.pollIntervalSec = patch.pollIntervalSec;
      if ("githubToken" in patch) body.githubToken = patch.githubToken;
      if ("targetChannelId" in patch) body.targetChannelId = patch.targetChannelId;
      const res = await fetch(`/api/pr-trackers/${encodeURIComponent(tracker.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as {
        ok: boolean;
        result?: { tracker: PrTrackerRecord } & ListPayload;
        error?: string;
      };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      trackers = payload.result.trackers;
    } catch (error) {
      message = t("Save failed: ", "保存失败：") + String(error);
    } finally {
      isSaving = false;
    }
  }

  async function toggleEnabled(tracker: PrTrackerRecord): Promise<void> {
    if (!tracker.enabled && !tracker.targetChannelId) {
      message = t(
        "Pick a target channel before enabling this tracker.",
        "启用前请先选择目标频道。",
      );
      expandedIds = new Set([...expandedIds, tracker.id]);
      return;
    }
    await saveTracker(tracker, { enabled: !tracker.enabled });
  }

  async function runNow(tracker: PrTrackerRecord): Promise<void> {
    runningIds = new Set([...runningIds, tracker.id]);
    message = "";
    try {
      const res = await fetch(`/api/pr-trackers/${encodeURIComponent(tracker.id)}/run`, {
        method: "POST",
      });
      const payload = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      message = t("Poll triggered. Status will update on the next refresh.", "已触发轮询，状态将在下次刷新时更新。");
      setTimeout(() => void loadTrackers(), 4000);
    } catch (error) {
      message = t("Run failed: ", "触发失败：") + String(error);
    } finally {
      const next = new Set(runningIds);
      next.delete(tracker.id);
      runningIds = next;
    }
  }

  async function deleteTracker(tracker: PrTrackerRecord): Promise<void> {
    const repoLabel = `${tracker.repoOwner}/${tracker.repoName}`;
    const confirmMsg = $locale === "zh-CN"
      ? `确认删除 ${repoLabel} 的追踪器？`
      : `Delete tracker for ${repoLabel}?`;
    if (!window.confirm(confirmMsg)) return;
    isSaving = true;
    try {
      const res = await fetch(`/api/pr-trackers/${encodeURIComponent(tracker.id)}`, {
        method: "DELETE",
      });
      const payload = (await res.json()) as { ok: boolean; result?: ListPayload; error?: string };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      trackers = payload.result.trackers;
    } catch (error) {
      message = t("Delete failed: ", "删除失败：") + String(error);
    } finally {
      isSaving = false;
    }
  }

  async function saveSettings(): Promise<void> {
    isSaving = true;
    message = "";
    try {
      const res = await fetch("/api/pr-trackers/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultPollIntervalSec: formDefaultInterval,
          defaultAgentProvider: formDefaultAgent,
          defaultPromptTemplate: formDefaultPrompt,
          defaultGithubToken: formDefaultToken,
        }),
      });
      const payload = (await res.json()) as { ok: boolean; result?: { settings: PrTrackerSettings }; error?: string };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      settings = payload.result.settings;
      message = t("Settings saved.", "设置已保存。");
    } catch (error) {
      message = t("Save failed: ", "保存失败：") + String(error);
    } finally {
      isSaving = false;
    }
  }

  function toggleExpanded(id: string): void {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedIds = next;
  }

  // Local editable copies keyed by tracker id, so edits don't flicker while typing.
  const drafts = $state<Record<string, {
    agentProvider: string;
    promptTemplate: string;
    pollIntervalSec: string;
    githubToken: string;
    targetChannelId: string;
  }>>({});

  function ensureDraft(tracker: PrTrackerRecord): void {
    if (drafts[tracker.id]) return;
    drafts[tracker.id] = {
      agentProvider: tracker.agentProvider ?? "",
      promptTemplate: tracker.promptTemplate ?? "",
      pollIntervalSec: tracker.pollIntervalSec != null ? String(tracker.pollIntervalSec) : "",
      githubToken: tracker.githubToken ?? "",
      targetChannelId: tracker.targetChannelId ?? "",
    };
  }

  async function applyDraft(tracker: PrTrackerRecord): Promise<void> {
    const draft = drafts[tracker.id];
    if (!draft) return;
    const intervalTrim = draft.pollIntervalSec.trim();
    const interval = intervalTrim === "" ? null : Number(intervalTrim);
    if (interval !== null && (!Number.isFinite(interval) || interval < 60)) {
      message = t("Poll interval must be a number ≥ 60.", "轮询间隔必须是 ≥ 60 的数字。");
      return;
    }
    await saveTracker(tracker, {
      agentProvider: draft.agentProvider.trim() || null,
      promptTemplate: draft.promptTemplate.trim() === "" ? null : draft.promptTemplate,
      pollIntervalSec: interval,
      githubToken: draft.githubToken.trim() === "" ? null : draft.githubToken,
      targetChannelId: draft.targetChannelId.trim() === "" ? null : draft.targetChannelId,
    });
  }

  function groupByChannel(list: PrTrackerRecord[]): Array<{ label: string; items: PrTrackerRecord[] }> {
    const buckets = new Map<string, { label: string; items: PrTrackerRecord[] }>();
    for (const tracker of list) {
      const key = `${tracker.sourceWorkspaceId}::${tracker.sourceChannelId}`;
      const label = `${tracker.sourceWorkspaceName || tracker.sourceWorkspaceId} / ${tracker.sourceChannelName || tracker.sourceChannelId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { label, items: [] };
        buckets.set(key, bucket);
      }
      bucket.items.push(tracker);
    }
    return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  const grouped = $derived(groupByChannel(trackers));

  onMount(() => {
    void loadTrackers();
  });
</script>

<Card className="p-5">
  <div class="mb-4 flex items-start justify-between gap-3">
    <div>
      <h2 class="text-xl font-semibold tracking-tight">{t("PR Tracker", "PR 追踪")}</h2>
      <p class="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
        {t(
          "Watch GitHub repos discovered from each channel's working directory. When enabled, new PR activity triggers an agent run in the target channel.",
          "基于每个频道的工作目录自动发现 GitHub 仓库。启用后，PR 新活动会触发目标频道里的一次 agent 调用。",
        )}
      </p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" type="button" on:click={() => void loadTrackers()} disabled={isLoading}>
        <RefreshCw class="h-4 w-4" />
        {t("Reload", "刷新")}
      </Button>
      <Button type="button" on:click={() => void rescan()} disabled={isScanning}>
        {isScanning ? t("Scanning...", "扫描中...") : t("Rescan repos", "重新扫描仓库")}
      </Button>
    </div>
  </div>

  {#if message}
    <div class="mb-4 rounded-md border border-[hsl(var(--border)/0.7)] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm">
      {message}
    </div>
  {/if}

  <!-- Global defaults -->
  <Card className="mb-5 p-4">
    <button
      type="button"
      class="flex w-full items-center justify-between text-left"
      on:click={() => (isSettingsOpen = !isSettingsOpen)}
    >
      <div class="flex items-center gap-2">
        {#if isSettingsOpen}
          <ChevronDown class="h-4 w-4" />
        {:else}
          <ChevronRight class="h-4 w-4" />
        {/if}
        <h3 class="text-base font-semibold">{t("Global defaults", "全局默认配置")}</h3>
      </div>
      {#if settings}
        <span class="text-xs text-[hsl(var(--muted-foreground))]">
          {t("Interval", "间隔")}: {settings.defaultPollIntervalSec}s ·
          {t("Agent", "Agent")}: {settings.defaultAgentProvider} ·
          {t("Token", "Token")}: {settings.defaultGithubToken ? t("set", "已配置") : t("gh CLI fallback", "回退 gh CLI")}
        </span>
      {/if}
    </button>
    {#if isSettingsOpen}
      <div class="mt-4 grid gap-3">
        <div class="grid gap-1">
          <Label for="pt-default-interval">{t("Default poll interval (seconds)", "默认轮询间隔（秒）")}</Label>
          <Input
            id="pt-default-interval"
            type="number"
            min="60"
            step="60"
            bind:value={formDefaultInterval}
          />
        </div>
        <div class="grid gap-1">
          <Label for="pt-default-agent">{t("Default agent", "默认 Agent")}</Label>
          <Select id="pt-default-agent" bind:value={formDefaultAgent}>
            {#each AGENT_PROVIDERS as provider (provider)}
              <option value={provider}>{AGENT_PROVIDER_LABELS[provider as AgentProviderId]}</option>
            {/each}
          </Select>
        </div>
        <div class="grid gap-1">
          <Label for="pt-default-token">{t("Default GitHub token (blank = fall back to `gh auth token`)", "默认 GitHub Token（留空则回退到 `gh auth token`）")}</Label>
          <Input
            id="pt-default-token"
            type="password"
            placeholder="ghp_..."
            bind:value={formDefaultToken}
          />
        </div>
        <div class="grid gap-1">
          <Label for="pt-default-prompt">{t("Default prompt template", "默认 Prompt 模板")}</Label>
          <Textarea id="pt-default-prompt" rows={8} bind:value={formDefaultPrompt} />
          <p class="text-xs text-[hsl(var(--muted-foreground))]">
            {t(
              "Available variables: {{repo_full_name}}, {{pr_number}}, {{pr_title}}, {{pr_url}}, {{pr_author}}, {{pr_state}}, {{pr_head_ref}}, {{pr_base_ref}}, {{new_events_summary}}",
              "可用变量：{{repo_full_name}}、{{pr_number}}、{{pr_title}}、{{pr_url}}、{{pr_author}}、{{pr_state}}、{{pr_head_ref}}、{{pr_base_ref}}、{{new_events_summary}}",
            )}
          </p>
        </div>
        <div>
          <Button type="button" on:click={() => void saveSettings()} disabled={isSaving}>
            {t("Save defaults", "保存默认配置")}
          </Button>
        </div>
      </div>
    {/if}
  </Card>

  {#if trackers.length === 0}
    <div class="rounded-md border border-dashed border-[hsl(var(--border))] px-4 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
      {t(
        "No trackers yet. Configure a channel's Working directory pointing to a GitHub repo, then click 'Rescan repos'.",
        "暂无追踪器。请先把某个频道的 Working Directory 指向 GitHub 仓库，然后点击\"重新扫描仓库\"。",
      )}
    </div>
  {:else}
    {#each grouped as group (group.label)}
      <div class="mb-6">
        <h3 class="mb-2 text-sm font-semibold text-[hsl(var(--muted-foreground))]">
          {group.label}
        </h3>
        <div class="grid gap-3">
          {#each group.items as tracker (tracker.id)}
            {#if !drafts[tracker.id]}
              {@const _ = (ensureDraft(tracker), null)}
            {/if}
            <Card className={`p-4 ${tracker.missingSince ? "opacity-60" : ""}`}>
              <div class="flex items-start justify-between gap-3">
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <h4 class="text-base font-semibold">{tracker.repoOwner}/{tracker.repoName}</h4>
                    {#if tracker.missingSince}
                      <Badge variant="destructive">{t("missing", "已缺失")}</Badge>
                    {:else if tracker.enabled}
                      <Badge>{t("enabled", "已启用")}</Badge>
                    {:else}
                      <Badge variant="secondary">{t("disabled", "已停用")}</Badge>
                    {/if}
                  </div>
                  <div class="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                    <div>{t("cwd", "工作目录")}: <code>{tracker.workingDirectory}</code></div>
                    <div>
                      {t("target", "目标频道")}:
                      {#if tracker.targetChannelId}
                        <code>{tracker.targetChannelName || tracker.targetChannelId}</code>
                      {:else}
                        <span class="text-[hsl(var(--destructive))]">{t("(not set)", "（未配置）")}</span>
                      {/if}
                      · {t("last poll", "最近轮询")}: {formatRelative(tracker.lastPolledAt)}
                      {#if tracker.lastError}
                        · <span class="text-[hsl(var(--destructive))]">{tracker.lastError}</span>
                      {/if}
                    </div>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    on:click={() => void runNow(tracker)}
                    disabled={!tracker.enabled || runningIds.has(tracker.id) || tracker.missingSince !== null}
                    title={t("Poll now", "立即轮询")}
                  >
                    <Play class="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant={tracker.enabled ? "secondary" : "default"}
                    on:click={() => void toggleEnabled(tracker)}
                    disabled={isSaving || tracker.missingSince !== null}
                  >
                    {tracker.enabled ? t("Disable", "停用") : t("Enable", "启用")}
                  </Button>
                  <Button type="button" variant="outline" on:click={() => toggleExpanded(tracker.id)}>
                    {#if expandedIds.has(tracker.id)}
                      <ChevronDown class="h-4 w-4" />
                    {:else}
                      <ChevronRight class="h-4 w-4" />
                    {/if}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    on:click={() => void deleteTracker(tracker)}
                    disabled={isSaving}
                    title={t("Delete tracker", "删除追踪器")}
                  >
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {#if expandedIds.has(tracker.id) && drafts[tracker.id]}
                <div class="mt-4 grid gap-3 border-t border-[hsl(var(--border)/0.7)] pt-4">
                  <div class="grid gap-1">
                    <Label for={`pt-target-${tracker.id}`}>{t("Target channel", "目标频道")}</Label>
                    <Select id={`pt-target-${tracker.id}`} bind:value={drafts[tracker.id]!.targetChannelId}>
                      <option value="">{t("(not set)", "（未配置）")}</option>
                      {#each channels as channel (channel.value)}
                        <option value={channel.value}>{channel.label}</option>
                      {/each}
                    </Select>
                  </div>
                  <div class="grid gap-1">
                    <Label for={`pt-agent-${tracker.id}`}>{t("Agent", "Agent")}</Label>
                    <Select id={`pt-agent-${tracker.id}`} bind:value={drafts[tracker.id]!.agentProvider}>
                      <option value="">{t("(use default)", "（使用默认）")}</option>
                      {#each AGENT_PROVIDERS as provider (provider)}
                        <option value={provider}>{AGENT_PROVIDER_LABELS[provider as AgentProviderId]}</option>
                      {/each}
                    </Select>
                  </div>
                  <div class="grid gap-1">
                    <Label for={`pt-interval-${tracker.id}`}>{t("Poll interval (seconds, blank = default)", "轮询间隔（秒，留空用默认）")}</Label>
                    <Input
                      id={`pt-interval-${tracker.id}`}
                      type="number"
                      min="60"
                      step="60"
                      bind:value={drafts[tracker.id]!.pollIntervalSec}
                    />
                  </div>
                  <div class="grid gap-1">
                    <Label for={`pt-token-${tracker.id}`}>{t("GitHub token override (blank = default)", "GitHub Token 覆盖（留空用默认）")}</Label>
                    <Input
                      id={`pt-token-${tracker.id}`}
                      type="password"
                      placeholder="ghp_..."
                      bind:value={drafts[tracker.id]!.githubToken}
                    />
                  </div>
                  <div class="grid gap-1">
                    <Label for={`pt-prompt-${tracker.id}`}>{t("Prompt template (blank = default)", "Prompt 模板（留空用默认）")}</Label>
                    <Textarea
                      id={`pt-prompt-${tracker.id}`}
                      rows={8}
                      placeholder={settings?.defaultPromptTemplate ?? ""}
                      bind:value={drafts[tracker.id]!.promptTemplate}
                    />
                  </div>
                  <div class="flex items-center justify-between text-xs text-[hsl(var(--muted-foreground))]">
                    <span>{t("Created", "创建时间")}: {formatTimestamp(tracker.createdAt)} · {t("Updated", "更新时间")}: {formatTimestamp(tracker.updatedAt)}</span>
                    <Button type="button" on:click={() => void applyDraft(tracker)} disabled={isSaving}>
                      {t("Save changes", "保存修改")}
                    </Button>
                  </div>
                </div>
              {/if}
            </Card>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</Card>
