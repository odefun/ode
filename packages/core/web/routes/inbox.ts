import type { Elysia } from "elysia";
import {
  getMessageThreadById,
  getMessageThreadDetailPage,
  getMessageThreadPage,
  getMessageThreadSummaryById,
  getOdeRunEventPage,
} from "@/config/local/inbox";
import { jsonResponse, parsePositiveInt, runRoute } from "../http";

export function registerInboxRoutes(app: Elysia): void {
  // Thread list — each item is a conversation with aggregate counters.
  app.get("/api/message-threads", async ({ query }: { query: Record<string, string | undefined> }) => {
    return runRoute(
      async () => {
        const page = parsePositiveInt(typeof query.page === "string" ? query.page : null, 1);
        const pageSize = parsePositiveInt(typeof query.pageSize === "string" ? query.pageSize : null, 20, 100);
        return getMessageThreadPage({ page, pageSize });
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Internal server error", status: 500 }
    );
  });

  // Thread detail — by default returns the thread row plus ALL details
  // (kept for backwards-compat with any direct consumers). Use the
  // `/details` endpoint below for a paginated view.
  app.get("/api/message-threads/:id", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) {
          throw new Error("Missing thread id");
        }
        const thread = getMessageThreadById(id);
        if (!thread) {
          throw new Error("Thread not found");
        }
        return thread;
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Internal server error",
        resolveStatus: (message) => {
          if (message === "Missing thread id") return 400;
          if (message === "Thread not found") return 404;
          return 500;
        },
      }
    );
  });

  // Thread summary only — used by the timeline page to render header
  // metadata without pulling every detail up front.
  app.get("/api/message-threads/:id/summary", async ({ params }: { params: { id?: string } }) => {
    return runRoute(
      async () => {
        const id = params.id?.trim();
        if (!id) {
          throw new Error("Missing thread id");
        }
        const summary = getMessageThreadSummaryById(id);
        if (!summary) {
          throw new Error("Thread not found");
        }
        return summary;
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Internal server error",
        resolveStatus: (message) => {
          if (message === "Missing thread id") return 400;
          if (message === "Thread not found") return 404;
          return 500;
        },
      }
    );
  });

  app.get(
    "/api/message-threads/:id/events",
    async ({
      params,
      query,
    }: {
      params: { id?: string };
      query: Record<string, string | undefined>;
    }) => {
      return runRoute(
        async () => {
          const id = params.id?.trim();
          if (!id) throw new Error("Missing thread id");
          const limit = parsePositiveInt(
            typeof query.limit === "string" ? query.limit : null,
            100,
            500,
          );
          const result = getOdeRunEventPage(id, {
            limit,
            includeRaw: query.includeRaw === "true",
          });
          if (!result) throw new Error("Thread not found");
          return result;
        },
        (result) => jsonResponse(200, { ok: true, result }),
        {
          fallbackMessage: "Internal server error",
          resolveStatus: (message) => {
            if (message === "Missing thread id") return 400;
            if (message === "Thread not found") return 404;
            return 500;
          },
        }
      );
    }
  );

  // Paginated details for a given thread (default 10 per page).
  app.get(
    "/api/message-threads/:id/details",
    async ({
      params,
      query,
    }: {
      params: { id?: string };
      query: Record<string, string | undefined>;
    }) => {
      return runRoute(
        async () => {
          const id = params.id?.trim();
          if (!id) {
            throw new Error("Missing thread id");
          }
          const page = parsePositiveInt(typeof query.page === "string" ? query.page : null, 1);
          const pageSize = parsePositiveInt(
            typeof query.pageSize === "string" ? query.pageSize : null,
            10,
            100,
          );
          const result = getMessageThreadDetailPage(id, { page, pageSize });
          if (!result) {
            throw new Error("Thread not found");
          }
          return result;
        },
        (result) => jsonResponse(200, { ok: true, result }),
        {
          fallbackMessage: "Internal server error",
          resolveStatus: (message) => {
            if (message === "Missing thread id") return 400;
            if (message === "Thread not found") return 404;
            return 500;
          },
        }
      );
    }
  );
}
