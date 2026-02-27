import { DEFAULT_CODEX_MODEL, getChannelModel } from "@/config";
import type { OpenCodeOptions } from "@/agents";
import type { AgentProviderId } from "@/shared/agent-provider";

function toKiloModel(modelValue: string | null | undefined): OpenCodeOptions["model"] | undefined {
  const trimmed = modelValue?.trim();
  if (!trimmed) return undefined;
  const [providerID = "kilo", ...rest] = trimmed.split("/");
  if (rest.length === 0) {
    return { providerID: "kilo", modelID: trimmed };
  }
  return { providerID, modelID: rest.join("/") };
}

export function buildMessageOptions(params: {
  text: string;
  channelId: string;
  providerId: AgentProviderId;
}): OpenCodeOptions | undefined {
  const { text, channelId, providerId } = params;
  const normalizedText = text.trimStart().toLowerCase();
  const agent = /^plan\b/.test(normalizedText) ? "plan" : undefined;

  const channelModel = getChannelModel(channelId)?.trim();
  const codexModel = providerId === "codex"
    ? (channelModel && channelModel.length > 0 ? channelModel : DEFAULT_CODEX_MODEL)
    : undefined;
  const kiloModel = providerId === "kilo" ? toKiloModel(channelModel) : undefined;

  if (!agent && !codexModel && !kiloModel) {
    return undefined;
  }

  return {
    ...(agent ? { agent } : {}),
    ...(codexModel ? { model: { providerID: "openai", modelID: codexModel } } : {}),
    ...(kiloModel ? { model: kiloModel } : {}),
  };
}
