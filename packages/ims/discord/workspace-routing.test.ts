import { describe, expect, it } from "bun:test";
import { DISCORD_WORKSPACE_NOT_CONFIGURED_CODE } from "@/shared/delivery/permanent-error";
import { requireDiscordWorkspaceClient } from "./workspace-routing";

describe("Discord workspace routing", () => {
  it("selects only the client belonging to the cron workspace", () => {
    const owner = { id: "owner" };
    const unrelated = { id: "unrelated" };
    const selected = requireDiscordWorkspaceClient({
      workspaceId: "workspace-owner",
      configuredWorkspaceIds: ["workspace-owner", "workspace-other"],
      connectedClients: new Map([
        ["workspace-other", unrelated],
        ["workspace-owner", owner],
      ]),
    });

    expect(selected).toBe(owner);
  });

  it("keeps a configured workspace retryable while its client reconnects", () => {
    expect(() => requireDiscordWorkspaceClient({
      workspaceId: "workspace-owner",
      configuredWorkspaceIds: ["workspace-owner"],
      connectedClients: new Map(),
    })).toThrow("temporarily unavailable");

    try {
      requireDiscordWorkspaceClient({
        workspaceId: "workspace-owner",
        configuredWorkspaceIds: ["workspace-owner"],
        connectedClients: new Map(),
      });
    } catch (error) {
      expect((error as { code?: unknown }).code).toBeUndefined();
    }
  });

  it("marks a removed workspace as permanently unconfigured", () => {
    try {
      requireDiscordWorkspaceClient({
        workspaceId: "workspace-owner",
        configuredWorkspaceIds: ["workspace-other"],
        connectedClients: new Map(),
      });
      throw new Error("Expected workspace resolution to fail");
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe(DISCORD_WORKSPACE_NOT_CONFIGURED_CODE);
    }
  });
});
