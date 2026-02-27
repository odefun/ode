import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenCodeMessageContext } from "@/agents";
import { buildPromptParts, buildSystemPrompt } from "@/agents/shared";
import { getAgentProvider, type AgentProviderId } from "@/agents/registry";
import type { OpenCodeMessage, OpenCodeOptions } from "@/agents/types";
import { normalizeAgentProviderId } from "@/shared/agent-provider";
import { extractEventSessionId } from "@/utils";
import { buildHarnessRunId, HarnessRedisStore } from "../redis-store";
import type { HarnessCapturedEvent, HarnessRunMeta } from "../types";

const DEFAULT_CHANNEL_ID = "C_LIVE_STATUS_HARNESS";
const DEFAULT_USER_ID = "U_LIVE_STATUS_HARNESS";
const HARNESS_OPENCODE_HOST = "127.0.0.1";
const HARNESS_OPENCODE_PORT = 40960;

function parseArg(name: string): string | undefined {
  const exact = `--${name}`;
  const prefix = `--${name}=`;
  const index = Bun.argv.findIndex((value) => value === exact || value.startsWith(prefix));
  if (index < 0) return undefined;
  const value = Bun.argv[index] ?? "";
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return Bun.argv[index + 1];
}

function normalizeProvider(value: string | undefined): AgentProviderId {
  return normalizeAgentProviderId(value);
}

function parseModelArg(value: string | undefined): OpenCodeOptions["model"] | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const [providerRaw, modelRaw] = normalized.includes("/")
    ? normalized.split("/", 2)
    : ["openai", normalized];
  const providerID = providerRaw?.trim().toLowerCase().replace(/\s+/g, "-") ?? "openai";
  const modelID = modelRaw?.trim() ?? "";
  if (!modelID) {
    throw new Error("Invalid --model value; use <provider>/<model> or <model>");
  }
  return { providerID, modelID };
}

async function loadPrompt(promptPath?: string): Promise<string> {
  const defaultPath = new URL("../fixed-prompt.md", import.meta.url);
  const file = promptPath ? Bun.file(promptPath) : Bun.file(defaultPath);
  const text = (await file.text()).trim();
  if (!text) throw new Error("Prompt text is empty");
  return text;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

async function waitForServerReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  const endpoint = new URL("/config/providers", baseUrl).toString();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Keep polling while server boots.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for OpenCode server on ${baseUrl}`);
}

async function startDedicatedOpencodeServer(): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const baseUrl = `http://${HARNESS_OPENCODE_HOST}:${HARNESS_OPENCODE_PORT}`;
  const child = spawn("opencode", [
    "serve",
    "--hostname",
    HARNESS_OPENCODE_HOST,
    "--port",
    String(HARNESS_OPENCODE_PORT),
    "--print-logs",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const exitedEarly = new Promise<never>((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `OpenCode harness server exited early on ${baseUrl} (code=${String(code)}, signal=${String(signal)}). `
          + `Check whether port ${HARNESS_OPENCODE_PORT} is already in use.`
        )
      );
    });
  });

  await Promise.race([waitForServerReady(baseUrl), exitedEarly]);

  return {
    baseUrl,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 5_000);
      });
      await Promise.race([exited, timeout]);
    },
  };
}

function parseOpenCodeResponse(data: unknown): OpenCodeMessage[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const messages: OpenCodeMessage[] = [];

  const pushText = (value: unknown): void => {
    if (typeof value !== "string") return;
    const text = value.trim();
    if (!text) return;
    messages.push({ text, messageType: "assistant" });
  };

  const responseParts = Array.isArray(record.parts) ? record.parts : [];
  for (const part of responseParts) {
    if (!part || typeof part !== "object") continue;
    const partRecord = part as Record<string, unknown>;
    if (partRecord.type === "text") {
      pushText(partRecord.text);
    }
  }

  if (messages.length === 0 && Array.isArray(record.messages)) {
    for (const entry of record.messages) {
      if (!entry || typeof entry !== "object") continue;
      const messageRecord = entry as Record<string, unknown>;
      pushText(messageRecord.text);
      if (Array.isArray(messageRecord.parts)) {
        for (const part of messageRecord.parts) {
          if (!part || typeof part !== "object") continue;
          const partRecord = part as Record<string, unknown>;
          if (partRecord.type === "text") {
            pushText(partRecord.text);
          }
        }
      }
    }
  }

  if (messages.length === 0) {
    pushText(record.text);
    pushText(record.output_text);
  }

  return messages;
}

async function main(): Promise<void> {
  const provider = normalizeProvider(parseArg("provider") || process.env.ODE_AGENT_PROVIDER);
  const cwd = parseArg("cwd") || process.cwd();
  const channelId = parseArg("channel") || DEFAULT_CHANNEL_ID;
  const threadId = parseArg("thread") || `T_${Date.now()}`;
  const userId = parseArg("user") || DEFAULT_USER_ID;
  const prompt = await loadPrompt(parseArg("prompt-file"));
  const model = parseModelArg(parseArg("model"));
  const agent = parseArg("agent") || (provider === "gemini" ? "plan" : undefined);

  const runId = parseArg("run-id") || buildHarnessRunId(provider);
  const startedAt = Date.now();
  const promptHash = hashPrompt(prompt);
  const redisPrefix = parseArg("redis-prefix");
  const store = new HarnessRedisStore(redisPrefix);
  await store.connect();
  let eventCount = 0;
  const pendingWrites: Array<Promise<void>> = [];

  try {
    const context: OpenCodeMessageContext = {
      slack: {
        channelId,
        threadId,
        userId,
        hasCustomSlackTool: false,
        odeSlackApiUrl: process.env.ODE_SLACK_API_URL,
        hasGitHubToken: Boolean(process.env.GH_TOKEN),
      },
    };

    if (provider === "opencode") {
      const dedicatedServer = await startDedicatedOpencodeServer();
      const client = createOpencodeClient({ baseUrl: dedicatedServer.baseUrl });
      const created = await client.session.create({ directory: cwd });
      const sessionId = created.data?.id;
      if (!sessionId) {
        throw new Error("Failed to create OpenCode harness session");
      }

      const runMeta: HarnessRunMeta = {
        runId,
        provider,
        prompt,
        promptHash,
        cwd,
        channelId,
        threadId,
        sessionId,
        startedAt,
        eventCount,
      };
      await store.saveRunMeta(runMeta);

      let streamClosed = false;
      const events = await client.global.event();
      const streamTask = (async () => {
        for await (const globalEvent of events.stream) {
          if (streamClosed) break;
          const payload = (globalEvent as { payload?: unknown }).payload ?? globalEvent;
          const payloadRecord = payload && typeof payload === "object"
            ? payload as Record<string, unknown>
            : undefined;
          const eventSessionId = extractEventSessionId(payloadRecord);
          if (eventSessionId && eventSessionId !== sessionId) continue;
          const captured: HarnessCapturedEvent = {
            runId,
            sessionId,
            provider,
            timestamp: Date.now(),
            index: eventCount,
            event: globalEvent,
          };
          eventCount += 1;
          pendingWrites.push(store.appendEvent(captured));
        }
      })();

      try {
        const parts = buildPromptParts(channelId, prompt, model ? { model } : undefined, context);
        const system = buildSystemPrompt(context.slack);
        const response = await client.session.prompt({
          sessionID: sessionId,
          directory: cwd,
          parts,
          system,
          ...(model ? { model } : {}),
        });
        if (response.error) {
          throw new Error(`OpenCode error: ${response.error}`);
        }

        const responses = parseOpenCodeResponse(response.data);
        await Promise.all(pendingWrites);

        const finalText = responses
          .map((entry) => entry.text)
          .filter((text) => text.trim().length > 0)
          .join("\n\n");

        await store.updateRunMeta(runId, {
          completedAt: Date.now(),
          eventCount,
          finalText,
        });

        process.stdout.write(`${JSON.stringify({ runId, provider, sessionId, eventCount })}\n`);
      } finally {
        streamClosed = true;
        await dedicatedServer.stop();
        await Promise.race([
          streamTask,
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      return;
    }

    const providerClient = getAgentProvider(provider);
    const session = await providerClient.getOrCreateSession(channelId, threadId, cwd, {});

    const runMeta: HarnessRunMeta = {
      runId,
      provider,
      prompt,
      promptHash,
      cwd,
      channelId,
      threadId,
      sessionId: session.sessionId,
      startedAt,
      eventCount,
    };
    await store.saveRunMeta(runMeta);

    const unsubscribe = providerClient.subscribeToSession(session.sessionId, (event) => {
      const captured: HarnessCapturedEvent = {
        runId,
        sessionId: session.sessionId,
        provider,
        timestamp: Date.now(),
        index: eventCount,
        event,
      };
      eventCount += 1;
      pendingWrites.push(store.appendEvent(captured));
    });

    let responses: OpenCodeMessage[] = [];
    try {
      const options: OpenCodeOptions | undefined = model || agent
        ? {
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        }
        : undefined;
      responses = await providerClient.sendMessage(
        channelId,
        session.sessionId,
        prompt,
        cwd,
        options,
        context
      );
    } finally {
      unsubscribe();
    }

    await Promise.all(pendingWrites);

    const finalText = responses
      .map((response) => response.text)
      .filter((text) => text.trim().length > 0)
      .join("\n\n");

    await store.updateRunMeta(runId, {
      completedAt: Date.now(),
      eventCount,
      finalText,
    });

    process.stdout.write(`${JSON.stringify({ runId, provider, sessionId: session.sessionId, eventCount })}\n`);
  } finally {
    await Promise.allSettled(pendingWrites);
    await store.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
