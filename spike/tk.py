"""Throwaway spike: minimal TK MCP client (OAuth PKCE loopback + JSON-RPC over Streamable HTTP).

Usage:
  python3 tk.py auth                 # one-time browser sign-in, saves token
  python3 tk.py tools                # dump tool schemas to tools.json
  python3 tk.py call NAME '{json}'   # call a tool, print result
"""
import base64, hashlib, http.server, json, os, secrets, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

BASE = "https://tk.xyz"
MCP = BASE + "/mcp"
PORT = 53682
REDIRECT = f"http://127.0.0.1:{PORT}/callback"
HERE = Path(__file__).parent
TOKEN = HERE / ".tk-token.json"  # secret: gitignored, chmod 600


def post(url, data, headers=None, form=False):
    body = urllib.parse.urlencode(data).encode() if form else json.dumps(data).encode()
    # Cloudflare returns 1010 for urllib's default UA
    h = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json",
         "User-Agent": "obsidian-tk-sync/0.0 (+personal)"}
    h.update(headers or {})
    req = urllib.request.Request(url, body, h, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def save(tok):
    tok["obtained_at"] = time.time()
    TOKEN.write_text(json.dumps(tok))
    os.chmod(TOKEN, 0o600)


def auth():
    s, _, b = post(BASE + "/oauth/register", {
        "client_name": "obsidian-tk-sync (spike)", "redirect_uris": [REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
        "token_endpoint_auth_method": "none"})
    assert s in (200, 201), b
    client_id = json.loads(b)["client_id"]
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = BASE + "/oauth/authorize?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "scope": "read write",
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state, "resource": MCP})
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            got.update(q)
            self.send_response(200); self.end_headers()
            self.wfile.write(b"TK spike: signed in, you can close this tab.")
        def log_message(self, *a): pass

    srv = http.server.HTTPServer(("127.0.0.1", PORT), H)
    subprocess.run(["open", url])
    print("Opened browser for TK sign-in; waiting...", flush=True)
    while "code" not in got and "error" not in got:
        srv.handle_request()
    assert got.get("state") == state, "state mismatch"
    assert "code" in got, got
    s, _, b = post(BASE + "/oauth/token", {
        "grant_type": "authorization_code", "code": got["code"], "redirect_uri": REDIRECT,
        "client_id": client_id, "code_verifier": verifier, "resource": MCP}, form=True)
    assert s == 200, b
    tok = json.loads(b); tok["client_id"] = client_id
    save(tok)
    print("Token saved. Keys:", sorted(k for k in tok if k not in ("access_token", "refresh_token")))


def refresh(tok):
    s, _, b = post(BASE + "/oauth/token", {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"],
                                           "client_id": tok["client_id"], "resource": MCP}, form=True)
    assert s == 200, b
    new = json.loads(b); new["client_id"] = tok["client_id"]
    new.setdefault("refresh_token", tok["refresh_token"])
    save(new)
    return new


def parse(body):
    """Response is either JSON or SSE; return the JSON-RPC message with an id."""
    body = body.strip()
    if body.startswith("{"):
        return json.loads(body)
    for line in body.splitlines():
        if line.startswith("data:"):
            m = json.loads(line[5:])
            if "id" in m:
                return m
    raise ValueError(body[:500])


class Client:
    def __init__(self):
        self.tok = json.loads(TOKEN.read_text())
        self.sid = None
        self.n = 0
        r = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "obsidian-tk-sync-spike", "version": "0"}})
        self.server = r
        self.rpc("notifications/initialized", None, notify=True)

    def rpc(self, method, params, notify=False, retry=True):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None: msg["params"] = params
        if not notify:
            self.n += 1; msg["id"] = self.n
        h = {"Accept": "application/json, text/event-stream", "Authorization": "Bearer " + self.tok["access_token"],
             "MCP-Protocol-Version": "2025-06-18"}
        if self.sid: h["Mcp-Session-Id"] = self.sid
        s, hd, b = post(MCP, msg, h)
        if s == 401 and retry:
            self.tok = refresh(self.tok)
            return self.rpc(method, params, notify, retry=False)
        self.sid = self.sid or hd.get("Mcp-Session-Id") or hd.get("mcp-session-id")
        if notify: return None
        assert s == 200, (s, b[:500])
        m = parse(b)
        if "error" in m: raise RuntimeError(m["error"])
        return m["result"]

    def call(self, name, args):
        return self.rpc("tools/call", {"name": name, "arguments": args})


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "auth":
        auth()
    elif cmd == "tools":
        c = Client()
        tools = c.rpc("tools/list", {})["tools"]
        (HERE / "tools.json").write_text(json.dumps({"server": c.server, "tools": tools}, indent=2))
        for t in tools:
            print(f"- {t['name']}: {list(t.get('inputSchema', {}).get('properties', {}))}")
    elif cmd == "call":
        print(json.dumps(Client().call(sys.argv[2], json.loads(sys.argv[3] if len(sys.argv) > 3 else "{}")), indent=2))
