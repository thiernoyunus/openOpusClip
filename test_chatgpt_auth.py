"""Self-checks for Sign in with ChatGPT (no network: httpx is stubbed)."""

import base64
import json
import time
from contextlib import contextmanager
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

import chatgpt_auth
import llm


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def _jwt(claims):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.sig"


@pytest.fixture
def auth(tmp_path, monkeypatch):
    monkeypatch.setenv("CHATGPT_AUTH_FILE", str(tmp_path / "auth.json"))
    monkeypatch.setenv("CHATGPT_CALLBACK_PORT", "0")  # any free port in tests
    yield
    with chatgpt_auth._login.lock:
        chatgpt_auth._stop_server()


def _token_reply(client_id, nonce, scope=chatgpt_auth.SCOPES):
    return _Resp(200, {
        "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600, "scope": scope,
        "id_token": _jwt({"iss": "https://auth.openai.com", "aud": client_id, "sub": "user-1",
                          "email": "a@example.com", "exp": time.time() + 600, "nonce": nonce}),
    })


def _start():
    url = chatgpt_auth.start_login()
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def test_first_sign_in_registers_the_app_and_saves_tokens(auth, monkeypatch):
    params = _start()
    assert params["client_id"] == chatgpt_auth.REGISTER_CLIENT_ID
    assert params["agent_name_hint"] == "openOpusClip"
    assert params["code_challenge_method"] == "S256"
    assert "chatgpt.tokens.use.direct" in params["scope"].split()
    assert params["redirect_uri"].startswith("http://127.0.0.1:")
    assert params["redirect_uri"].endswith("/auth/callback")

    posts = []
    def post(url, data=None, timeout=None):
        posts.append(data)
        return _token_reply("oaiapp_123", params["nonce"])
    monkeypatch.setattr(httpx, "post", post)

    assert chatgpt_auth.finish_login({"state": params["state"], "code": "c", "client_id": "oaiapp_123"})
    assert posts[0]["client_id"] == "oaiapp_123"  # the issued id, not dynamic_agent_client
    assert posts[0]["redirect_uri"] == params["redirect_uri"]
    status = chatgpt_auth.status()
    assert status["signed_in"] and status["plan_usage"] and status["email"] == "a@example.com"

    # The next sign-in reuses the registration instead of registering again.
    again = _start()
    assert again["client_id"] == "oaiapp_123" and "agent_name_hint" not in again
    assert again["ext_agent_host_id"] == params["ext_agent_host_id"]


def test_wrong_state_and_cancel_save_nothing(auth, monkeypatch):
    params = _start()
    with pytest.raises(RuntimeError, match="stale"):
        chatgpt_auth.finish_login({"state": "nope", "code": "c"})
    with pytest.raises(RuntimeError, match="cancelled"):
        chatgpt_auth.finish_login({"state": params["state"], "error": "access_denied"})
    assert not chatgpt_auth.status()["signed_in"]


def test_bad_nonce_is_rejected(auth, monkeypatch):
    params = _start()
    monkeypatch.setattr(httpx, "post", lambda url, data=None, timeout=None: _token_reply("oaiapp_1", "other"))
    with pytest.raises(RuntimeError, match="nonce"):
        chatgpt_auth.finish_login({"state": params["state"], "code": "c", "client_id": "oaiapp_1"})
    assert not chatgpt_auth.status()["signed_in"]


def test_declined_plan_usage_blocks_requests(auth):
    chatgpt_auth._save({"client_id": "oaiapp_1", "access_token": "at", "refresh_token": "rt",
                        "expires_at": time.time() + 3600, "scope": "openid profile email"})
    assert chatgpt_auth.status() == {**chatgpt_auth.status(), "signed_in": True, "plan_usage": False}
    with pytest.raises(chatgpt_auth.NotSignedIn, match="Use your ChatGPT plan"):
        chatgpt_auth.access_token()


def test_expiring_token_refreshes_and_keeps_the_rotated_refresh_token(auth, monkeypatch):
    chatgpt_auth._save({"client_id": "oaiapp_1", "access_token": "old", "refresh_token": "rt-old",
                        "expires_at": time.time() + 10, "scope": chatgpt_auth.SCOPES})
    sent = []
    def post(url, data=None, timeout=None):
        sent.append(data)
        return _Resp(200, {"access_token": "new", "refresh_token": "rt-new", "expires_in": 3600})
    monkeypatch.setattr(httpx, "post", post)
    assert chatgpt_auth.access_token() == "new"
    assert sent[0]["grant_type"] == "refresh_token" and sent[0]["refresh_token"] == "rt-old"
    assert chatgpt_auth._load()["refresh_token"] == "rt-new"
    assert chatgpt_auth.access_token() == "new" and len(sent) == 1  # still fresh: no second refresh


def test_dead_refresh_signs_out_but_keeps_registration(auth, monkeypatch):
    chatgpt_auth._save({"client_id": "oaiapp_1", "host_id": "h", "access_token": "old",
                        "refresh_token": "rt", "expires_at": 0, "scope": chatgpt_auth.SCOPES})
    monkeypatch.setattr(httpx, "post", lambda url, data=None, timeout=None: _Resp(400, {"error": "refresh_token_reused"}))
    with pytest.raises(chatgpt_auth.NotSignedIn):
        chatgpt_auth.access_token()
    assert chatgpt_auth._load() == {"client_id": "oaiapp_1", "host_id": "h"}


# --- the ChatGPT provider -----------------------------------------------------

class _Stream:
    def __init__(self, status, lines):
        self.status_code = status
        self._lines = lines
        self.text = "\n".join(lines)

    def iter_lines(self):
        return iter(self._lines)

    def read(self):
        return self.text.encode()

    def json(self):
        return json.loads(self.text)


def _stub_stream(monkeypatch, *streams):
    calls, queue = [], list(streams)

    @contextmanager
    def stream(method, url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers})
        yield queue.pop(0)

    monkeypatch.setattr(httpx, "stream", stream)
    return calls


def _events(*events):
    return [f"data: {json.dumps(e)}" for e in events]


def _signed_in():
    chatgpt_auth._save({"client_id": "oaiapp_1", "access_token": "at", "refresh_token": "rt",
                        "expires_at": time.time() + 3600, "scope": chatgpt_auth.SCOPES})


def test_chatgpt_provider_streams_the_answer(auth, monkeypatch):
    _signed_in()
    calls = _stub_stream(monkeypatch, _Stream(200, _events(
        {"type": "response.output_text.delta", "delta": '{"clips"'},
        {"type": "response.output_text.delta", "delta": ": []}"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 12, "output_tokens": 3}}},
    )))
    ai = llm.build_settings(provider="chatgpt", model="gpt-6.1-sol")
    assert llm.has_credentials(ai)

    class Cfg:
        response_mime_type = "application/json"

    resp = llm.make_client(ai).models.generate_content(model=ai.model, contents="find clips", config=Cfg())
    assert resp.text == '{"clips": []}'
    assert resp.usage_metadata.prompt_token_count == 12
    body = calls[0]["json"]
    assert calls[0]["url"] == "https://api.openai.com/v1/responses"
    assert calls[0]["headers"]["Authorization"] == "Bearer at"
    assert body["store"] is False and body["stream"] is True
    assert "temperature" not in body and "max_output_tokens" not in body
    assert all(item.get("role") != "system" for item in body["input"])
    assert llm.estimate_cost(ai.model, resp.usage_metadata)[2] is None


def test_chatgpt_usage_limit_is_a_plain_message_not_a_retry(auth, monkeypatch):
    _signed_in()
    _stub_stream(monkeypatch, _Stream(429, [json.dumps(
        {"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}})]))
    ai = llm.build_settings(provider="chatgpt", model="gpt-6.1-sol")
    with pytest.raises(RuntimeError) as err:
        llm.make_client(ai).models.generate_content(model=ai.model, contents="x")
    assert "usage limit" in str(err.value) and "429" not in str(err.value)


def test_chatgpt_401_refreshes_once_then_retries(auth, monkeypatch):
    _signed_in()
    monkeypatch.setattr(httpx, "post", lambda url, data=None, timeout=None: _Resp(
        200, {"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600}))
    calls = _stub_stream(monkeypatch, _Stream(401, []), _Stream(200, _events(
        {"type": "response.completed", "response": {"output": [
            {"content": [{"type": "output_text", "text": "hi"}]}], "usage": {}}})))
    ai = llm.build_settings(provider="chatgpt", model="gpt-6.1-sol")
    assert llm.make_client(ai).models.generate_content(model=ai.model, contents="x").text == "hi"
    assert calls[1]["headers"]["Authorization"] == "Bearer at-2"


def test_chatgpt_model_list_keeps_openai_order_and_listed_only(auth, monkeypatch):
    _signed_in()
    monkeypatch.setattr(httpx, "get", lambda url, headers=None, timeout=None, **kw: _Resp(200, {"models": [
        {"slug": "gpt-6.2-sol", "display_name": "GPT-6.2 Sol", "visibility": "list"},
        {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1 Sol", "visibility": "list"},
        {"slug": "internal", "display_name": "Hidden", "visibility": "hide"},
    ]}))
    ai = llm.build_settings(provider="chatgpt", require_model=False)
    assert [m["id"] for m in llm.list_models(ai)] == ["gpt-6.2-sol", "gpt-6.1-sol"]
