import type { Elysia } from "elysia";
import {
  getComputerSetupStatus,
  openComputerPermissionSettings,
  requestComputerPermissions,
  runComputerSelfTest,
  setupComputerGateway,
} from "@/computer";
import { jsonResponse, readJsonBody, runRoute } from "../http";

type RequestServer = {
  requestIP?: (request: Request) => { address?: string } | null;
};

function assertLocalRequest(request: Request, server?: RequestServer | null): void {
  const address = server?.requestIP?.(request)?.address;
  // `app.handle()` in unit tests has no backing socket. A real listener always
  // supplies requestIP, and remote dashboard clients must never trigger local
  // installs, TCC prompts, or input self-tests.
  if (!address) return;
  if (address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address === "::ffff:127.0.0.1") return;
  throw new Error("Computer setup is available from localhost only");
}

export function registerComputerRoutes(app: Elysia): void {
  app.get("/api/computer", async ({ request, server }: { request: Request; server: RequestServer | null }) => {
    return runRoute(
      async () => {
        assertLocalRequest(request, server);
        return await getComputerSetupStatus();
      },
      (result) => jsonResponse(200, { ok: true, result }),
      { fallbackMessage: "Failed to inspect Computer Gateway" },
    );
  });

  app.post("/api/computer", async ({ request, server }: { request: Request; server: RequestServer | null }) => {
    return runRoute(
      async () => {
        assertLocalRequest(request, server);
        const body = await readJsonBody(request);
        const action = typeof body.action === "string" ? body.action : "";
        if (action === "setup") {
          return await setupComputerGateway({
            browser: body.browser !== false,
            desktop: body.desktop !== false,
            requestPermissions: body.requestPermissions !== false,
            reinstallApp: body.reinstallApp === true,
          });
        }
        if (action === "request-permissions") {
          return await requestComputerPermissions();
        }
        if (action === "open-settings") {
          const kind = body.kind;
          if (kind !== "screen-recording" && kind !== "accessibility") {
            throw new Error("kind must be screen-recording or accessibility");
          }
          await openComputerPermissionSettings(kind);
          return { opened: kind };
        }
        if (action === "self-test") {
          return await runComputerSelfTest();
        }
        if (action === "status") {
          return await getComputerSetupStatus();
        }
        throw new Error("Unknown Computer Gateway action");
      },
      (result) => jsonResponse(200, { ok: true, result }),
      {
        fallbackMessage: "Computer Gateway action failed",
        resolveStatus: (message) => {
          if (message === "Computer setup is available from localhost only") return 403;
          return message.includes("must be") || message.startsWith("Unknown") ? 400 : 500;
        },
      },
    );
  });
}
