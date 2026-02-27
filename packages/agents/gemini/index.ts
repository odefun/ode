import {
  createSession,
  getOrCreateSession,
  sendMessage,
  cancelActiveRequest,
  abortSession,
  ensureSession,
  subscribeToSession,
  startServer,
  stopServer,
  type SessionEnvironment,
} from "./client";

class GeminiMessageProcessor {
  createSession = createSession;
  getOrCreateSession = getOrCreateSession;
  sendMessage = sendMessage;
  cancelActiveRequest = cancelActiveRequest;
  abortSession = abortSession;
  ensureSession = ensureSession;
  subscribeToSession = subscribeToSession;
  startServer = startServer;
  stopServer = stopServer;
}

export const geminiAgent = new GeminiMessageProcessor();
export type { SessionEnvironment };
