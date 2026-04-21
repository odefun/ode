<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronDown, ChevronRight, Play, RefreshCw, Trash2 } from "lucide-svelte";
  import { Badge, Button, Card, Input, Label, Switch, Textarea } from "$lib/components/ui";
  import { locale } from "$lib/i18n";

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
    promptTemplate: string | null;
    pollIntervalSec: number | null;
    githubToken: string | null;
    lastPolledAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    missingSince: number | null;
    createdAt: number;
    updatedAt: number;
  };

  type PrTrackerSettings = {
    defaultPollIntervalSec: number;
    defaultPromptTemplate: string;
    defaultGithubToken: string;
    updatedAt: number;
  };

  type ListPayload = {
    trackers: PrTrackerRecord[];
    settings: PrTrackerSettings;
  };

  let trackers = $state<PrTrackerRecord[]>([]);
  let settings = $state<PrTrackerSettings | null>(null);
  let isLoading = $state(false);
  let isSaving = $state(false);
  let isScanning = $state(false);
  let message = $state("");
  let runningIds = $state<Set<string>>(new Set());
  let expandedIds = $state<Set<string>>(new Set());

  // Settings form. Interval is exposed in minutes for a nicer UI; the API still
  // stores seconds, so we multiply by 60 on submit and divide on load.
  let formDefaultIntervalMin = $state(30);
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

  function secondsToMinutes(sec: number | null | undefined): number {
    if (!sec || !Number.isFinite(sec)) return 0;
    return Math.max(1, Math.round(sec / 60));
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
      settings = payload.result.settings;
      formDefaultIntervalMin = secondsToMinutes(settings.defaultPollIntervalSec);
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
      if ("promptTemplate" in patch) body.promptTemplate = patch.promptTemplate;
      if ("pollIntervalSec" in patch) body.pollIntervalSec = patch.pollIntervalSec;
      if ("githubToken" in patch) body.githubToken = patch.githubToken;
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
      const intervalMin = Number(formDefaultIntervalMin);
      if (!Number.isFinite(intervalMin) || intervalMin < 1) {
        message = t("Poll interval must be at least 1 minute.", "轮询间隔至少 1 分钟。");
        return;
      }
      const res = await fetch("/api/pr-trackers/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          defaultPollIntervalSec: Math.round(intervalMin * 60),
          defaultPromptTemplate: formDefaultPrompt,
          defaultGithubToken: formDefaultToken,
        }),
      });
      const payload = (await res.json()) as { ok: boolean; result?: { settings: PrTrackerSettings }; error?: string };
      if (!res.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      settings = payload.result.settings;
      formDefaultIntervalMin = secondsToMinutes(settings.defaultPollIntervalSec);
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
  // `pollIntervalMin` stores the minutes the user typed; blank means "use default".
  const drafts = $state<Record<string, {
    promptTemplate: string;
    pollIntervalMin: string;
    githubToken: string;
  }>>({});

  function ensureDraft(tracker: PrTrackerRecord): void {
    if (drafts[tracker.id]) return;
    drafts[tracker.id] = {
      promptTemplate: tracker.promptTemplate ?? "",
      pollIntervalMin:
        tracker.pollIntervalSec != null ? String(secondsToMinutes(tracker.pollIntervalSec)) : "",
      githubToken: tracker.githubToken ?? "",
    };
  }

  async function applyDraft(tracker: PrTrackerRecord): Promise<void> {
    const draft = drafts[tracker.id];
    if (!draft) return;
    const minTrim = draft.pollIntervalMin.trim();
    let intervalSec: number | null = null;
    if (minTrim !== "") {
      const minutes = Number(minTrim);
      if (!Number.isFinite(minutes) || minutes < 1) {
        message = t("Poll interval must be ≥ 1 minute.", "轮询间隔必须 ≥ 1 分钟。");
        return;
      }
      intervalSec = Math.round(minutes * 60);
    }
    await saveTracker(tracker, {
      promptTemplate: draft.promptTemplate.trim() === "" ? null : draft.promptTemplate,
      pollIntervalSec: intervalSec,
      githubToken: draft.githubToken.trim() === "" ? null : draft.githubToken,
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
          "Watch GitHub repos discovered from each channel's working directory. When enabled, new PR activity triggers an agent run in that channel.",
          "基于每个频道的工作目录自动发现 GitHub 仓库。启用后，PR 新活动会触发该频道里的一次 agent 调用。",
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
          {t("Interval", "间隔")}: {secondsToMinutes(settings.defaultPollIntervalSec)} {t("min", "分钟")} ·
          {t("Token", "Token")}: {settings.defaultGithubToken ? t("set", "已配置") : t("gh CLI fallback", "回退 gh CLI")}
        </span>
      {/if}
    </button>
    {#if isSettingsOpen}
      <div class="mt-4 grid gap-3">
        <div class="grid gap-1">
          <Label for="pt-default-interval">{t("Default poll interval (minutes)", "默认轮询间隔（分钟）")}</Label>
          <Input
            id="pt-default-interval"
            type="number"
            min="1"
            step="1"
            bind:value={formDefaultIntervalMin}
          />
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
          <p class="text-xs text-[hsl(var(--muted-foreground))]">
            {t(
              "Each channel can override this prompt to match the repo's conventions.",
              "每个频道可以单独覆盖这个 Prompt，以匹配各自仓库的习惯。",
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
                      {t("last poll", "最近轮询")}: {formatRelative(tracker.lastPolledAt)}
                      {#if tracker.lastError}
                        · <span class="text-[hsl(var(--destructive))]">{tracker.lastError}</span>
                      {/if}
                    </div>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={tracker.enabled}
                    disabled={isSaving || tracker.missingSince !== null}
                    ariaLabel={tracker.enabled ? t("Disable", "停用") : t("Enable", "启用")}
                    on:change={() => void toggleEnabled(tracker)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    on:click={() => void runNow(tracker)}
                    disabled={!tracker.enabled || runningIds.has(tracker.id) || tracker.missingSince !== null}
                    title={t("Poll now", "立即轮询")}
                  >
                    <Play class="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    on:click={() => toggleExpanded(tracker.id)}
                  >
                    {#if expandedIds.has(tracker.id)}
                      <ChevronDown class="h-3.5 w-3.5" />
                    {:else}
                      <ChevronRight class="h-3.5 w-3.5" />
                    {/if}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="h-8 w-8 p-0"
                    on:click={() => void deleteTracker(tracker)}
                    disabled={isSaving}
                    title={t("Delete tracker", "删除追踪器")}
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {#if expandedIds.has(tracker.id) && drafts[tracker.id]}
                <div class="mt-4 grid gap-3 border-t border-[hsl(var(--border)/0.7)] pt-4">
                  <div class="grid gap-1">
                    <Label for={`pt-interval-${tracker.id}`}>{t("Poll interval (minutes, blank = default)", "轮询间隔（分钟，留空用默认）")}</Label>
                    <Input
                      id={`pt-interval-${tracker.id}`}
                      type="number"
                      min="1"
                      step="1"
                      bind:value={drafts[tracker.id]!.pollIntervalMin}
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
