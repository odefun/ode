<script lang="ts">
  import { onMount } from "svelte";
  import { Bot, ChevronDown } from "lucide-svelte";
  import { Badge, Button, Card } from "$lib/components/ui";
  import { locale } from "$lib/i18n";
  import { localSettingStore } from "$lib/local-setting/store";
  import {
    AGENT_PROVIDERS,
    providerSupportsModelSelection,
    type AgentProviderId,
  } from "@/shared/agent-provider";

  const AGENT_DOCS: Record<AgentProviderId, string> = {
    opencode: "https://opencode.ai",
    claudecode: "https://docs.anthropic.com/en/docs/claude-code/overview",
    codex: "https://github.com/openai/codex",
    kimi: "https://www.moonshot.ai/kimi-code",
    kilo: "https://github.com/Kilo-Org/kilo",
    qwen: "https://github.com/QwenLM/qwen-code",
    goose: "https://block.github.io/goose/",
    pi: "https://github.com/earendil-works/pi",
    openhands: "https://docs.openhands.dev",
    codebuddy: "https://www.codebuddy.ai/docs/cli/overview",
    crush: "https://github.com/charmbracelet/crush",
  };

  const AGENT_TITLES: Record<AgentProviderId, string> = {
    opencode: "OpenCode CLI",
    claudecode: "Claude Code",
    codex: "Codex CLI",
    kimi: "Kimi CLI",
    kilo: "Kilo CLI",
    qwen: "Qwen CLI",
    goose: "Goose CLI",
    pi: "Pi CLI",
    openhands: "OpenHands CLI",
    codebuddy: "CodeBuddy CLI",
    crush: "Crush CLI",
  };

  let expandedModelAgents = $state<Partial<Record<AgentProviderId, boolean>>>({});

  const isBusy = $derived($localSettingStore.isCheckingCli || $localSettingStore.isLoading || $localSettingStore.isSaving);

  function getAgentModels(agent: AgentProviderId): string[] {
    const agents = $localSettingStore.config.agents as Record<string, { models?: string[] }>;
    const models = agents[agent]?.models;
    return Array.isArray(models) ? models : [];
  }

  function getInstallStatus(agent: AgentProviderId): boolean | undefined {
    const result = $localSettingStore.cliCheckResult;
    if (!result) return undefined;
    if (agent === "claudecode") return result.claudecode ?? result.claude;
    return result[agent];
  }

  function getModelError(agent: AgentProviderId): string | undefined {
    const result = $localSettingStore.cliCheckResult;
    if (!result) return undefined;
    if (agent === "opencode") return result.opencodeModelError;
    if (agent === "kilo") return result.kiloModelError;
    if (agent === "pi") return result.piModelError;
    if (agent === "openhands") return result.openhandsModelError;
    if (agent === "codebuddy") return result.codebuddyModelError;
    if (agent === "crush") return result.crushModelError;
    return undefined;
  }

  function isCheckingAgent(agent: AgentProviderId): boolean {
    return $localSettingStore.checkingAgents[agent] === true;
  }

  function isExpanded(agent: AgentProviderId): boolean {
    return expandedModelAgents[agent] === true;
  }

  function toggleModels(agent: AgentProviderId): void {
    expandedModelAgents = {
      ...expandedModelAgents,
      [agent]: !expandedModelAgents[agent],
    };
  }

  function t(en: string, zh: string): string {
    return $locale === "zh-CN" ? zh : en;
  }

  onMount(() => {
    void localSettingStore.checkAgents();
  });
</script>

<Card className="p-5">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <div class="flex items-center gap-2">
      <Bot class="h-4 w-4 text-[hsl(var(--muted-foreground))]" />
      <div>
        <h2 class="text-lg font-semibold">{t("Agent CLI Status", "代理 CLI 状态")}</h2>
        <p class="text-xs text-[hsl(var(--muted-foreground))]">{t("Installed coding tool CLIs and configured models", "已安装的编码工具 CLI 与已配置模型")}</p>
      </div>
    </div>
    <Button
      variant="outline"
      onclick={() => void localSettingStore.checkAgents()}
      disabled={isBusy}
    >
      {$localSettingStore.isCheckingCli ? t("Syncing...", "同步中...") : t("Sync", "同步")}
    </Button>
  </div>

  <div class="grid gap-2">
    {#each AGENT_PROVIDERS as agent}
      {@const supportsModels = providerSupportsModelSelection(agent)}
      {@const models = getAgentModels(agent)}
      {@const installed = getInstallStatus(agent)}
      {@const modelError = getModelError(agent)}
      <div class="rounded-lg border p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <strong class="text-sm">{AGENT_TITLES[agent]}</strong>
            {#if isCheckingAgent(agent)}
              <Badge variant="secondary">{t("Checking...", "检查中...")}</Badge>
            {:else if installed !== undefined}
              <Badge variant={installed ? "success" : "secondary"}>
                {installed ? t("Installed", "已安装") : t("Not found", "未安装")}
              </Badge>
            {/if}
            {#if modelError}
              <Badge variant="destructive">{t("Model sync failed", "模型同步失败")}</Badge>
            {/if}
            {#if installed === false}
              <a class="text-xs text-[hsl(var(--primary))] underline" href={AGENT_DOCS[agent]} target="_blank" rel="noreferrer">{t("Install docs", "安装文档")}</a>
            {/if}
          </div>

          {#if supportsModels}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-[hsl(var(--border))] px-2 py-1 text-xs text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted)/0.45)]"
              aria-expanded={isExpanded(agent)}
              onclick={() => toggleModels(agent)}
            >
              <span>({models.length} models)</span>
              <ChevronDown class={`h-3.5 w-3.5 transition-transform ${isExpanded(agent) ? "rotate-180" : ""}`} />
            </button>
          {/if}
        </div>

        {#if supportsModels && isExpanded(agent)}
          <div class="mt-3 flex flex-wrap gap-1">
            {#if models.length > 0}
              {#each models as model}
                <Badge variant="outline">{model}</Badge>
              {/each}
            {:else if installed}
              <Badge variant="outline">{t("No models configured", "未配置模型")}</Badge>
            {:else}
              <Badge variant="outline">{t("No models", "无模型")}</Badge>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if $localSettingStore.agentMessage}
    <p class="mt-4 text-sm text-[hsl(var(--muted-foreground))]">{$localSettingStore.agentMessage}</p>
  {/if}
</Card>
