import { afterEach, describe, expect, it } from "bun:test";
import { getAgentProvider, getSelectedAgentProviderId } from "../registry";
import { providerSupportsModelSelection } from "@/shared/agent-provider";

describe("agent registry", () => {
  const original = process.env.ODE_AGENT_PROVIDER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ODE_AGENT_PROVIDER;
    } else {
      process.env.ODE_AGENT_PROVIDER = original;
    }
  });

  it("defaults to opencode", () => {
    delete process.env.ODE_AGENT_PROVIDER;
    expect(getSelectedAgentProviderId()).toBe("opencode");
  });

  it("selects claudecode from env", () => {
    process.env.ODE_AGENT_PROVIDER = "claude";
    expect(getSelectedAgentProviderId()).toBe("claudecode");
  });

  it("selects kimi from env", () => {
    process.env.ODE_AGENT_PROVIDER = "kimi";
    expect(getSelectedAgentProviderId()).toBe("kimi");
  });

  it("selects kilo from env", () => {
    process.env.ODE_AGENT_PROVIDER = "kilo";
    expect(getSelectedAgentProviderId()).toBe("kilo");
  });

  it("selects qwen from env", () => {
    process.env.ODE_AGENT_PROVIDER = "qwen";
    expect(getSelectedAgentProviderId()).toBe("qwen");
  });

  it("selects goose from env", () => {
    process.env.ODE_AGENT_PROVIDER = "goose";
    expect(getSelectedAgentProviderId()).toBe("goose");
  });

  for (const provider of ["pi", "openhands", "codebuddy", "crush"] as const) {
    it(`selects ${provider} from env`, () => {
      process.env.ODE_AGENT_PROVIDER = provider;
      expect(getSelectedAgentProviderId()).toBe(provider);
    });
  }

  it("returns provider metadata", () => {
    const opencode = getAgentProvider("opencode");
    const claudecode = getAgentProvider("claudecode");
    const kimi = getAgentProvider("kimi");
    const kilo = getAgentProvider("kilo");
    const qwen = getAgentProvider("qwen");
    const goose = getAgentProvider("goose");
    const pi = getAgentProvider("pi");
    const openhands = getAgentProvider("openhands");
    const codebuddy = getAgentProvider("codebuddy");
    const crush = getAgentProvider("crush");
    expect(opencode.supportsEventStream).toBe(true);
    expect(claudecode.supportsEventStream).toBe(false);
    expect(kimi.supportsEventStream).toBe(false);
    expect(kilo.supportsEventStream).toBe(false);
    expect(qwen.supportsEventStream).toBe(false);
    expect(goose.supportsEventStream).toBe(false);
    expect(pi.supportsEventStream).toBe(false);
    expect(openhands.supportsEventStream).toBe(false);
    expect(codebuddy.supportsEventStream).toBe(false);
    expect(crush.supportsEventStream).toBe(false);
    expect(providerSupportsModelSelection("pi")).toBe(true);
    expect(providerSupportsModelSelection("openhands")).toBe(true);
    expect(providerSupportsModelSelection("codebuddy")).toBe(true);
    expect(providerSupportsModelSelection("crush")).toBe(true);
  });
});
