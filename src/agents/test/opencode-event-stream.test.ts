import { afterAll, describe, expect, it } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { statusFromEvent, type ProgressEvent } from "../opencode/client";

const baseUrl = process.env.OPENCODE_TEST_URL || "http://127.0.0.1:8080";
const testDir = process.env.OPENCODE_TEST_DIR || process.cwd();

const promptText =
  "Please inspect this repository and explain the top-level structure, main entry points, and any agent-related folders.";

type GlobalEventResult = Awaited<
  ReturnType<ReturnType<typeof createOpencodeClient>["global"]["event"]>
>;

describe("opencode event stream", () => {
  let streamResult: GlobalEventResult | undefined;

  afterAll(async () => {
    if (streamResult?.stream?.return) {
      await streamResult.stream.return(undefined);
    }
  });

  it(
    "streams multiple message updates for a prompt",
    async () => {
      const client = createOpencodeClient({ baseUrl });
      streamResult = await client.global.event();

      const session = await client.session.create({ directory: testDir });
      expect(session.data?.id).toBeTruthy();
      const sessionId = session.data!.id;

      const promptPromise = client.session.prompt({
        sessionID: sessionId,
        directory: testDir,
        model: { providerID: "openai", modelID: "gpt-5.2-codex" },
        parts: [{ type: "text", text: promptText }],
      });


      const updates: Array<unknown> = [];
      const deadline = Date.now() + 45_000;

      while (Date.now() < deadline && updates.length < 50) {
        const next = await streamResult.stream.next();
        if (next.done) break;

        const rawEvent = next.value as any;
        if (process.env.OPENCODE_EVENT_DUMP === "true") {
          console.log("opencode event", rawEvent);
        }

        const event = rawEvent?.payload ?? rawEvent;
        const part = event?.properties?.part;
        if (event?.type === "message.part.updated" && part?.sessionID === sessionId) {
          const details = {
            type: part?.type,
            status: part?.state?.status,
            tool: part?.tool,
            title: part?.state?.title,
            text: part?.text,
            input: part?.state?.input,
            sessionID: part?.sessionID,
          };
          console.log("opencode part", details);
          updates.push(event);
        }

        const status = statusFromEvent({
          directory: rawEvent?.directory,
          payload: rawEvent?.payload,
        } as ProgressEvent, sessionId);
        if (status) {
          console.log("formatted status", status);
        }

      }

      const promptResult = await promptPromise;
      const responseText = promptResult.data?.parts?.find((part) => part.type === "text")?.text;

      expect(responseText).toBeTruthy();
      expect(updates.length).toBeGreaterThanOrEqual(3);
    },
    60_000
  );
});
