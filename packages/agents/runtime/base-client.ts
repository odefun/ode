import { CliAgentRuntime, runCliJsonCommand, type SessionEnvironment } from "./base";
import type { AgentInput, OpenCodeMessage, OpenCodeMessageContext, OpenCodeOptions } from "../types";
import { log } from "@/utils";

export abstract class AgentBaseClient<TRecord> {
  protected abstract readonly runtime: CliAgentRuntime;
  protected abstract readonly providerName: string;
  protected abstract readonly binary: string;

  constructor() {}

  protected async runCliCommand(
    sessionId: string,
    args: string[],
    cwd: string,
    env: SessionEnvironment,
    onRecord: (record: TRecord) => void,
    timeoutMs?: number
  ): Promise<string> {
    const sessionKey = `generic:${sessionId}`; // Simplification
    const entry = this.runtime.beginRequest(sessionKey);
    try {
      return await this.runtime.withSessionLock(sessionKey, async () => {
        return await runCliJsonCommand<TRecord>({
          providerName: this.providerName,
          binary: this.binary,
          args,
          cwd,
          env,
          entry,
          onRecord,
          timeoutMs,
        });
      });
    } finally {
      this.runtime.endRequest(sessionKey);
    }
  }

  /**
   * Build the arguments for the CLI command.
   */
  protected abstract buildCommandArgs(params: {
    sessionId: string;
    isNewSession: boolean;
    prompt: string;
    options?: OpenCodeOptions;
    context?: OpenCodeMessageContext;
  }): string[];

  /**
   * Parse the output from the CLI command.
   */
  protected abstract parseOutput(output: string): {
    text: string;
    sessionId?: string;
  };

  /**
   * Handle stream-json records.
   */
  protected abstract handleRecord(record: TRecord, sessionId: string): void;

  /**
   * Determine if an error is transient and should be retried.
   */
  protected abstract isTransientError(error: unknown): boolean;

  /**
   * Send a message to the agent and handle the turn.
   */
  abstract sendMessage(
    channelId: string,
    sessionId: string,
    input: AgentInput,
    workingPath: string,
    options?: OpenCodeOptions,
    context?: OpenCodeMessageContext
  ): Promise<OpenCodeMessage[]>;
}
