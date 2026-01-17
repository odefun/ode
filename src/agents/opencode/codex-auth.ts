import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { log } from "../../logger";

// OAuth constants from OpenCode's codex plugin
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const OAUTH_PORT = 1455;

// XDG data directory for OpenCode
const XDG_DATA_HOME = process.env.XDG_DATA_HOME || join(process.env.HOME || "/root", ".local/share");
const OPENCODE_AUTH_PATH = join(XDG_DATA_HOME, "opencode", "auth.json");

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface OAuthCredentials {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
}

interface PendingOAuth {
  pkce: PkceCodes;
  state: string;
  channelId: string;
  resolve: (tokens: TokenResponse) => void;
  reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined;
let pendingOAuth: PendingOAuth | undefined;

// PKCE utilities
async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, pkce: PkceCodes): Promise<TokenResponse> {
  log.info("Exchanging code for tokens", { codeLength: code.length });

  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    log.error("Token exchange failed", { status: response.status, error });
    throw new Error(`Token exchange failed: ${response.status} - ${error}`);
  }

  const tokens = await response.json() as TokenResponse;
  log.info("Token exchange successful", { hasAccess: !!tokens.access_token, hasRefresh: !!tokens.refresh_token });
  return tokens;
}

// HTML responses
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Ode - Codex Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Slack.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Ode - Codex Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${error}</div>
  </div>
</body>
</html>`;

// Auth storage utilities
function readAuthFile(): Record<string, OAuthCredentials> {
  try {
    if (existsSync(OPENCODE_AUTH_PATH)) {
      const content = readFileSync(OPENCODE_AUTH_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    log.warn("Failed to read auth file", { error: String(err) });
  }
  return {};
}

function writeAuthFile(data: Record<string, OAuthCredentials>): void {
  try {
    const dir = dirname(OPENCODE_AUTH_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(OPENCODE_AUTH_PATH, JSON.stringify(data, null, 2));
    chmodSync(OPENCODE_AUTH_PATH, 0o600);
    log.info("Auth file written", { path: OPENCODE_AUTH_PATH });
  } catch (err) {
    log.error("Failed to write auth file", { error: String(err) });
    throw err;
  }
}

export function saveCodexCredentials(tokens: TokenResponse): void {
  const auth = readAuthFile();
  auth["openai"] = {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  writeAuthFile(auth);
  log.info("Codex credentials saved to OpenCode auth.json");
}

export function getCodexCredentials(): OAuthCredentials | null {
  const auth = readAuthFile();
  const openai = auth["openai"];
  if (openai && openai.type === "oauth") {
    return openai;
  }
  return null;
}

export function isCodexAuthenticated(): boolean {
  const creds = getCodexCredentials();
  if (!creds) return false;
  // Consider authenticated if we have a refresh token (even if access expired)
  return !!creds.refresh;
}

// OAuth server management
export async function startCodexOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` };
  }

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/auth/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        log.info("OAuth callback received", {
          hasCode: !!code,
          hasState: !!state,
          hasError: !!error,
          hasPending: !!pendingOAuth,
          stateMatch: pendingOAuth ? state === pendingOAuth.state : false
        });

        if (error) {
          const errorMsg = errorDescription || error;
          pendingOAuth?.reject(new Error(errorMsg));
          pendingOAuth = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code) {
          const errorMsg = "Missing authorization code";
          pendingOAuth?.reject(new Error(errorMsg));
          pendingOAuth = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!pendingOAuth || state !== pendingOAuth.state) {
          const errorMsg = "Invalid state - session expired or CSRF attempt";
          pendingOAuth?.reject(new Error(errorMsg));
          pendingOAuth = undefined;
          return new Response(HTML_ERROR(errorMsg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        const current = pendingOAuth;
        pendingOAuth = undefined;

        // Exchange code for tokens and save credentials
        exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
          .then((tokens) => {
            saveCodexCredentials(tokens);
            current.resolve(tokens);
          })
          .catch((err) => current.reject(err));

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname === "/cancel") {
        pendingOAuth?.reject(new Error("Login cancelled"));
        pendingOAuth = undefined;
        return new Response("Login cancelled", { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  log.info("Codex OAuth server started", { port: OAUTH_PORT });
  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` };
}

export function stopCodexOAuthServer(): void {
  if (oauthServer) {
    oauthServer.stop();
    oauthServer = undefined;
    log.info("Codex OAuth server stopped");
  }
}

export interface CodexAuthResult {
  url: string;
  state: string;
  channelId: string;
}

export async function initiateCodexAuth(channelId: string): Promise<CodexAuthResult> {
  const { redirectUri } = await startCodexOAuthServer();
  const pkce = await generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

  // Set up pending OAuth with timeout
  const timeout = setTimeout(() => {
    if (pendingOAuth && pendingOAuth.state === state) {
      pendingOAuth.reject(new Error("OAuth timeout - authorization took too long"));
      pendingOAuth = undefined;
    }
  }, 5 * 60 * 1000); // 5 minute timeout

  return new Promise<CodexAuthResult>((resolve) => {
    pendingOAuth = {
      pkce,
      state,
      channelId,
      resolve: () => {
        clearTimeout(timeout);
      },
      reject: (error) => {
        clearTimeout(timeout);
        log.error("OAuth failed", { error: error.message });
      },
    };

    log.info("Codex OAuth initiated", { channelId, state: state.substring(0, 8) + "..." });
    resolve({ url: authUrl, state, channelId });
  });
}

export function getPendingOAuth(): PendingOAuth | undefined {
  return pendingOAuth;
}

export function hasPendingOAuth(channelId: string): boolean {
  return pendingOAuth?.channelId === channelId;
}

// Manual callback handling (when user pastes the callback URL)
export async function completeCodexAuthManual(callbackUrl: string): Promise<void> {
  log.info("Processing manual OAuth callback", { urlLength: callbackUrl.length });

  if (!pendingOAuth) {
    throw new Error("No pending OAuth flow. Please start again with /ode oauth");
  }

  // Parse the callback URL
  let code: string;
  let state: string | null = null;

  if (callbackUrl.startsWith("http")) {
    try {
      const url = new URL(callbackUrl);
      code = url.searchParams.get("code") || "";
      state = url.searchParams.get("state");

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        throw new Error(errorDescription || error);
      }
    } catch (err) {
      if (err instanceof Error && err.message !== "No pending OAuth flow. Please start again with /ode oauth") {
        throw err;
      }
      // Not a valid URL, treat as code
      code = callbackUrl.trim();
    }
  } else {
    // Treat as code directly
    code = callbackUrl.trim();
  }

  if (!code) {
    throw new Error("Missing authorization code in callback URL");
  }

  // Validate state if present
  if (state && state !== pendingOAuth.state) {
    throw new Error("Invalid state - session may have expired. Please try again.");
  }

  log.info("Exchanging code for tokens", { codeLength: code.length, hasState: !!state });

  // Exchange code for tokens
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`;
  const tokens = await exchangeCodeForTokens(code, redirectUri, pendingOAuth.pkce);

  // Save credentials
  saveCodexCredentials(tokens);

  // Clear pending OAuth
  const current = pendingOAuth;
  pendingOAuth = undefined;
  current.resolve(tokens);

  log.info("Manual OAuth completed successfully");
}
