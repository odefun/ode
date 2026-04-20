import type { Elysia } from "elysia";
import {
  createTask,
  deleteTask,
  cancelTask,
  getTaskById,
  listTaskChannelOptions,
  listTasks,
  updateTask,
  type CreateTaskParams,
  type UpdateTaskParams,
} from "@/config/local/tasks";
import {
  TaskAlreadyRunningError,
  TaskNotFoundError,
  TaskNotPendingError,
  beginTriggerTaskNow,
} from "@/core/tasks/scheduler";
import { log } from "@/utils";
import { jsonResponse, readJsonBody, runRoute } from "../http";

function getString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function getOptionalString(payload: Record<string, unknown>, key: string): string | null | undefined {
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

function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseCreateTaskPayload(payload: Record<string, unknown>): CreateTaskParams {
  const scheduledAt = getNumber(payload, "scheduledAt");
  if (scheduledAt === undefined) {
    throw new Error("scheduledAt is required");
  }
  const threadIdRaw = getOptionalString(payload, "threadId");
  const agentRaw = getOptionalString(payload, "agent");
  return {
    title: getString(payload, "title"),
    scheduledAt,
    channelId: getString(payload, "channelId"),
    threadId: threadIdRaw === undefined ? null : threadIdRaw,
    messageText: getString(payload, "messageText"),
    agent: agentRaw === undefined ? null : agentRaw,
  };
}

function parseUpdateTaskPayload(payload: Record<string, unknown>): UpdateTaskParams {
  const update: UpdateTaskParams = {};
  if ("title" in payload) update.title = getString(payload, "title");
  if ("scheduledAt" in payload) {
    const scheduledAt = getNumber(payload, "scheduledAt");
    if (scheduledAt !== undefined) update.scheduledAt = scheduledAt;
  }
  if ("channelId" in payload) update.channelId = getString(payload, "channelId");
  if ("threadId" in payload) update.threadId = getOptionalString(payload, "threadId") ?? null;
  if ("messageText" in payload) update.messageText = getString(payload, "messageText");
  if ("agent" in payload) update.agent = getOptionalString(payload, "agent") ?? null;
  return update;
}

export function registerTaskRoutes(app: Elysia): void {
  app.get("/api/tasks", async () => {
    return runRoute(
      async () => ({
        tasks: listTasks(),
        channels: listTaskChannelOptions(),
      }),
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Internal server error", status: 500 },
    );
  });

  app.get("/api/tasks/:id", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing task id");
        const task = getTaskById(id);
        if (!task) throw new Error("Task not found");
        return { task };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to load task",
        resolveStatus: (message) => {
          if (message === "Missing task id") return 400;
          if (message === "Task not found") return 404;
          return 500;
        },
      },
    );
  });

  app.post("/api/tasks", async ({ request }: { request: Request }) => {
    return runRoute(
      async () => {
        const body = await readJsonBody(request);
        const payload = parseCreateTaskPayload(body);
        const runImmediately = getBoolean(body, "runImmediately") === true;
        const task = createTask(payload);

        if (runImmediately) {
          try {
            const runPromise = beginTriggerTaskNow(task.id);
            runPromise.catch((error) => {
              log.warn("Immediate task run after create failed", {
                taskId: task.id,
                error: String(error),
              });
            });
          } catch (error) {
            log.warn("Unable to start immediate task run after create", {
              taskId: task.id,
              error: String(error),
            });
          }
        }

        return {
          task,
          tasks: listTasks(),
          channels: listTaskChannelOptions(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Invalid task payload", status: 400 },
    );
  });

  app.put("/api/tasks/:id", async ({ params, request }: { params: { id?: string }; request: Request }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing task id");
        const payload = parseUpdateTaskPayload(await readJsonBody(request));
        const task = updateTask(id, payload);
        return {
          task,
          tasks: listTasks(),
          channels: listTaskChannelOptions(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Invalid task payload",
        resolveStatus: (message) => {
          if (message === "Missing task id") return 400;
          if (message === "Task not found") return 404;
          if (message === "Only pending tasks can be updated") return 409;
          return 400;
        },
      },
    );
  });

  app.delete("/api/tasks/:id", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing task id");
        deleteTask(id);
        return {
          tasks: listTasks(),
          channels: listTaskChannelOptions(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to delete task",
        resolveStatus: (message) => (message === "Missing task id" ? 400 : 400),
      },
    );
  });

  app.post("/api/tasks/:id/cancel", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing task id");
        const existing = getTaskById(id);
        if (!existing) throw new Error("Task not found");
        const cancelled = cancelTask(id);
        if (!cancelled) {
          // Row is already terminal (cancelled / success / failed). Surface
          // the current status so the UI can show a sensible message. Note
          // that `running` is now cancellable alongside `pending`; this
          // branch is only for irrecoverable terminal states.
          throw new Error(`Task cannot be cancelled (status: ${existing.status})`);
        }
        return {
          task: getTaskById(id),
          tasks: listTasks(),
          channels: listTaskChannelOptions(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to cancel task",
        resolveStatus: (message) => {
          if (message === "Missing task id") return 400;
          if (message === "Task not found") return 404;
          if (message.startsWith("Task cannot be cancelled")) return 409;
          return 500;
        },
      },
    );
  });

  app.post("/api/tasks/:id/run", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) throw new Error("Missing task id");
        try {
          const runPromise = beginTriggerTaskNow(id);
          runPromise.catch((error) => {
            log.warn("Manually triggered task run failed", {
              taskId: id,
              error: String(error),
            });
          });
        } catch (error) {
          if (error instanceof TaskAlreadyRunningError) {
            throw new Error("Task already running");
          }
          if (error instanceof TaskNotFoundError) {
            throw new Error("Task not found");
          }
          if (error instanceof TaskNotPendingError) {
            throw new Error(error.message);
          }
          throw error;
        }
        return {
          tasks: listTasks(),
          channels: listTaskChannelOptions(),
        };
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Failed to run task",
        resolveStatus: (message) => {
          if (message === "Missing task id") return 400;
          if (message === "Task not found") return 404;
          if (message === "Task already running") return 409;
          if (message.startsWith("Task ") && message.includes("is not pending")) return 409;
          return 500;
        },
      },
    );
  });
}
