// OAuth sign-in and refresh tests. No network: HttpFn is a fake stub; the loopback
// callback server is real (node:http) and openUrl performs a real GET to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signIn, refreshTokens, REDIRECT_PORT } from "../src/auth.ts";
import type { HttpRequest, HttpResponse, TkTokens } from "../src/types.ts";

function formParams(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? "");
}

/** Fake HttpFn: handles /oauth/register and /oauth/token, records everything. */
function makeFakeHttp() {
  const requests: HttpRequest[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (req.url.endsWith("/oauth/register")) {
      return { status: 200, headers: {}, text: JSON.stringify({ client_id: "client-abc" }) };
    }
    if (req.url.endsWith("/oauth/token")) {
      const params = formParams(req.body);
      if (params.get("grant_type") === "refresh_token") {
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ access_token: "access-new", expires_in: 3600 }),
        };
      }
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
      };
    }
    throw new Error("unexpected request " + req.url);
  };
  return { http, requests };
}

test("signIn completes a full PKCE round trip via the loopback server", async () => {
  const { http, requests } = makeFakeHttp();
  let capturedState = "";
  let capturedChallenge = "";
  const openUrl = (url: string) => {
    const parsed = new URL(url);
    capturedState = parsed.searchParams.get("state") ?? "";
    capturedChallenge = parsed.searchParams.get("code_challenge") ?? "";
    assert.equal(parsed.searchParams.get("client_id"), "client-abc");
    assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
    // Simulate the browser: a stray favicon probe first (must be ignored), then the real redirect.
    void fetch(`http://127.0.0.1:${REDIRECT_PORT}/favicon.ico`).then(() =>
      fetch(`http://127.0.0.1:${REDIRECT_PORT}/callback?code=auth-code-1&state=${capturedState}`),
    );
  };

  const tokens = await signIn(http, openUrl, { timeoutMs: 5000 });

  assert.equal(tokens.client_id, "client-abc");
  assert.equal(tokens.access_token, "access-1");
  assert.equal(tokens.refresh_token, "refresh-1");
  assert.ok(tokens.expires_at > Date.now());

  const tokenReq = requests.find((r) => r.url.endsWith("/oauth/token"));
  assert.ok(tokenReq);
  const params = formParams(tokenReq!.body);
  assert.equal(params.get("code"), "auth-code-1");
  assert.equal(params.get("redirect_uri"), `http://127.0.0.1:${REDIRECT_PORT}/callback`);

  // PKCE challenge = base64url(sha256(verifier)): recompute it and check it matches
  // what signIn sent in the authorize URL.
  const verifier = params.get("code_verifier")!;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const expectedChallenge = Buffer.from(digest).toString("base64url");
  assert.equal(capturedChallenge, expectedChallenge);
});

test("signIn rejects and frees the port on a state mismatch", async () => {
  const { http } = makeFakeHttp();
  const openUrl = (url: string) => {
    const parsed = new URL(url);
    void parsed;
    void fetch(`http://127.0.0.1:${REDIRECT_PORT}/callback?code=auth-code-1&state=wrong-state`);
  };

  await assert.rejects(() => signIn(http, openUrl, { timeoutMs: 5000 }), /state mismatch/);

  // Port must be free again: a second sign-in attempt can bind it.
  const openUrl2 = (url: string) => {
    const parsed = new URL(url);
    const state = parsed.searchParams.get("state") ?? "";
    void fetch(`http://127.0.0.1:${REDIRECT_PORT}/callback?code=auth-code-2&state=${state}`);
  };
  const tokens = await signIn(http, openUrl2, { timeoutMs: 5000 });
  assert.equal(tokens.access_token, "access-1");
});

test("refreshTokens keeps the old refresh_token when none is returned", async () => {
  const { http } = makeFakeHttp();
  const oldTokens: TkTokens = {
    client_id: "client-abc",
    access_token: "access-stale",
    refresh_token: "refresh-keep-me",
    expires_at: Date.now() - 1000,
  };
  const refreshed = await refreshTokens(http, oldTokens);
  assert.equal(refreshed.access_token, "access-new");
  assert.equal(refreshed.refresh_token, "refresh-keep-me");
  assert.ok(refreshed.expires_at > Date.now());
});
