"""Sign in with ChatGPT: use the person's ChatGPT plan instead of an API key.

OpenAI's official "Sign in with ChatGPT" flow for open-source apps that run on
the user's own machine (no OpenAI approval needed for that case):
https://developers.openai.com/siwc/token-sharing-open-source/sign-in

1. start_login() opens a one-shot listener on http://127.0.0.1:1455/auth/callback
   and returns OpenAI's sign-in page URL (PKCE, no client secret).
2. The first sign-in registers this app (client_id=dynamic_agent_client); OpenAI
   sends back our own client id, which we keep and reuse.
3. Tokens live in one file on this computer (0600), never in the browser.
   Access tokens last an hour; refresh tokens rotate, so refreshes are locked.
"""

import base64
import hashlib
import json
import os
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

AUTH_BASE = "https://auth.openai.com"
AUTHORIZE_URL = f"{AUTH_BASE}/api/accounts/authorize"
TOKEN_URL = f"{AUTH_BASE}/api/accounts/oauth/token"
DISCOVERY_URL = f"{AUTH_BASE}/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = f"openid profile email offline_access resource.invoke {PLAN_SCOPE}"
REGISTER_CLIENT_ID = "dynamic_agent_client"
APP_NAME = "openOpusClip"
CALLBACK_PATH = "/auth/callback"
DEFAULT_PORT = 1455
LOGIN_TIMEOUT_S = 300
REFRESH_EARLY_S = 120

# Refresh errors that mean the sign-in is gone and the user must sign in again.
_DEAD_REFRESH = {"invalid_grant", "invalid_refresh_token", "token_expired",
                 "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"}


class NotSignedIn(RuntimeError):
    pass


def auth_file():
    return os.environ.get("CHATGPT_AUTH_FILE") or os.path.join(
        os.path.expanduser("~"), ".openopusclip", "chatgpt-auth.json")


def _load():
    try:
        with open(auth_file(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save(data):
    path = auth_file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


class _FileLock:
    """Cross-process lock so two jobs never spend the same rotating refresh token."""

    def __init__(self, path, stale_s=60):
        self.path, self.stale_s = path + ".lock", stale_s

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        deadline = time.time() + self.stale_s
        while True:
            try:
                os.close(os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > self.stale_s:
                        os.remove(self.path)
                        continue
                except OSError:
                    continue
                if time.time() > deadline:
                    raise TimeoutError("Timed out waiting for the ChatGPT sign-in lock.")
                time.sleep(0.2)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _jwt_claims(token):
    """Claims of a JWT. The ID token comes straight from OpenAI's token endpoint
    over TLS, which OpenID Connect accepts in place of a signature check; we
    still check issuer, audience, expiry and nonce."""
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError, AttributeError):
        return {}


def _check_id_token(id_token, client_id, nonce):
    claims = _jwt_claims(id_token)
    aud = claims.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if not str(claims.get("iss", "")).startswith(AUTH_BASE):
        raise RuntimeError("ChatGPT sign-in returned an ID token from an unexpected issuer.")
    if client_id not in auds:
        raise RuntimeError("ChatGPT sign-in returned an ID token for a different app.")
    if claims.get("exp", 0) < time.time() - 60:
        raise RuntimeError("ChatGPT sign-in returned an expired ID token.")
    if nonce and claims.get("nonce") != nonce:
        raise RuntimeError("ChatGPT sign-in failed a security check (nonce). Try again.")
    return claims


def _store_tokens(data, tokens):
    data.update({
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token") or data.get("refresh_token"),
        "expires_at": time.time() + int(tokens.get("expires_in") or 3600),
        "scope": tokens.get("scope") or data.get("scope", ""),
    })
    if tokens.get("id_token"):
        data["id_token"] = tokens["id_token"]


# --- sign-in ------------------------------------------------------------------

class _Login:
    """The one sign-in attempt in progress (the listener lives until it finishes)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.server = None
        self.pending = None
        self.error = ""


_login = _Login()


def _host_id(data):
    if not data.get("host_id"):
        data["host_id"] = str(uuid.uuid4())
    return data["host_id"]


def start_login():
    """Start the loopback listener and return the URL to open in the browser."""
    with _login.lock:
        _stop_server()
        data = _load()
        host_id = _host_id(data)
        _save(data)
        server = _bind()
        port = server.server_address[1]
        verifier = _b64url(secrets.token_bytes(32))
        pending = {
            "state": _b64url(secrets.token_bytes(24)),
            "nonce": _b64url(secrets.token_bytes(24)),
            "verifier": verifier,
            "redirect_uri": f"http://127.0.0.1:{port}{CALLBACK_PATH}",
            "client_id": data.get("client_id") or REGISTER_CLIENT_ID,
            "started": time.time(),
        }
        params = {
            "client_id": pending["client_id"],
            "ext_agent_host_id": host_id,
            "response_type": "code",
            "redirect_uri": pending["redirect_uri"],
            "scope": SCOPES,
            "resource": RESOURCE,
            "state": pending["state"],
            "nonce": pending["nonce"],
            "code_challenge_method": "S256",
            "code_challenge": _b64url(hashlib.sha256(verifier.encode()).digest()),
        }
        if pending["client_id"] == REGISTER_CLIENT_ID:
            params["agent_name_hint"] = APP_NAME
        elif data.get("email"):
            params["login_hint"] = data["email"]
        _login.server, _login.pending, _login.error = server, pending, ""
        threading.Thread(target=_serve, args=(server,), daemon=True).start()
        return f"{AUTHORIZE_URL}?{urlencode(params)}"


def _bind():
    # Docker maps the host's 127.0.0.1:1455 into the container, which needs 0.0.0.0.
    host = os.environ.get("CHATGPT_CALLBACK_HOST", "127.0.0.1")
    port = int(os.environ.get("CHATGPT_CALLBACK_PORT") or DEFAULT_PORT)
    try:
        return HTTPServer((host, port), _CallbackHandler)
    except OSError:
        # Port busy. OpenAI allows a different loopback port on later sign-ins.
        return HTTPServer((host, 0), _CallbackHandler)


def _serve(server):
    server.timeout = 1
    deadline = time.time() + LOGIN_TIMEOUT_S
    while _login.server is server and time.time() < deadline:
        server.handle_request()
    with _login.lock:
        if _login.server is server:
            if _login.pending:
                _login.error = "Sign-in timed out. Try again."
            _stop_server()


def _stop_server():
    server, _login.server, _login.pending = _login.server, None, None
    if server:
        try:
            server.server_close()
        except OSError:
            pass


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path != CALLBACK_PATH:
            self.send_error(404)
            return
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            ok, message = finish_login(query), "You're signed in. You can close this tab and go back to openOpusClip."
        except Exception as e:  # shown to the user in the browser and the app
            ok, message = False, str(e)
        body = (f"<!doctype html><meta charset=utf-8><title>openOpusClip</title>"
                f"<body style='font-family:system-ui;padding:3rem;background:#111;color:#eee'>"
                f"<h2>{'Signed in with ChatGPT' if ok else 'Sign-in did not finish'}</h2>"
                f"<p>{_html(message)}</p></body>").encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # never log the code/state query string
        pass


def _html(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def finish_login(query):
    """Handle OpenAI's redirect back. Returns True when tokens are saved."""
    with _login.lock:
        pending = _login.pending
        if not pending or not secrets.compare_digest(query.get("state", ""), pending["state"]):
            raise RuntimeError("This sign-in link is stale. Start again from openOpusClip.")
        _login.pending = None
        try:
            if query.get("error"):
                raise RuntimeError("Sign-in was cancelled." if query["error"] == "access_denied"
                                   else f"OpenAI said: {query.get('error_description') or query['error']}")
            client_id = pending["client_id"]
            issued = query.get("client_id")
            if client_id == REGISTER_CLIENT_ID:
                if not issued:
                    raise RuntimeError("OpenAI didn't return an app id. Try again.")
                client_id = issued
            elif issued and issued != client_id:
                raise RuntimeError("OpenAI returned a different app id. Try again.")
            resp = httpx.post(TOKEN_URL, timeout=30, data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": query.get("code", ""),
                "code_verifier": pending["verifier"],
                "redirect_uri": pending["redirect_uri"],
                "resource": RESOURCE,
            })
            if resp.status_code >= 400:
                raise RuntimeError(f"OpenAI rejected the sign-in ({resp.status_code}). Try again.")
            tokens = resp.json()
            claims = _check_id_token(tokens.get("id_token", ""), client_id, pending["nonce"])
            data = _load()
            if data.get("account") and data["account"] != claims.get("sub"):
                data = {"host_id": data.get("host_id")}  # different person: drop old tokens
            data.update({"client_id": client_id, "account": claims.get("sub"),
                         "email": claims.get("email", "")})
            _store_tokens(data, tokens)
            _save(data)
            _login.error = ""
            return True
        except Exception as e:
            _login.error = str(e)
            raise
        finally:
            # Let the listener loop exit; this request is the one it waited for.
            server, _login.server = _login.server, None
            if server:
                threading.Thread(target=server.server_close, daemon=True).start()


def status():
    data = _load()
    signed_in = bool(data.get("refresh_token") or data.get("access_token"))
    return {
        "signed_in": signed_in,
        "email": data.get("email", "") if signed_in else "",
        "plan_usage": signed_in and PLAN_SCOPE in data.get("scope", "").split(),
        "pending": _login.pending is not None,
        "error": _login.error,
    }


def logout():
    """Forget the tokens (best-effort revoke). Keep the app registration."""
    data = _load()
    token = data.get("refresh_token")
    if token and data.get("client_id"):
        try:
            url = httpx.get(DISCOVERY_URL, timeout=10).json().get("revocation_endpoint")
            if url:
                httpx.post(url, timeout=10, data={"token": token, "client_id": data["client_id"],
                                                  "token_type_hint": "refresh_token"})
        except Exception:
            pass
    _save({k: data[k] for k in ("client_id", "host_id") if k in data})
    _login.error = ""


# --- tokens for requests ---------------------------------------------------------

def access_token(force_refresh=False):
    """A valid access token for api.openai.com, refreshing it when it's close to expiry."""
    data = _load()
    if not data.get("access_token"):
        raise NotSignedIn("Not signed in with ChatGPT. Sign in under Settings > AI Model.")
    if PLAN_SCOPE not in data.get("scope", "").split():
        raise NotSignedIn("ChatGPT sign-in didn't allow 'Use your ChatGPT plan'. Sign in again and allow it.")
    if not force_refresh and data.get("expires_at", 0) - time.time() > REFRESH_EARLY_S:
        return data["access_token"]
    with _FileLock(auth_file()):
        data = _load()  # another process may have refreshed while we waited
        if not force_refresh and data.get("expires_at", 0) - time.time() > REFRESH_EARLY_S:
            return data["access_token"]
        if not data.get("refresh_token"):
            raise NotSignedIn("ChatGPT sign-in expired. Sign in again under Settings > AI Model.")
        resp = httpx.post(TOKEN_URL, timeout=30, data={
            "grant_type": "refresh_token",
            "client_id": data["client_id"],
            "refresh_token": data["refresh_token"],
            "resource": RESOURCE,
        })
        if resp.status_code >= 400:
            try:
                code = resp.json().get("error", "")
            except ValueError:
                code = ""
            if code in _DEAD_REFRESH or resp.status_code in (400, 401):
                _save({k: data[k] for k in ("client_id", "host_id") if k in data})
                raise NotSignedIn("ChatGPT sign-in expired. Sign in again under Settings > AI Model.")
            raise RuntimeError(f"{resp.status_code} ChatGPT sign-in refresh failed: {resp.text[:200]}")
        _store_tokens(data, resp.json())
        _save(data)
        return data["access_token"]
