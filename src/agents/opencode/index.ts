export {
  startServer,
  stopServer,
  isServerReady,
  createSessionInstance,
  getSessionClient,
  getAnyClient,
  getAnyServerUrl,
  ensureSession,
  ensureValidSession,
  touchSession,
  stopAllSessions,
  subscribeToSession,
  type EventHandler,
} from "./server";

export {
  createSession,
  getOrCreateSession,
  sendMessage,
  watchSessionProgress,
  abortSession,
  cancelActiveRequest,
  statusFromEvent,
  type ProgressEvent,
} from "./client";

export type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeProgressHandler,
  OpenCodeSessionInfo,
} from "../types";
