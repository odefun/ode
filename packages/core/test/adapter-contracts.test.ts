import type { AgentAdapter, IMAdapter } from "@/core/types";
import { runAgentAdapterContractSuite } from "./contracts/agent-adapter-contract";
import { runImAdapterContractSuite } from "./contracts/im-adapter-contract";

function makeFakeAgentAdapter(): AgentAdapter {
  return {
    supportsEventStream: false,
    enqueueMessage: (context, text, process) => {
      void process(context, text);
    },
    getProviderForSession: () => "opencode",
    getDisplayNameForSession: () => "OpenCode",
    getOrCreateSession: async () => ({ sessionId: "s1", created: true }),
    sendMessage: async () => [{ text: "ok", messageType: "assistant" }],
    abortSession: async () => {},
    ensureSession: async () => {},
    subscribeToSession: () => () => {},
    replyToQuestion: async () => {},
    normalizeQuestions: () => [],
  };
}

function makeFakeImAdapter(): IMAdapter {
  return {
    sendMessage: async () => "100.2",
    updateMessage: async () => {},
    deleteMessage: async () => {},
    fetchThreadHistory: async () => null,
    buildAgentContext: async () => ({}),
  };
}

runAgentAdapterContractSuite("fake", makeFakeAgentAdapter);
runImAdapterContractSuite("fake", makeFakeImAdapter);
