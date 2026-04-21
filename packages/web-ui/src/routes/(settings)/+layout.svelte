<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { Building2, Github, Plus, Trash2 } from "lucide-svelte";
  import ThemeToggle from "$lib/components/ThemeToggle.svelte";
  import { Button, Card, Input, Label, Select } from "$lib/components/ui";
  import { initLocale, locale, setLocalePreference, type Locale } from "$lib/i18n";
  import { localSettingStore } from "$lib/local-setting/store";
  import { getSelectedWorkspace, getWorkspacePath } from "$lib/local-setting/workspaces";

  let { children } = $props();

  const pathname = $derived($page.url.pathname);
  const normalizedPathname = $derived(pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname);
  const activeSection = $derived.by<"general" | "agents" | "inbox" | "cronJobs" | "tasks" | "prTracker" | "workspace">(() =>
    normalizedPathname === "/agents"
      ? "agents"
      : normalizedPathname === "/inbox"
        ? "inbox"
      : normalizedPathname === "/cron-jobs"
        ? "cronJobs"
      : normalizedPathname === "/tasks"
        ? "tasks"
      : normalizedPathname === "/pr-tracker"
        ? "prTracker"
        : normalizedPathname.startsWith("/workspace")
          ? "workspace"
          : "general"
  );
  let pendingWorkspaceType = $state<"slack" | "discord" | "lark">("slack");
  let pendingSlackAppToken = $state("");
  let pendingSlackBotToken = $state("");
  let pendingDiscordBotToken = $state("");
  let pendingLarkAppKey = $state("");
  let pendingLarkAppSecret = $state("");
  let isAddWorkspaceDialogOpen = $state(false);

  const selectedWorkspace = $derived(getSelectedWorkspace($page.params.workspaceName ?? "", $localSettingStore.config.workspaces));
  const isBusy = $derived($localSettingStore.isLoading
    || $localSettingStore.isSaving
    || $localSettingStore.isSyncingSlack
    || $localSettingStore.isAddingWorkspace
    || $localSettingStore.isCheckingCli);
  const hasErrorMessage = $derived(/(failed:|validation failed:|\berror\b)/i.test($localSettingStore.message));
  const canAddWorkspace = $derived.by(() => {
    if (pendingWorkspaceType === "discord") return pendingDiscordBotToken.trim().length > 0;
    if (pendingWorkspaceType === "lark") {
      return pendingLarkAppKey.trim().length > 0 && pendingLarkAppSecret.trim().length > 0;
    }
    return pendingSlackAppToken.trim().length > 0 && pendingSlackBotToken.trim().length > 0;
  });

  async function addWorkspace(): Promise<void> {
    const workspace = pendingWorkspaceType === "discord"
      ? await localSettingStore.discoverDiscordWorkspace(pendingDiscordBotToken)
      : pendingWorkspaceType === "lark"
        ? await localSettingStore.discoverLarkWorkspace(pendingLarkAppKey, pendingLarkAppSecret)
        : await localSettingStore.discoverSlackWorkspace(
          pendingSlackAppToken,
          pendingSlackBotToken
        );
    if (!workspace) return;
    pendingSlackAppToken = "";
    pendingSlackBotToken = "";
    pendingDiscordBotToken = "";
    pendingLarkAppKey = "";
    pendingLarkAppSecret = "";
    pendingWorkspaceType = "slack";
    isAddWorkspaceDialogOpen = false;
    await goto(getWorkspacePath(workspace));
  }

  function openAddWorkspaceDialog(): void {
    isAddWorkspaceDialogOpen = true;
  }

  function closeAddWorkspaceDialog(): void {
    isAddWorkspaceDialogOpen = false;
  }

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  function onLanguageChange(event: Event): void {
    const nextLocale = (event.currentTarget as HTMLSelectElement).value as Locale;
    setLocalePreference(nextLocale);
  }

  function onPendingSlackAppTokenInput(event: Event): void {
    pendingSlackAppToken = (event.currentTarget as HTMLInputElement).value;
  }

  function onPendingSlackBotTokenInput(event: Event): void {
    pendingSlackBotToken = (event.currentTarget as HTMLInputElement).value;
  }

  function onPendingDiscordBotTokenInput(event: Event): void {
    pendingDiscordBotToken = (event.currentTarget as HTMLInputElement).value;
  }

  function onPendingLarkAppKeyInput(event: Event): void {
    pendingLarkAppKey = (event.currentTarget as HTMLInputElement).value;
  }

  function onPendingLarkAppSecretInput(event: Event): void {
    pendingLarkAppSecret = (event.currentTarget as HTMLInputElement).value;
  }

  async function removeWorkspace(workspaceId: string): Promise<void> {
    const workspaces = $localSettingStore.config.workspaces;
    const removingIndex = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (removingIndex < 0) return;

    const workspaceToRemove = workspaces[removingIndex];
    const workspaceLabel = workspaceToRemove?.name?.trim() || workspaceToRemove?.id || workspaceId;
    const removeMessage = $locale === "zh-CN"
      ? `确认移除工作区「${workspaceLabel}」？`
      : `Remove workspace '${workspaceLabel}'?`;
    if (!window.confirm(removeMessage)) {
      return;
    }

    const remainingWorkspaces = workspaces.filter((workspace) => workspace.id !== workspaceId);
    await localSettingStore.removeWorkspace(workspaceId);

    if (activeSection !== "workspace" || selectedWorkspace?.id !== workspaceId) return;

    const nextWorkspace =
      remainingWorkspaces[removingIndex]
      ?? remainingWorkspaces[removingIndex - 1]
      ?? remainingWorkspaces[0]
      ?? null;

    if (nextWorkspace) {
      void goto(getWorkspacePath(nextWorkspace), { replaceState: true });
      return;
    }

    void goto("/", { replaceState: true });
  }

  function getWorkspaceLogo(type: "slack" | "discord" | "lark"): string {
    if (type === "discord") return "/discord-logo.svg";
    if (type === "lark") return "/lark-logo.png";
    return "/slack-logo.svg";
  }

  onMount(() => {
    initLocale();
    if (!$localSettingStore.loaded) {
      void localSettingStore.loadConfig();
    }
  });
</script>

<div class="min-h-screen">
  <header class="mx-auto w-full max-w-7xl px-4 pt-6 md:px-8">
    <nav class="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl px-1 py-1">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Ode</h1>
        <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("Work anywhere with your favourite coding agents connected", "随时随地，连接你喜爱的编码代理")}</p>
      </div>
      <div class="flex items-center gap-2">
        <a
          href="https://github.com/odefun/ode"
          target="_blank"
          rel="noreferrer"
          class="inline-flex h-10 items-center gap-2 rounded-md border border-[hsl(var(--border)/0.7)] px-3 text-sm text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--muted)/0.45)]"
        >
          <Github class="h-4 w-4" />
          GitHub
        </a>
        <ThemeToggle />
        <Select value={$locale} on:change={onLanguageChange} className="h-10 w-[120px]">
          <option value="en">English</option>
          <option value="zh-CN">中文</option>
        </Select>
      </div>
    </nav>
  </header>

  <main class="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4 px-4 pb-6 md:px-8 lg:grid-cols-[18rem_1fr] lg:gap-6">
    <aside class="space-y-4">
    <Card className="p-4">
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <h1 class="text-base font-semibold">{t("Ode Settings", "Ode 设置")}</h1>
        </div>
      </div>

      <div class="space-y-2">
        <Button
          variant={activeSection === "general" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/")}
        >
          {t("General", "通用")}
        </Button>
        <Button
          variant={activeSection === "agents" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/agents")}
        >
          {t("Agents", "Agents")}
        </Button>
        <Button
          variant={activeSection === "inbox" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/inbox")}
        >
          {t("Inbox", "收件箱")}
        </Button>
        <Button
          variant={activeSection === "cronJobs" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/cron-jobs")}
        >
          {t("Cron Jobs", "定时任务")}
        </Button>
        <Button
          variant={activeSection === "tasks" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/tasks")}
        >
          {t("Tasks", "一次性任务")}
        </Button>
        <Button
          variant={activeSection === "prTracker" ? "default" : "secondary"}
          className="w-full justify-start"
          on:click={() => goto("/pr-tracker")}
        >
          {t("PR Tracker", "PR 追踪")}
        </Button>
      </div>
    </Card>

    <Card className="p-4">
      <div class="mb-3 flex items-center gap-2">
        <div class="flex items-center gap-2">
          <Building2 class="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
          <h2 class="text-sm font-semibold">{t("Workspaces", "工作区")}</h2>
        </div>
      </div>

      <div class="space-y-2">
        {#if $localSettingStore.config.workspaces.length === 0}
          <p class="rounded-md border border-dashed px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">{t("No workspaces", "暂无工作区")}</p>
        {:else}
          {#each $localSettingStore.config.workspaces as workspace}
            <Button
              variant={selectedWorkspace?.id === workspace.id && activeSection === "workspace" ? "default" : "outline"}
              className="w-full justify-start"
              on:click={() => goto(getWorkspacePath(workspace))}
            >
              <img src={getWorkspaceLogo(workspace.type)} alt={`${workspace.type} logo`} class="h-4 w-4 rounded-sm" />
              <span class="truncate">{workspace.name || workspace.id}</span>
            </Button>
          {/each}
        {/if}

        <Button
          variant="outline"
          className="w-full justify-start"
          type="button"
          on:click={openAddWorkspaceDialog}
          disabled={isBusy}
        >
          <Plus class="h-4 w-4" />
          {t("Add Workspace", "添加工作区")}
        </Button>
      </div>
    </Card>
    </aside>

    <section class="space-y-4">
      {@render children()}

    {#if activeSection === "workspace"}
      <Card className="border-0 bg-transparent p-0 shadow-none backdrop-blur-none">
        <div class="flex flex-wrap items-center justify-end gap-2">
          {#if selectedWorkspace}
            <Button
              variant="destructive"
              type="button"
              on:click={() => void removeWorkspace(selectedWorkspace.id)}
              disabled={isBusy}
            >
              <Trash2 class="h-4 w-4" />
              {t("Remove Workspace", "移除工作区")}
            </Button>
          {/if}
          <Button
            on:click={() => void localSettingStore.saveConfig()}
            disabled={isBusy}
          >
            {t("Save", "保存")}
          </Button>
        </div>
      </Card>
    {/if}

    {#if $localSettingStore.message}
      <Card className={`p-3 ${hasErrorMessage ? "border-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.08)]" : ""}`}>
        <p class={`mb-1 text-xs font-semibold uppercase tracking-wide ${hasErrorMessage ? "text-[hsl(var(--destructive))]" : "text-[hsl(var(--muted-foreground))]"}`}>
          {hasErrorMessage ? t("Error", "错误") : t("Message", "消息")}
        </p>
        <p class={`text-sm ${hasErrorMessage ? "text-[hsl(var(--destructive))]" : "text-[hsl(var(--muted-foreground))]"}`}>
          {$localSettingStore.message}
        </p>
      </Card>
    {/if}
    </section>
  </main>
</div>

{#if isAddWorkspaceDialogOpen}
  <div class="fixed inset-0 z-50 p-4" role="presentation">
    <button
      type="button"
      class="absolute inset-0 bg-[var(--overlay-backdrop)]"
      aria-label={t("Close add workspace dialog", "关闭添加工作区弹窗")}
      onclick={closeAddWorkspaceDialog}
    ></button>
    <div class="relative">
      <Card className="mx-auto mt-[8vh] w-full max-w-xl p-5" role="dialog" aria-modal="true" aria-labelledby="add-workspace-title">
        <h2 id="add-workspace-title" class="mb-4 text-lg font-semibold">{t("Add Workspace", "添加工作区")}</h2>

      <div class="grid gap-4">
        <div class="grid gap-2">
          <Label for="new-workspace-type">{t("Workspace Type", "工作区类型")}</Label>
          <Select id="new-workspace-type" bind:value={pendingWorkspaceType}>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            <option value="lark">Lark</option>
          </Select>
        </div>

        {#if pendingWorkspaceType === "slack"}
          <div class="grid gap-2">
            <Label for="new-workspace-app-token">Slack App Token</Label>
            <Input
              id="new-workspace-app-token"
              type="password"
              value={pendingSlackAppToken}
              on:input={onPendingSlackAppTokenInput}
              autocomplete="new-password"
              placeholder="xapp-..."
            />
          </div>
          <div class="grid gap-2">
            <Label for="new-workspace-bot-token">Slack Bot Token</Label>
            <Input
              id="new-workspace-bot-token"
              type="password"
              value={pendingSlackBotToken}
              on:input={onPendingSlackBotTokenInput}
              autocomplete="new-password"
              placeholder="xoxb-..."
            />
          </div>
        {:else if pendingWorkspaceType === "discord"}
          <div class="grid gap-2">
            <Label for="new-workspace-discord-bot-token">Discord Bot Token</Label>
            <Input
              id="new-workspace-discord-bot-token"
              type="password"
              value={pendingDiscordBotToken}
              on:input={onPendingDiscordBotTokenInput}
              autocomplete="new-password"
              placeholder="Bot token"
            />
          </div>
        {:else}
          <div class="grid gap-2">
            <Label for="new-workspace-lark-app-key">Lark App Key</Label>
            <Input
              id="new-workspace-lark-app-key"
              type="text"
              value={pendingLarkAppKey}
              on:input={onPendingLarkAppKeyInput}
              placeholder="cli_xxx"
            />
          </div>

          <div class="grid gap-2">
            <Label for="new-workspace-lark-app-secret">Lark App Secret</Label>
            <Input
              id="new-workspace-lark-app-secret"
              type="password"
              value={pendingLarkAppSecret}
              on:input={onPendingLarkAppSecretInput}
              autocomplete="new-password"
              placeholder="app secret"
            />
          </div>
        {/if}
      </div>

        <div class="mt-5 flex justify-end gap-2">
          <Button variant="outline" type="button" on:click={closeAddWorkspaceDialog}>{t("Cancel", "取消")}</Button>
          <Button
            type="button"
            on:click={() => void addWorkspace()}
            disabled={isBusy || !canAddWorkspace}
          >
            {$localSettingStore.isAddingWorkspace ? t("Adding...", "添加中...") : t("Add Workspace", "添加工作区")}
          </Button>
        </div>
      </Card>
    </div>
  </div>
{/if}
