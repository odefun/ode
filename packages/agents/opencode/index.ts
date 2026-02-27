import {
  startServer,
  stopServer,
  isServerReady,
  createSessionInstance,
  getSessionClient,
  getAnyServerUrl,
  ensureSession,
  ensureValidSession,
  stopAllSessions,
  subscribeToSession,
  type EventHandler,
} from "./server";
import {
  createSession,
  getOrCreateSession,
  sendMessage,
  abortSession,
  cancelActiveRequest,
  statusFromEvent,
  type ProgressEvent,
} from "./client";

export const openCodeAgent = {
  startServer,
  stopServer,
  isServerReady,
  createSessionInstance,
  getSessionClient,
  getAnyServerUrl,
  ensureSession,
  ensureValidSession,
  stopAllSessions,
  subscribeToSession,
  createSession,
  getOrCreateSession,
  sendMessage,
  abortSession,
  cancelActiveRequest,
  statusFromEvent,
};

export {
  startServer,
  stopServer,
  isServerReady,
  createSessionInstance,
  getSessionClient,
  getAnyServerUrl,
  ensureSession,
  ensureValidSession,
  stopAllSessions,
  subscribeToSession,
  createSession,
  getOrCreateSession,
  sendMessage,
  abortSession,
  cancelActiveRequest,
  statusFromEvent,
  type EventHandler,
  type ProgressEvent,
};

export type {
  OpenCodeMessage,
  OpenCodeMessageContext,
  OpenCodeOptions,
  OpenCodeSessionInfo,
} from "../types";
