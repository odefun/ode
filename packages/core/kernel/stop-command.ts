import { failActiveRequest, loadSession } from "@/config/local/sessions";
import type { AgentAdapter, IMAdapter } from "@/core/types";
import { log } from "@/utils";

type StopCommandDeps = {
  agent: AgentAdapter;
  im: IMAdapter;
};

export async function handleStopCommand(params: {
  deps: StopCommandDeps;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  const { deps, channelId, threadId } = params;
  const session = loadSession(channelId, threadId);
  if (!session) {
    log.info("Stop command received without session", { channelId, threadId });
    return true;
  }

  const request = session.activeRequest;
  log.info("Stop command received", {
    sessionId: request?.sessionId ?? session.sessionId,
    hadActiveRequest: Boolean(request),
    activeState: request?.state ?? null,
  });

  try {
    const cwd = session.workingDirectory;
    await deps.agent.abortSession(session.sessionId, cwd);
  } catch (err) {
    // An abort failure means the agent may keep emitting events and burning
    // tokens while the user thinks the request is stopped. Surface it so we
    // can investigate, but don't fail the stop path — delete/clear below is
    // still the right thing.
    log.warn("Failed to abort agent session on stop", {
      sessionId: session.sessionId,
      channelId,
      threadId,
      error: String(err),
    });
  }

  if (!request || request.state !== "processing") {
    return true;
  }

  request.state = "failed";
  request.error = "Stopped by user";

  try {
    await deps.im.deleteMessage(request.channelId, request.statusMessageTs);
  } catch (err) {
    log.warn("Failed to delete status message on stop command", {
      channelId: request.channelId,
      threadId: request.threadId,
      statusTs: request.statusMessageTs,
      error: String(err),
    });
  }

  failActiveRequest(channelId, threadId, "Stopped by user");
  return true;
}
