<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { ChevronDown, RefreshCw } from "lucide-svelte";
  import type { DashboardConfig } from "$lib/localConfig";
  import {
    AGENT_PROVIDERS,
    AGENT_PROVIDER_LABELS,
    normalizeAgentProviderId,
    type AgentProviderId,
  } from "@/shared/agent-provider";
  import { Badge, Button, Card, Input, Label, Select, Textarea } from "$lib/components/ui";
  import { locale } from "$lib/i18n";
  import { localSettingStore } from "$lib/local-setting/store";
  import { getSelectedWorkspace, getWorkspacePath, getWorkspaceRouteKey } from "$lib/local-setting/workspaces";

  type AgentProvider = AgentProviderId;
  type ChannelComputerUse = NonNullable<DashboardConfig["workspaces"][number]["channelDetails"][number]["computerUse"]>;

  const agentProviders = AGENT_PROVIDERS;

  let openChannelId = $state("");
  let hasAutoOpenedChannel = $state(false);

  function parseAgentProvider(value: unknown): AgentProvider {
    return normalizeAgentProviderId(value);
  }

  function isProviderEnabled(provider: AgentProvider): boolean {
    return $localSettingStore.config.agents[provider]?.enabled === true;
  }

  let isCanonicalizingWorkspaceRoute = false;

  const selectedWorkspace = $derived(getSelectedWorkspace($page.params.workspaceName ?? "", $localSettingStore.config.workspaces));
  const duplicateWorkspaceIds = $derived(getDuplicateWorkspaceIds($localSettingStore.config.workspaces));
  const duplicateSlackBotTokens = $derived(getDuplicateSlackBotTokens($localSettingStore.config.workspaces));
  const duplicateDiscordBotTokens = $derived(getDuplicateDiscordBotTokens($localSettingStore.config.workspaces));
  const duplicateLarkAppKeys = $derived(getDuplicateLarkAppKeys($localSettingStore.config.workspaces));
  const selectedWorkspaceErrors = $derived(getWorkspaceErrors(
    selectedWorkspace,
    duplicateWorkspaceIds,
    duplicateSlackBotTokens,
    duplicateDiscordBotTokens,
    duplicateLarkAppKeys
  ));
  const enabledProviders = $derived(agentProviders.filter((provider) => isProviderEnabled(provider)));

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  $effect(() => {
    maybeCanonicalizeWorkspaceRoute();
  });

  $effect(() => {
    const channels = selectedWorkspace?.channelDetails ?? [];
    if (!channels.length) {
      openChannelId = "";
      hasAutoOpenedChannel = false;
      return;
    }

    if (!hasAutoOpenedChannel) {
      openChannelId = channels[0]?.id ?? "";
      hasAutoOpenedChannel = true;
      return;
    }

    if (openChannelId && !channels.some((channel) => channel.id === openChannelId)) {
      openChannelId = channels[0]?.id ?? "";
    }
  });

  function maybeCanonicalizeWorkspaceRoute(): void {
    if ($localSettingStore.isLoading || isCanonicalizingWorkspaceRoute || !selectedWorkspace) return;
    const currentWorkspaceName = $page.params.workspaceName ?? "";
    const canonicalPath = getWorkspacePath(selectedWorkspace);
    const canonicalWorkspaceName = getWorkspaceRouteKey(selectedWorkspace);
    if (decodeURIComponent(currentWorkspaceName) === canonicalWorkspaceName) return;

    isCanonicalizingWorkspaceRoute = true;
    void goto(canonicalPath, { replaceState: true, noScroll: true, keepFocus: true }).finally(() => {
      isCanonicalizingWorkspaceRoute = false;
    });
  }

  function getChannelProvider(channel: { agentProvider?: string }): AgentProvider {
    return parseAgentProvider(channel.agentProvider);
  }

  function ensureAgentEnabled(provider: AgentProvider): AgentProvider {
    if (enabledProviders.includes(provider)) return provider;
    return enabledProviders[0] ?? "opencode";
  }

  function shouldShowChannelModel(channel: { agentProvider?: string }): boolean {
    const provider = getChannelProvider(channel);
    return getProviderModels(provider) !== null;
  }

  function getProviderModels(provider: AgentProvider): string[] | null {
    const config = $localSettingStore.config.agents as Record<string, { models?: string[] }>;
    const entry = config[provider];
    return Array.isArray(entry?.models) ? entry.models : null;
  }

  function getChannelModelSelectValue(channel: { agentProvider?: string; model: string }): string {
    const provider = getChannelProvider(channel);
    if (provider === "codex" && !channel.model) return "__default__";
    return channel.model;
  }

  function onWorkspaceFieldInput(
    workspaceId: string,
    field: "name" | "domain" | "slackAppToken" | "slackBotToken" | "discordBotToken" | "larkAppKey" | "larkAppId" | "larkAppSecret",
    value: string
  ): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      [field]: value,
      ...(field === "larkAppKey" ? { larkAppId: value } : {}),
    }));
  }

  function onWorkspaceTextInput(
    workspaceId: string,
    field: "name" | "domain" | "slackAppToken" | "slackBotToken" | "discordBotToken" | "larkAppKey" | "larkAppId" | "larkAppSecret",
    event: Event
  ): void {
    onWorkspaceFieldInput(workspaceId, field, (event.currentTarget as HTMLInputElement).value);
  }

  function onChannelProviderChange(workspaceId: string, channelId: string, event: Event): void {
    const selected = (event.currentTarget as HTMLSelectElement).value;
    const provider = parseAgentProvider(selected);
    const providerModels = getProviderModels(provider) ?? [];
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) => {
        if (channel.id !== channelId) return channel;
        const nextModel = provider === "codex"
          ? (providerModels.includes(channel.model) ? channel.model : "")
          : (providerModels.length > 0
            ? (providerModels.includes(channel.model) ? channel.model : (providerModels[0] ?? ""))
            : "");
        return {
          ...channel,
          agentProvider: provider,
          model: nextModel,
        };
      }),
    }));
  }

  function onChannelModelChange(workspaceId: string, channelId: string, model: string): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) =>
        channel.id === channelId ? { ...channel, model } : channel
      ),
    }));
  }

  function onChannelModelSelect(workspaceId: string, channelId: string, event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    onChannelModelChange(workspaceId, channelId, value === "__default__" ? "" : value);
  }

  function onChannelWorkingDirectoryChange(workspaceId: string, channelId: string, workingDirectory: string): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) =>
        channel.id === channelId ? { ...channel, workingDirectory } : channel
      ),
    }));
  }

  function onChannelWorkingDirectoryInput(workspaceId: string, channelId: string, event: Event): void {
    onChannelWorkingDirectoryChange(workspaceId, channelId, (event.currentTarget as HTMLInputElement).value);
  }

  function onChannelSystemMessageChange(workspaceId: string, channelId: string, channelSystemMessage: string): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) =>
        channel.id === channelId ? { ...channel, channelSystemMessage } : channel
      ),
    }));
  }

  function onChannelBaseBranchChange(workspaceId: string, channelId: string, baseBranch: string): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) =>
        channel.id === channelId ? { ...channel, baseBranch } : channel
      ),
    }));
  }

  function onChannelBaseBranchInput(workspaceId: string, channelId: string, event: Event): void {
    onChannelBaseBranchChange(workspaceId, channelId, (event.currentTarget as HTMLInputElement).value);
  }

  function onChannelSystemMessageInput(workspaceId: string, channelId: string, event: Event): void {
    onChannelSystemMessageChange(workspaceId, channelId, (event.currentTarget as HTMLTextAreaElement).value);
  }

  function getComputerUse(channel: DashboardConfig["workspaces"][number]["channelDetails"][number]): ChannelComputerUse {
    return channel.computerUse ?? {
      browser: "off",
      desktop: "off",
      browserProfile: "",
      allowedOrigins: ["http://localhost:*", "http://127.0.0.1:*"],
      allowedApps: [],
      approvalPolicy: "consequential",
    };
  }

  function updateComputerUse(
    workspaceId: string,
    channelId: string,
    updater: (current: ChannelComputerUse) => ChannelComputerUse
  ): void {
    localSettingStore.updateWorkspace(workspaceId, (workspace) => ({
      ...workspace,
      channelDetails: workspace.channelDetails.map((channel) =>
        channel.id === channelId
          ? { ...channel, computerUse: updater(getComputerUse(channel)) }
          : channel
      ),
    }));
  }

  function onComputerSelect(
    workspaceId: string,
    channelId: string,
    field: "browser" | "desktop" | "approvalPolicy",
    event: Event
  ): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    updateComputerUse(workspaceId, channelId, (current) => ({ ...current, [field]: value }) as ChannelComputerUse);
  }

  function onComputerList(
    workspaceId: string,
    channelId: string,
    field: "allowedOrigins" | "allowedApps",
    event: Event
  ): void {
    const values = (event.currentTarget as HTMLTextAreaElement).value
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    updateComputerUse(workspaceId, channelId, (current) => ({ ...current, [field]: values }));
  }

  function getDuplicateWorkspaceIds(workspaces: DashboardConfig["workspaces"]): Set<string> {
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
      const workspaceId = workspace.id.trim();
      if (!workspaceId) continue;
      counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([id]) => id));
  }

  function getWorkspaceErrors(
    workspace: DashboardConfig["workspaces"][number] | null,
    duplicateIds: Set<string>,
    duplicateBotTokens: Set<string>,
    duplicateDiscordTokens: Set<string>,
    duplicateLarkIds: Set<string>
  ): string[] {
    if (!workspace) return [];
    const errors: string[] = [];
    if (!workspace.id.trim()) {
      errors.push("Workspace ID is required.");
    } else if (duplicateIds.has(workspace.id.trim())) {
      errors.push(`Workspace ID '${workspace.id}' is duplicated.`);
    }
    if (workspace.type === "discord") {
      if (!(workspace.discordBotToken?.trim() ?? "")) {
        errors.push("Discord Bot Token is required.");
      } else if (duplicateDiscordTokens.has((workspace.discordBotToken ?? "").trim())) {
        errors.push("Discord Bot Token must be unique across workspaces.");
      }
      return errors;
    }
    if (workspace.type === "lark") {
      const appKey = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      if (!appKey) {
        errors.push("Lark App Key is required.");
      } else if (duplicateLarkIds.has(appKey)) {
        errors.push("Lark App Key must be unique across workspaces.");
      }
      if (!(workspace.larkAppSecret?.trim() ?? "")) {
        errors.push("Lark App Secret is required.");
      }
      return errors;
    }
    if (!(workspace.slackAppToken?.trim() ?? "")) {
      errors.push("Slack App Token is required.");
    }
    if (!(workspace.slackBotToken?.trim() ?? "")) {
      errors.push("Slack Bot Token is required.");
    } else if (duplicateBotTokens.has((workspace.slackBotToken ?? "").trim())) {
      errors.push("Slack Bot Token must be unique across workspaces.");
    }
    return errors;
  }

  function getDuplicateSlackBotTokens(workspaces: DashboardConfig["workspaces"]): Set<string> {
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.type !== "slack") continue;
      const botToken = workspace.slackBotToken?.trim() ?? "";
      if (!botToken) continue;
      counts.set(botToken, (counts.get(botToken) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([token]) => token));
  }

  function getDuplicateDiscordBotTokens(workspaces: DashboardConfig["workspaces"]): Set<string> {
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.type !== "discord") continue;
      const botToken = workspace.discordBotToken?.trim() ?? "";
      if (!botToken) continue;
      counts.set(botToken, (counts.get(botToken) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([token]) => token));
  }

  function getDuplicateLarkAppKeys(workspaces: DashboardConfig["workspaces"]): Set<string> {
    const counts = new Map<string, number>();
    for (const workspace of workspaces) {
      if (workspace.type !== "lark") continue;
      const appId = workspace.larkAppKey?.trim() || workspace.larkAppId?.trim() || "";
      if (!appId) continue;
      counts.set(appId, (counts.get(appId) ?? 0) + 1);
    }
    return new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([appId]) => appId));
  }

  function toggleChannel(channelId: string): void {
    openChannelId = openChannelId === channelId ? "" : channelId;
  }
</script>

{#if selectedWorkspace}
  <Card className="p-5">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 class="text-lg font-semibold">{selectedWorkspace.name || t("Workspace 1", "工作区 1")}</h2>
        <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("Workspace credentials and channel routing", "工作区凭据与频道路由配置")}</p>
      </div>
      {#if selectedWorkspace.type === "slack"}
        <Button
          variant="outline"
          on:click={() => void localSettingStore.syncSlackWorkspace(selectedWorkspace.id)}
          disabled={$localSettingStore.isSyncingSlack || $localSettingStore.isAddingWorkspace || $localSettingStore.isLoading || $localSettingStore.isSaving}
        >
          <RefreshCw class="h-4 w-4" />
          {$localSettingStore.isSyncingSlack ? t("Syncing...", "同步中...") : t("Sync", "同步")}
        </Button>
      {:else if selectedWorkspace.type === "discord"}
        <Button
          variant="outline"
          on:click={() => void localSettingStore.syncDiscordWorkspace(selectedWorkspace.id)}
          disabled={$localSettingStore.isSyncingSlack || $localSettingStore.isAddingWorkspace || $localSettingStore.isLoading || $localSettingStore.isSaving}
        >
          <RefreshCw class="h-4 w-4" />
          {$localSettingStore.isSyncingSlack ? t("Syncing...", "同步中...") : t("Sync", "同步")}
        </Button>
      {:else}
        <Button
          variant="outline"
          on:click={() => void localSettingStore.syncLarkWorkspace(selectedWorkspace.id)}
          disabled={$localSettingStore.isSyncingSlack || $localSettingStore.isAddingWorkspace || $localSettingStore.isLoading || $localSettingStore.isSaving}
        >
          <RefreshCw class="h-4 w-4" />
          {$localSettingStore.isSyncingSlack ? t("Syncing...", "同步中...") : t("Sync", "同步")}
        </Button>
      {/if}
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <div class="grid gap-2">
        <Label for="workspace-name">{t("Workspace Name", "工作区名称")}</Label>
        <Input
          id="workspace-name"
          value={selectedWorkspace.name}
          disabled
          on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "name", event)}
        />
      </div>

      <div class="grid gap-2">
        <Label for="workspace-domain">{t("Domain", "域名")}</Label>
        <Input
          id="workspace-domain"
          value={selectedWorkspace.domain}
          disabled
          on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "domain", event)}
        />
      </div>

      {#if selectedWorkspace.type === "slack"}
        <div class="grid gap-2">
          <Label for="workspace-app-token">Slack App Token</Label>
          <Input
            id="workspace-app-token"
            type="password"
            value={selectedWorkspace.slackAppToken ?? ""}
            on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "slackAppToken", event)}
            autocomplete="new-password"
          />
        </div>

        <div class="grid gap-2">
          <Label for="workspace-bot-token">Slack Bot Token</Label>
          <Input
            id="workspace-bot-token"
            type="password"
            value={selectedWorkspace.slackBotToken ?? ""}
            on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "slackBotToken", event)}
            autocomplete="new-password"
          />
        </div>

      {:else if selectedWorkspace.type === "discord"}
        <div class="grid gap-2">
          <Label for="workspace-discord-bot-token">Discord Bot Token</Label>
          <Input
            id="workspace-discord-bot-token"
            type="password"
            value={selectedWorkspace.discordBotToken ?? ""}
            on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "discordBotToken", event)}
            autocomplete="new-password"
          />
        </div>
      {:else}
        <div class="grid gap-2">
          <Label for="workspace-lark-app-key">Lark App Key</Label>
          <Input
            id="workspace-lark-app-key"
            type="text"
            value={selectedWorkspace.larkAppKey ?? selectedWorkspace.larkAppId ?? ""}
            on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "larkAppKey", event)}
          />
        </div>

        <div class="grid gap-2">
          <Label for="workspace-lark-app-secret">Lark App Secret</Label>
          <Input
            id="workspace-lark-app-secret"
            type="password"
            value={selectedWorkspace.larkAppSecret ?? ""}
            on:input={(event) => onWorkspaceTextInput(selectedWorkspace.id, "larkAppSecret", event)}
            autocomplete="new-password"
          />
        </div>
      {/if}
    </div>

    {#if selectedWorkspaceErrors.length > 0}
      <div class="mt-4 rounded-lg border border-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.08)] p-3">
        {#each selectedWorkspaceErrors as error}
          <p class="text-sm text-[hsl(var(--destructive))]">{error}</p>
        {/each}
      </div>
    {/if}
  </Card>

  <Card className="p-5">
    <div class="mb-3 flex items-center justify-between">
      <h3 class="text-base font-semibold">{t("Channels", "频道")}</h3>
      <Badge variant="outline">{selectedWorkspace.channelDetails.length} {t("total", "总计")}</Badge>
    </div>

    <div class="space-y-2">
      {#each selectedWorkspace.channelDetails as channel}
        <div class="overflow-hidden rounded-lg border border-[hsl(var(--border)/0.75)] bg-[hsl(var(--card)/0.52)] backdrop-blur-sm">
          <button
            class="flex w-full items-center justify-between bg-[hsl(var(--muted)/0.38)] px-3 py-2 text-left"
            type="button"
            onclick={() => toggleChannel(channel.id)}
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-medium">{channel.name || channel.id}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">{channel.id}</Badge>
            </div>
            <ChevronDown class={`h-4 w-4 transition-transform ${openChannelId === channel.id ? "rotate-180" : ""}`} />
          </button>

          {#if openChannelId === channel.id}
            <div class="grid gap-3 border-t border-[hsl(var(--border)/0.65)] bg-[hsl(var(--background)/0.72)] p-3">
              <div class="grid gap-3 md:grid-cols-2">
                <div class="grid gap-2">
                  <Label for={`channel-agent-${channel.id}`}>{t("Agent", "代理")}</Label>
                  <Select
                    id={`channel-agent-${channel.id}`}
                    value={ensureAgentEnabled(getChannelProvider(channel))}
                    on:change={(event) => onChannelProviderChange(selectedWorkspace.id, channel.id, event)}
                  >
                    {#each enabledProviders as provider}
                      <option value={provider}>{AGENT_PROVIDER_LABELS[provider]}</option>
                    {/each}
                  </Select>
                </div>

                {#if shouldShowChannelModel(channel)}
                  <div class="grid gap-2">
                    <Label for={`channel-model-${channel.id}`}>{t("Model", "模型")}</Label>
                    <Select
                      id={`channel-model-${channel.id}`}
                      value={getChannelModelSelectValue(channel)}
                      on:change={(event) => onChannelModelSelect(selectedWorkspace.id, channel.id, event)}
                    >
                      {#if getChannelProvider(channel) === "codex"}
                        <option value="__default__">{t("Use default (gpt-5.3-codex)", "使用默认值 (gpt-5.3-codex)")}</option>
                      {/if}
                      {#if (getProviderModels(getChannelProvider(channel)) ?? []).length === 0
                        && getChannelProvider(channel) !== "codex"}
                        <option value="" disabled>{t("No models configured", "未配置模型")}</option>
                      {/if}
                      {#if !(getProviderModels(getChannelProvider(channel)) ?? []).includes(channel.model) && channel.model}
                        <option value={channel.model}>{channel.model}</option>
                      {/if}
                      {#each getProviderModels(getChannelProvider(channel)) ?? [] as model}
                        <option value={model}>{model}</option>
                      {/each}
                    </Select>
                  </div>
                {/if}
              </div>

              <div class="grid gap-2">
                <Label for={`channel-working-directory-${channel.id}`}>{t("Working directory", "工作目录")}</Label>
                <Input
                  id={`channel-working-directory-${channel.id}`}
                  value={channel.workingDirectory}
                  placeholder={t("~/Code/project", "~/Code/project")}
                  on:input={(event) => onChannelWorkingDirectoryInput(selectedWorkspace.id, channel.id, event)}
                />
              </div>

              <div class="grid gap-2">
                <Label for={`channel-base-branch-${channel.id}`}>{t("Base branch", "基础分支")}</Label>
                <Input
                  id={`channel-base-branch-${channel.id}`}
                  value={channel.baseBranch}
                  placeholder={t("main", "main")}
                  on:input={(event) => onChannelBaseBranchInput(selectedWorkspace.id, channel.id, event)}
                />
              </div>

              <div class="grid gap-2">
                <Label for={`channel-system-message-${channel.id}`}>{t("Channel System Message (optional)", "频道系统消息（可选）")}</Label>
                <Textarea
                  id={`channel-system-message-${channel.id}`}
                  rows="3"
                  value={channel.channelSystemMessage ?? ""}
                  placeholder={t("Appended to the system prompt for this channel", "将附加到此频道的系统提示词")}
                  on:input={(event) => onChannelSystemMessageInput(selectedWorkspace.id, channel.id, event)}
                ></Textarea>
              </div>

              <div class="grid gap-3 rounded-md border border-[hsl(var(--border)/0.65)] p-3">
                <div>
                  <p class="text-sm font-medium">{t("Computer use", "Computer Use")}</p>
                  <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Fail-closed per-channel access for OpenCode, Claude Code, and Codex through Ode's local Computer Gateway.", "通过 Ode 本地 Computer Gateway 为 OpenCode、Claude Code 和 Codex 提供按频道、默认关闭的访问控制。")}</p>
                </div>
                <div class="grid gap-3 md:grid-cols-3">
                  <div class="grid gap-2">
                    <Label for={`computer-browser-${channel.id}`}>{t("Browser", "浏览器")}</Label>
                    <Select
                      id={`computer-browser-${channel.id}`}
                      value={getComputerUse(channel).browser}
                      on:change={(event) => onComputerSelect(selectedWorkspace.id, channel.id, "browser", event)}
                    >
                      <option value="off">Off</option>
                      <option value="observe">Observe</option>
                      <option value="interact">Interact</option>
                    </Select>
                  </div>
                  <div class="grid gap-2">
                    <Label for={`computer-desktop-${channel.id}`}>{t("macOS desktop", "macOS 桌面")}</Label>
                    <Select
                      id={`computer-desktop-${channel.id}`}
                      value={getComputerUse(channel).desktop}
                      on:change={(event) => onComputerSelect(selectedWorkspace.id, channel.id, "desktop", event)}
                    >
                      <option value="off">Off</option>
                      <option value="observe">Observe</option>
                      <option value="control">Control</option>
                    </Select>
                  </div>
                  <div class="grid gap-2">
                    <Label for={`computer-approval-${channel.id}`}>{t("Approval", "审批")}</Label>
                    <Select
                      id={`computer-approval-${channel.id}`}
                      value={getComputerUse(channel).approvalPolicy}
                      on:change={(event) => onComputerSelect(selectedWorkspace.id, channel.id, "approvalPolicy", event)}
                    >
                      <option value="consequential">Consequential</option>
                      <option value="always">Always</option>
                      <option value="never">Never</option>
                    </Select>
                  </div>
                </div>
                <div class="grid gap-3 md:grid-cols-2">
                  <div class="grid gap-2">
                    <Label for={`computer-origins-${channel.id}`}>{t("Allowed origins", "允许的 Origin")}</Label>
                    <Textarea
                      id={`computer-origins-${channel.id}`}
                      rows="3"
                      value={getComputerUse(channel).allowedOrigins.join("\n")}
                      placeholder="http://localhost:*"
                      on:input={(event) => onComputerList(selectedWorkspace.id, channel.id, "allowedOrigins", event)}
                    ></Textarea>
                  </div>
                  <div class="grid gap-2">
                    <Label for={`computer-apps-${channel.id}`}>{t("Allowed macOS apps", "允许的 macOS App")}</Label>
                    <Textarea
                      id={`computer-apps-${channel.id}`}
                      rows="3"
                      value={getComputerUse(channel).allowedApps.join("\n")}
                      placeholder="Safari"
                      on:input={(event) => onComputerList(selectedWorkspace.id, channel.id, "allowedApps", event)}
                    ></Textarea>
                  </div>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </Card>
{:else}
  <Card className="p-5">
    <h2 class="text-lg font-semibold">{t("Workspace", "工作区")}</h2>
    <p class="text-sm text-[hsl(var(--muted-foreground))]">{t("No workspace found yet.", "尚未找到工作区。")}</p>
  </Card>
{/if}
