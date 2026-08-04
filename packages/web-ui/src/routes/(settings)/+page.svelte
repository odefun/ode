<script lang="ts">
  import {
    DEFAULT_STATUS_MESSAGE_FREQUENCY_MS,
    STATUS_MESSAGE_FREQUENCY_OPTIONS,
    TOOL_DISPLAY_CONFIG,
    type DashboardConfig,
    type GitStrategy,
    type StatusMessageFrequencyMs,
    type StatusMessageFrequencyValue,
    type StatusMessageFormat,
    parseStatusMessageFrequencyMs,
    toStatusMessageFrequencyValue,
  } from "$lib/localConfig";
  import { onMount } from "svelte";
  import { Badge, Button, Card } from "$lib/components/ui";
  import ToggleGroup from "$lib/components/ui/toggle-group.svelte";
  import { locale } from "$lib/i18n";
  import { localSettingStore } from "$lib/local-setting/store";

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  const statusMessageFormatOptions = Object.keys(TOOL_DISPLAY_CONFIG) as StatusMessageFormat[];
  const statusMessageFormatItems = statusMessageFormatOptions.map((option) => ({
    value: option,
    label: option.charAt(0).toUpperCase() + option.slice(1),
  }));
  const gitStrategyItems: Array<{ value: GitStrategy; label: string }> = [
    { value: "worktree", label: "Worktree" },
    { value: "default", label: "Default" },
  ];
  const statusMessageFrequencyItems: Array<{ value: StatusMessageFrequencyValue; label: string }> =
    STATUS_MESSAGE_FREQUENCY_OPTIONS.map((option: (typeof STATUS_MESSAGE_FREQUENCY_OPTIONS)[number]) => ({
      value: option.value,
      label: option.label,
    }));
  const autoUpdateItems: Array<{ value: "on" | "off"; label: string }> = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
  const computerGatewayItems: Array<{ value: "on" | "off"; label: string }> = [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  type ComputerSetupStatus = {
    platform: string;
    supported: boolean;
    ready: boolean;
    browser: { installed: boolean; ready: boolean; version?: string; error?: string };
    desktop: {
      installed: boolean;
      ready: boolean;
      version?: string;
      appPath?: string;
      error?: string;
      permissions?: Array<{ name?: string; isGranted?: boolean }>;
    };
  };

  let computerStatus: ComputerSetupStatus | null = null;
  let computerBusy = false;
  let computerMessage = "";

  async function loadComputerStatus(): Promise<void> {
    try {
      const response = await fetch("/api/computer");
      const payload = await response.json() as { ok?: boolean; error?: string; result?: ComputerSetupStatus };
      if (!response.ok || !payload.ok || !payload.result) throw new Error(payload.error || "Status check failed");
      computerStatus = payload.result;
    } catch (error) {
      computerMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function runComputerAction(action: string, extra: Record<string, unknown> = {}): Promise<void> {
    computerBusy = true;
    computerMessage = "";
    try {
      const response = await fetch("/api/computer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Computer setup failed");
      computerMessage = action === "self-test"
        ? t("Self-test completed.", "自检已完成。")
        : t("Action completed. Rechecking permissions…", "操作已完成，正在重新检查权限……");
      await loadComputerStatus();
      if (action === "setup") await localSettingStore.loadConfig();
    } catch (error) {
      computerMessage = error instanceof Error ? error.message : String(error);
    } finally {
      computerBusy = false;
    }
  }

  onMount(() => {
    void loadComputerStatus();
  });

  function parseStatusMessageFrequencySelection(value: string): StatusMessageFrequencyMs {
    return parseStatusMessageFrequencyMs(Number(value));
  }

  function parseStatusMessageFormat(value: string): StatusMessageFormat {
    if (value === "minimum" || value === "aggressive") return value;
    return "medium";
  }

  function parseGitStrategyValue(value: string): GitStrategy {
    return value === "default" ? "default" : "worktree";
  }

  function handleStatusFormatChange(nextValue: string): void {
    const nextFormat = parseStatusMessageFormat(nextValue);
    localSettingStore.updateConfig((config: DashboardConfig) => ({
      ...config,
      user: { ...config.user, defaultStatusMessageFormat: nextFormat },
    }));
  }

  function handleStatusFrequencyChange(nextValue: string): void {
    const nextMs = parseStatusMessageFrequencySelection(nextValue);
    localSettingStore.updateConfig((config: DashboardConfig) => ({
      ...config,
      user: { ...config.user, statusMessageFrequencyMs: nextMs },
    }));
  }

  function handleGitStrategyChange(nextValue: string): void {
    const nextStrategy = parseGitStrategyValue(nextValue);
    localSettingStore.updateConfig((config: DashboardConfig) => ({
      ...config,
      user: { ...config.user, gitStrategy: nextStrategy },
    }));
  }

  function handleAutoUpdateChange(nextValue: string): void {
    localSettingStore.updateConfig((config: DashboardConfig) => ({
      ...config,
      updates: {
        ...config.updates,
        autoUpgrade: nextValue !== "off",
      },
    }));
  }

  function handleComputerGatewayChange(nextValue: string): void {
    localSettingStore.updateConfig((config: DashboardConfig) => ({
      ...config,
      computerGateway: {
        ...config.computerGateway,
        enabled: nextValue === "on",
      },
    }));
  }
</script>

<Card className="p-5">
  <div class="mb-4 flex items-center justify-between gap-2">
    <div>
      <h2 class="text-lg font-semibold">{t("General", "通用")}</h2>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Current version", "当前版本")}: {$localSettingStore.appVersion || t("unknown", "未知")}</p>
    </div>
  </div>

  <div class="grid gap-5">
    <div class="grid gap-2">
      <p class="text-sm font-medium">{t("Status Message Format", "状态消息格式")}</p>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Minimum shows concise progress, Medium balances progress and details, Aggressive includes the most detailed live updates.", "Minimum 显示简洁进度，Medium 平衡进度与细节，Aggressive 提供最详细的实时更新。")}</p>
      <div class="inline-block w-fit">
        <ToggleGroup
          items={statusMessageFormatItems}
          value={$localSettingStore.config.user.defaultStatusMessageFormat}
          onValueChange={handleStatusFormatChange}
        />
      </div>
    </div>

    <div class="grid gap-2">
      <p class="text-sm font-medium">{t("Computer Gateway", "Computer Gateway")}</p>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Enables local browser automation and macOS control through Ode. Each channel must still be explicitly allowed in its workspace settings.", "启用 Ode 的本地浏览器自动化与 macOS 控制；仍需在工作区中逐频道授权。")}</p>
      <div class="inline-block w-fit">
        <ToggleGroup
          items={computerGatewayItems}
          value={$localSettingStore.config.computerGateway.enabled ? "on" : "off"}
          onValueChange={handleComputerGatewayChange}
        />
      </div>

      <div class="mt-2 grid gap-3 rounded-lg border p-4">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-medium">{t("This Mac", "本机状态")}</span>
          {#if computerStatus}
            <Badge variant={computerStatus.ready ? "success" : "secondary"}>
              {computerStatus.ready ? t("Ready", "已就绪") : t("Setup required", "需要设置")}
            </Badge>
          {:else}
            <Badge variant="secondary">{t("Checking…", "检查中……")}</Badge>
          {/if}
        </div>

        {#if computerStatus}
          <div class="grid gap-2 text-xs text-[hsl(var(--muted-foreground))] sm:grid-cols-2">
            <div class="rounded-md bg-[hsl(var(--muted)/0.45)] p-3">
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="font-medium text-[hsl(var(--foreground))]">{t("Browser", "浏览器")}</span>
                <Badge variant={computerStatus.browser.ready ? "success" : "secondary"}>
                  {computerStatus.browser.ready ? t("Ready", "已就绪") : t("Needs setup", "需要设置")}
                </Badge>
              </div>
              <p>{computerStatus.browser.version || computerStatus.browser.error || t("agent-browser is not installed", "agent-browser 尚未安装")}</p>
            </div>
            <div class="rounded-md bg-[hsl(var(--muted)/0.45)] p-3">
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="font-medium text-[hsl(var(--foreground))]">Ode macOS</span>
                <Badge variant={computerStatus.desktop.ready ? "success" : "secondary"}>
                  {computerStatus.desktop.ready ? t("Authorized", "已授权") : t("Permission required", "需要授权")}
                </Badge>
              </div>
              <p>{computerStatus.desktop.version || computerStatus.desktop.error || t("Ode.app is not installed", "Ode.app 尚未安装")}</p>
              {#if computerStatus.desktop.appPath}<p class="mt-1 break-all">{computerStatus.desktop.appPath}</p>{/if}
            </div>
          </div>

          {#if computerStatus.desktop.permissions?.length}
            <div class="flex flex-wrap gap-2">
              {#each computerStatus.desktop.permissions as permission}
                <Badge variant={permission.isGranted ? "success" : "outline"}>
                  {permission.name}: {permission.isGranted ? t("Allowed", "已允许") : t("Not allowed", "未允许")}
                </Badge>
              {/each}
            </div>
          {/if}
        {/if}

        <div class="flex flex-wrap gap-2">
          <Button size="sm" disabled={computerBusy} on:click={() => void runComputerAction("setup")}>
            {computerBusy ? t("Working…", "处理中……") : t("Set up Ode", "设置 Ode")}
          </Button>
          <Button size="sm" variant="outline" disabled={computerBusy || !computerStatus?.desktop.installed} on:click={() => void runComputerAction("request-permissions")}>
            {t("Request permissions", "请求权限")}
          </Button>
          <Button size="sm" variant="outline" disabled={computerBusy || !computerStatus?.desktop.installed} on:click={() => void runComputerAction("open-settings", { kind: "screen-recording" })}>
            {t("Screen Recording", "屏幕录制")}
          </Button>
          <Button size="sm" variant="outline" disabled={computerBusy || !computerStatus?.desktop.installed} on:click={() => void runComputerAction("open-settings", { kind: "accessibility" })}>
            {t("Accessibility", "辅助功能")}
          </Button>
          <Button size="sm" variant="outline" disabled={computerBusy || !computerStatus?.desktop.ready} on:click={() => void runComputerAction("self-test")}>
            {t("Run self-test", "运行自检")}
          </Button>
        </div>
        <p class="text-xs text-[hsl(var(--muted-foreground))]">
          {t("macOS shows one permission entry: Ode. Full Disk Access is not requested.", "macOS 权限列表只会显示 Ode；不会请求完全磁盘访问权限。")}
        </p>
        {#if computerMessage}<p class="text-xs">{computerMessage}</p>{/if}
      </div>
    </div>

    <div class="grid gap-2">
      <p class="text-sm font-medium">{t("Status Message Frequency", "状态消息频率")}</p>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Controls how often status messages refresh while a request is running.", "控制请求执行时状态消息的刷新频率。")}</p>
      <div class="inline-block w-fit">
        <ToggleGroup
          items={statusMessageFrequencyItems}
          value={toStatusMessageFrequencyValue($localSettingStore.config.user.statusMessageFrequencyMs ?? DEFAULT_STATUS_MESSAGE_FREQUENCY_MS)}
          onValueChange={handleStatusFrequencyChange}
        />
      </div>
    </div>

    <div class="grid gap-2">
      <p class="text-sm font-medium">{t("Git Strategy", "Git 策略")}</p>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Worktree will create different worktree folders under `.worktree` folder for each chat thread.", "Worktree 会为每个会话线程在 `.worktree` 目录下创建独立工作目录。")}</p>
      <div class="inline-block w-fit">
        <ToggleGroup
          items={gitStrategyItems}
          value={$localSettingStore.config.user.gitStrategy}
          onValueChange={handleGitStrategyChange}
        />
      </div>
    </div>

    <div class="grid gap-2">
      <p class="text-sm font-medium">{t("Auto Update", "自动更新")}</p>
      <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Controls whether Ode automatically checks for and applies updates.", "控制 Ode 是否自动检查并应用更新。")}</p>
      <div class="inline-block w-fit">
        <ToggleGroup
          items={autoUpdateItems}
          value={$localSettingStore.config.updates.autoUpgrade === false ? "off" : "on"}
          onValueChange={handleAutoUpdateChange}
        />
      </div>
    </div>
  </div>

  <div class="mt-5 flex justify-end">
    <Button
      on:click={() => void localSettingStore.saveConfig()}
      disabled={$localSettingStore.isLoading || $localSettingStore.isSaving || $localSettingStore.isSyncingSlack || $localSettingStore.isAddingWorkspace || $localSettingStore.isCheckingCli}
    >
      {t("Save", "保存")}
    </Button>
  </div>
</Card>
