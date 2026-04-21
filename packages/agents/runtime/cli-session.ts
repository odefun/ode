import { log } from "@/utils";
import type { AgentProviderId } from "@/shared/agent-provider";
import { getOrCreateThreadSession } from "./thread-session";
import type { OpenCodeSessionInfo } from "../types";
import type { SessionEnvironment } from "./base";

type CliSessionRuntime = {
  getSessionEnvironment: (sessionId: string) => SessionEnvironment;
  setSessionEnvironment: (sessionId: string, env: SessionEnvironment) => void;
};

/**
 * Minimal surface a "new session" tracker needs to expose. We accept either a
 * raw `Set<string>` or the bounded variant from `@/utils` — both satisfy this
 * contract — so agent clients can pick whichever they want without forcing a
 * circular dependency here.
 */
type NewSessionTracker = {
  add: (value: string) => unknown;
};

type CliThreadSessionManagerOptions = {
  providerId: AgentProviderId;
  providerName: string;
  runtime: CliSessionRuntime;
  newSessions?: NewSessionTracker;
  sessionIdFactory?: () => string;
  validateSessionId?: (sessionId: string) => boolean;
};

export function createCliThreadSessionManager(options: CliThreadSessionManagerOptions): {
  createSession: (workingPath: string, env?: SessionEnvironment) => Promise<string>;
  getOrCreateSession: (
    channelId: string,
    threadId: string,
    workingPath: string,
    env?: SessionEnvironment
  ) => Promise<OpenCodeSessionInfo>;
} {
  const {
    providerId,
    providerName,
    runtime,
    newSessions,
    sessionIdFactory = () => crypto.randomUUID(),
    validateSessionId,
  } = options;

  async function createSession(workingPath: string, env: SessionEnvironment = {}): Promise<string> {
    const sessionId = sessionIdFactory();
    runtime.setSessionEnvironment(sessionId, env);
    newSessions?.add(sessionId);
    log.info(`Created ${providerName} session`, { sessionId, workingPath });
    return sessionId;
  }

  async function getOrCreateSession(
    channelId: string,
    threadId: string,
    workingPath: string,
    env: SessionEnvironment = {}
  ): Promise<OpenCodeSessionInfo> {
    return getOrCreateThreadSession({
      channelId,
      threadId,
      providerId,
      workingPath,
      env,
      createSession,
      getSessionEnvironment: (sessionId) => runtime.getSessionEnvironment(sessionId),
      setSessionEnvironment: (sessionId, nextEnv) => {
        runtime.setSessionEnvironment(sessionId, nextEnv);
      },
      validateSessionId,
      onInvalidSessionId: (existingSession) => {
        log.info(`Invalid ${providerName} session id found; generating new session`, {
          channelId,
          threadId,
          workingPath,
          existingSession,
        });
      },
      onEnvironmentChanged: () => {
        log.info(`${providerName} session environment changed; creating new session`, {
          channelId,
          threadId,
          workingPath,
        });
      },
      onCreatingSession: () => {
        log.info(`Creating new ${providerName} session for thread`, { channelId, threadId, workingPath });
      },
    });
  }

  return {
    createSession,
    getOrCreateSession,
  };
}
