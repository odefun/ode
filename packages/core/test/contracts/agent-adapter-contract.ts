import { describe, expect, it } from "bun:test";
import type { AgentAdapter } from "@/core/types";

export function runAgentAdapterContractSuite(name: string, makeAdapter: () => AgentAdapter): void {
  describe(`AgentAdapter contract: ${name}`, () => {
    it("exposes required functions", () => {
      const adapter = makeAdapter();
      expect(typeof adapter.enqueueMessage).toBe("function");
      expect(typeof adapter.getOrCreateSession).toBe("function");
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.abortSession).toBe("function");
      expect(typeof adapter.ensureSession).toBe("function");
      expect(typeof adapter.subscribeToSession).toBe("function");
      expect(typeof adapter.replyToQuestion).toBe("function");
      expect(typeof adapter.normalizeQuestions).toBe("function");
      expect(typeof adapter.supportsEventStream).toBe("boolean");
    });

    it("returns a usable session and response payload shape", async () => {
      const adapter = makeAdapter();
      const session = await adapter.getOrCreateSession("C1", "T1", "/tmp", {});
      expect(typeof session.sessionId).toBe("string");
      expect(session.sessionId.length).toBeGreaterThan(0);

      const responses = await adapter.sendMessage("C1", session.sessionId, "hello", "/tmp");
      expect(Array.isArray(responses)).toBe(true);
      if (responses[0]) {
        expect(typeof responses[0].text).toBe("string");
      }
    });
  });
}
