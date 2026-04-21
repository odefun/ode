import { Elysia } from "elysia";
import { serveStaticAsset } from "./static-assets";
import { registerConfigRoutes } from "./routes/config";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerLarkRoutes } from "./routes/lark";
import { registerAgentCheckRoutes } from "./routes/agent-check";
import { registerSessionRoutes } from "./routes/sessions";
import { registerInboxRoutes } from "./routes/inbox";
import { registerCronJobRoutes } from "./routes/cron-jobs";
import { registerTaskRoutes } from "./routes/tasks";
import { registerPrTrackerRoutes } from "./routes/pr-trackers";
import { registerSendRoutes } from "./routes/send";
import { registerMessagesRoutes } from "./routes/messages";
import { registerReactionsRoutes } from "./routes/reactions";

export function createWebApp(): Elysia {
  const app = new Elysia();

  app.get("/local-setting", () => new Response(null, {
    status: 307,
    headers: { location: "/" },
  }));

  app.get("/local-setting/*", ({ request }: { request: Request }) => {
    const pathname = new URL(request.url).pathname;
    const target = pathname.slice("/local-setting".length) || "/";
    return new Response(null, {
      status: 307,
      headers: { location: target },
    });
  });

  registerConfigRoutes(app);
  registerWorkspaceRoutes(app);
  registerLarkRoutes(app);
  registerAgentCheckRoutes(app);
  registerSessionRoutes(app);
  registerInboxRoutes(app);
  registerCronJobRoutes(app);
  registerTaskRoutes(app);
  registerPrTrackerRoutes(app);
  registerSendRoutes(app);
  registerMessagesRoutes(app);
  registerReactionsRoutes(app);

  app.all("*", async ({ request }: { request: Request }) => {
    return serveStaticAsset(request);
  });

  return app;
}
