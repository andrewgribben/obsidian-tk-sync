// OAuth 2.1 + PKCE sign-in and token refresh for TK's MCP server.
// No 'obsidian' import: HTTP goes through the injected HttpFn (Obsidian's requestUrl
// in the plugin, fetch in tests/scripts); the loopback callback server uses node:http,
// available in Obsidian desktop's renderer.
import { createServer } from "node:http";
import type { HttpFn, TkTokens } from "./types.ts";

const BASE = "https://tk.xyz";
const MCP_URL = BASE + "/mcp";
export const REDIRECT_PORT = 53682;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const USER_AGENT = "obsidian-tk-sync/0.1";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

interface RegisteredClient {
  client_id: string;
}

async function registerClient(http: HttpFn): Promise<RegisteredClient> {
  const res = await http({
    url: BASE + "/oauth/register",
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      client_name: "obsidian-tk-sync",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`TK client registration failed (${res.status}): ${res.text}`);
  }
  return JSON.parse(res.text) as RegisteredClient;
}

function formBody(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function exchangeCode(
  http: HttpFn,
  clientId: string,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const res = await http({
    url: BASE + "/oauth/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_URL,
    }),
  });
  if (res.status !== 200) throw new Error(`TK token exchange failed (${res.status}): ${res.text}`);
  return JSON.parse(res.text) as TokenResponse;
}

/** Starts the one-shot loopback callback server. Resolves with a function that waits for
 * the single GET callback (so the caller can open the browser only once bound). */
function startCallbackServer(timeoutMs: number): Promise<() => Promise<URLSearchParams>> {
  return new Promise((resolveStart, rejectStart) => {
    let started = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      // Browsers also probe e.g. /favicon.ico; only the real callback may end the sign-in.
      if (url.pathname !== "/callback") {
        res.writeHead(404, { Connection: "close" });
        res.end();
        return;
      }
      const query = url.searchParams;
      res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
      res.end("Signed in to TK, you can close this tab");
      clearTimeout(timer);
      server.close();
      onCallback?.(query);
    });
    let onCallback: ((q: URLSearchParams) => void) | null = null;
    const timer = setTimeout(() => {
      server.close();
      onTimeout?.();
    }, timeoutMs);
    let onTimeout: (() => void) | null = null;

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (started) return;
      clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        rejectStart(new Error(`Port ${REDIRECT_PORT} is already in use; close whatever is using it and retry`));
      } else {
        rejectStart(err);
      }
    });
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      started = true;
      resolveStart(
        () =>
          new Promise<URLSearchParams>((resolve, reject) => {
            onCallback = resolve;
            onTimeout = () => reject(new Error("Timed out waiting for TK sign-in callback"));
          }),
      );
    });
  });
}

/** Full OAuth PKCE sign-in: register, open the browser, catch the loopback callback, exchange the code. */
export async function signIn(
  http: HttpFn,
  openUrl: (url: string) => void,
  opts?: { timeoutMs?: number },
): Promise<TkTokens> {
  const timeoutMs = opts?.timeoutMs ?? 5 * 60 * 1000;
  const { client_id } = await registerClient(http);
  const verifier = randomToken(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomToken(16);

  const authorizeUrl =
    BASE +
    "/oauth/authorize?" +
    formBody({
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT_URI,
      scope: "read write",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: MCP_URL,
    });

  const waitForCallback = await startCallbackServer(timeoutMs);
  openUrl(authorizeUrl);

  let query: URLSearchParams;
  try {
    query = await waitForCallback();
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (query.get("state") !== state) {
    throw new Error("TK sign-in failed: state mismatch (possible CSRF or stale callback)");
  }
  const error = query.get("error");
  if (error) throw new Error(`TK sign-in was denied: ${error}`);
  const code = query.get("code");
  if (!code) throw new Error("TK sign-in callback had no authorization code");

  const token = await exchangeCode(http, client_id, code, verifier);
  return {
    client_id,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? "",
    expires_at: Date.now() + token.expires_in * 1000,
  };
}

/** Exchanges the refresh token for a new access token, keeping the old refresh token if none is returned. */
export async function refreshTokens(http: HttpFn, tokens: TkTokens): Promise<TkTokens> {
  const res = await http({
    url: BASE + "/oauth/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: tokens.client_id,
      resource: MCP_URL,
    }),
  });
  if (res.status !== 200) throw new Error(`TK token refresh failed (${res.status}): ${res.text}`);
  const token = JSON.parse(res.text) as TokenResponse;
  return {
    client_id: tokens.client_id,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + token.expires_in * 1000,
  };
}
