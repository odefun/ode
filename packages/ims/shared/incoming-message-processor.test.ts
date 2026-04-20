import { describe, expect, it } from "bun:test";
import {
  formatIncomingDropMessage,
  parseIncomingCommand,
} from "./incoming-message-processor";

describe("incoming message flow helpers", () => {
  it("parses command variants", () => {
    expect(parseIncomingCommand("<@U123> settings")).toBe("setting");
    expect(parseIncomingCommand("@ode: setting")).toBe("setting");
    expect(parseIncomingCommand("／settings")).toBe("setting");
    expect(parseIncomingCommand("help")).toBeNull();
  });

  it("parses stats command variants", () => {
    expect(parseIncomingCommand("<@U123> stats")).toBe("stats");
    expect(parseIncomingCommand("@ode: stats")).toBe("stats");
    expect(parseIncomingCommand("／stats")).toBe("stats");
    expect(parseIncomingCommand("/stats")).toBe("stats");
    expect(parseIncomingCommand("<@U123> debug stats")).toBe("stats");
    expect(parseIncomingCommand("stats")).toBe("stats");
    expect(parseIncomingCommand("statsy")).toBeNull();
  });

  it("parses cron command variants", () => {
    expect(parseIncomingCommand("<@U123> /cron")).toBe("cron");
    expect(parseIncomingCommand("@ode: cron")).toBe("cron");
    expect(parseIncomingCommand("／cron")).toBe("cron");
    expect(parseIncomingCommand("/cron")).toBe("cron");
    expect(parseIncomingCommand("crons")).toBe("cron");
    expect(parseIncomingCommand("cronjob")).toBeNull();
  });

  it("formats drop reason messages", () => {
    expect(formatIncomingDropMessage("not_mentioned_and_inactive")).toContain("Not mentioned");
    expect(formatIncomingDropMessage("self_message")).toContain("Self message");
    expect(formatIncomingDropMessage("not_thread_owner")).toContain("owner");
    expect(formatIncomingDropMessage("empty_text")).toContain("Empty text");
  });
});
