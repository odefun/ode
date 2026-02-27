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

class KimiMessageProcessor {
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

export const kimiAgent = new KimiMessageProcessor();
export type { SessionEnvironment };
