import type { Elysia } from "elysia";
import {
  deletePrTracker,
  getPrTrackerById,
  getPrTrackerSettings,
  listPrTrackerEvents,
  listPrTrackers,
  scanPrTrackers,
  updatePrTracker,
  updatePrTrackerSettings,
  type UpdatePrTrackerParams,
  type UpdatePrTrackerSettingsParams,
} from "@/config/local/pr-trackers";
import { listTaskChannelOptions } from "@/config/local/tasks";
import { triggerPrTrackerNow } from "@/core/pr-tracker/scheduler";
import { log } from "@/utils";
import { jsonResponse, readJsonBody, runRoute } from "../http";

// ---------------------------------------------------------------------------
// PR Tracker HTTP API.
//
// Follows the same pattern as /api/tasks and /api/cron-jobs: flat JSON,
// `{ ok, result }` envelopes via jsonResponse, and a companion CLI that talks
// to these routes so storage mutations stay centralized.
//
// Mutations are intentionally narrow:
//   - `POST /api/pr-trackers/scan` rescans the workspace → derives rows.
//   - `PUT /api/pr-trackers/:id` updates per-tracker config (enable, token,
//     prompt, interval, agent, target channel).
//   - `DELETE /api/pr-trackers/:id` hard-deletes a row + its event log.
//   - `POST /api/pr-trackers/:id/run` manually polls one tracker.
// Settings live under /api/pr-trackers/settings.
// ---------------------------------------------------------------------------

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function getOptionalString(
  payload: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function getNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getOptionalNumber(
  payload: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (value === null) return null;
  return getNumber(payload, key);
}

function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseTrackerUpdate(payload: Record<string, unknown>): UpdatePrTrackerParams {
  const update: UpdatePrTrackerParams = {};
  const enabled = getBoolean(payload, "enabled");
  if (enabled !== undefined) update.enabled = enabled;
  if ("agentProvider" in payload) {
    const raw = getOptionalString(payload, "agentProvider");
    update.agentProvider = raw === undefined ? null : raw;
  }
  if ("promptTemplate" in payload) {
    const raw = getOptionalString(payload, "promptTemplate");
    update.promptTemplate = raw === undefined ? null : raw;
  }
  if ("pollIntervalSec" in payload) {
    const raw = getOptionalNumber(payload, "pollIntervalSec");
    update.pollIntervalSec = raw === undefined ? null : raw;
  }
  if ("githubToken" in payload) {
    const raw = getOptionalString(payload, "githubToken");
    update.githubToken = raw === undefined ? null : raw;
  }
  if ("targetChannelId" in payload) {
    const raw = getOptionalString(payload, "targetChannelId");
    update.targetChannelId = raw === undefined ? null : raw;
  }
  return update;
}

function parseSettingsUpdate(
  payload: Record<string, unknown>,
): UpdatePrTrackerSettingsParams {
  const update: UpdatePrTrackerSettingsParams = {};
  const interval = getNumber(payload, "defaultPollIntervalSec");
  if (interval !== undefined) update.defaultPollIntervalSec = interval;
  const agent = getOptionalString(payload, "defaultAgentProvider");
  if (agent !== undefined) update.defaultAgentProvider = agent ?? "";
  const prompt = getOptionalString(payload, "defaultPromptTemplate");
  if (prompt !== undefined) update.defaultPromptTemplate = prompt ?? "";
  const token = getOptionalString(payload, "defaultGithubToken");
  if (token !== undefined) update.defaultGithubToken = token ?? "";
  return update;
}

function buildListPayload() {
  return {
    trackers: listPrTrackers(),
    channels: listTaskChannelOptions(),
    settings: getPrTrackerSettings(),
  };
}

export function registerPrTrackerRoutes(app: Elysia): void {
  app.get("/api/pr-trackers", async () => {
    return runRoute(
      async () => buildListPayload(),
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Failed to load PR trackers", status: 500 },
    );
  });

  app.get("/api/pr-trackers/:id", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing tracker id");
        const tracker = getPrTrackerById(id);
        if (!tracker) throw new Error("Tracker not found");
        return {
          tracker,
          events: listPrTrackerEvents(id, 100),
          channels: listTaskChannelOptions(),
          settings: getPrTrackerSettings(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to load tracker",
        resolveStatus: (message) => {
          if (message === "Missing tracker id") return 400;
          if (message === "Tracker not found") return 404;
          return 500;
        },
      },
    );
  });

  app.post("/api/pr-trackers/scan", async () => {
    return runRoute(
      async () => {
        const result = scanPrTrackers();
        return { scan: result, ...buildListPayload() };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Scan failed", status: 500 },
    );
  });

  app.put("/api/pr-trackers/:id", async ({ params, request }: { params: { id?: string }; request: Request }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing tracker id");
        const body = await readJsonBody(request);
        const update = parseTrackerUpdate(body);
        const tracker = updatePrTracker(id, update);
        return { tracker, ...buildListPayload() };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to update tracker",
        resolveStatus: (message) => {
          if (message === "Missing tracker id") return 400;
          if (message === "PR tracker not found") return 404;
          if (message.includes("target channel")) return 400;
          if (message.includes("missing")) return 409;
          return 400;
        },
      },
    );
  });

  app.delete("/api/pr-trackers/:id", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing tracker id");
        deletePrTracker(id);
        return buildListPayload();
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Failed to delete tracker", status: 400 },
    );
  });

  app.post("/api/pr-trackers/:id/run", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing tracker id");
        // Fire-and-forget; callers poll /api/pr-trackers/:id to see the
        // updated `last_polled_at` / `last_error` state.
        triggerPrTrackerNow(id)
          .then((outcome) => {
            log.info("Manually triggered PR tracker poll", outcome);
          })
          .catch((error) => {
            log.warn("Manually triggered PR tracker poll failed", {
              trackerId: id,
              error: String(error),
            });
          });
        return buildListPayload();
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to run tracker",
        resolveStatus: (message) => (message === "Missing tracker id" ? 400 : 500),
      },
    );
  });

  app.get("/api/pr-trackers/settings", async () => {
    return runRoute(
      async () => ({ settings: getPrTrackerSettings() }),
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Failed to load settings", status: 500 },
    );
  });

  app.put("/api/pr-trackers/settings", async ({ request }: { request: Request }) => {
    return runRoute(
      async () => {
        const body = await readJsonBody(request);
        const update = parseSettingsUpdate(body);
        const settings = updatePrTrackerSettings(update);
        return { settings };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Failed to update settings", status: 400 },
    );
  });
}
