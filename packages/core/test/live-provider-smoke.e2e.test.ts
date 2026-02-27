import { describe, expect, it } from "bun:test";
import { createMessageProcessor } from "@/agents/message-processor";

const runLive = process.env.RUN_LIVE_E2E === "1";

describe("live provider smoke e2e", () => {
  const smokeTest = runLive ? it : it.skip;

  smokeTest("runs a real provider round-trip when explicitly enabled", async () => {
    const provider = process.env.LIVE_E2E_PROVIDER?.trim();
    const cwd = process.env.LIVE_E2E_CWD?.trim() || process.cwd();
    const channelId = process.env.LIVE_E2E_CHANNEL_ID?.trim() || "CLIVE-E2E";
    const threadId = process.env.LIVE_E2E_THREAD_ID?.trim() || "TLIVE-E2E";

    if (!provider) {
      throw new Error("LIVE_E2E_PROVIDER is required when RUN_LIVE_E2E=1");
    }

    const adapter = createMessageProcessor();
    const session = await adapter.getOrCreateSession(channelId, threadId, cwd, {});
    const modelId = process.env.LIVE_E2E_MODEL?.trim();
    const options = modelId
      ? {
        model: {
          providerID: provider,
          modelID: modelId,
        },
      }
      : undefined;

    const responses = await adapter.sendMessage(
      channelId,
      session.sessionId,
      "Reply with exactly LIVE_E2E_OK and nothing else.",
      cwd,
      options
    );

    const merged = responses.map((entry) => entry.text).join("\n");
    expect(merged.toUpperCase()).toContain("LIVE_E2E_OK");
  });
});
