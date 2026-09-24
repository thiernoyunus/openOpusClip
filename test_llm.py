"""Self-checks for the multi-provider layer (no network: httpx is stubbed)."""

import json

import httpx

import llm


class _Resp:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def _stub_post(monkeypatch, *responses):
    calls = []
    queue = list(responses)

    def post(url, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": json, "headers": headers})
        return queue.pop(0)

    monkeypatch.setattr(httpx, "post", post)
    return calls


def test_no_provider_means_todays_gemini_setup():
    ai = llm.build_settings(gemini_key="g-key", gemini_model="gemini-3.6-flash")
    assert (ai.provider, ai.api_key, ai.model) == ("gemini", "g-key", "gemini-3.6-flash")


def test_env_round_trip_keeps_provider_choice(monkeypatch):
    ai = llm.build_settings(provider="openrouter", api_key="k", model="anthropic/claude-sonnet-5")
    env = llm.settings_to_env(ai, {})
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    again = llm.settings_from_env()
    assert (again.provider, again.model, again.base_url) == (
        "openrouter", "anthropic/claude-sonnet-5", "https://openrouter.ai/api/v1")
    assert "GEMINI_API_KEY" not in env


def test_bad_input_is_rejected():
    for kwargs in ({"provider": "nope"}, {"provider": "custom", "model": "m", "base_url": "ftp://x"},
                   {"provider": "openai", "model": "bad model;"}, {"provider": "openai"}):
        try:
            llm.build_settings(**kwargs)
        except ValueError:
            continue
        raise AssertionError(f"accepted {kwargs}")


def test_openai_compatible_call_returns_gemini_shape(monkeypatch):
    calls = _stub_post(monkeypatch, _Resp(200, {
        "choices": [{"message": {"content": "Here you go:\n```json\n{\"shorts\": []}\n```"}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.002},
    }))
    ai = llm.build_settings(provider="openrouter", api_key="k", model="x-ai/grok-4.7")
    resp = llm.make_client(ai).models.generate_content(
        model=ai.model, contents="prompt", config=llm.genai.types.GenerateContentConfig(
            response_mime_type="application/json"))
    assert json.loads(resp.text) == {"shorts": []}
    assert calls[0]["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert calls[0]["json"]["response_format"] == {"type": "json_object"}
    assert calls[0]["headers"]["Authorization"] == "Bearer k"
    assert llm.estimate_cost(ai.model, resp.usage_metadata) == (None, None, 0.002, "provider_reported")


def test_json_mode_rejection_retries_without_it(monkeypatch):
    calls = _stub_post(
        monkeypatch,
        _Resp(400, {"error": "response_format is not supported"}),
        _Resp(200, {"choices": [{"message": {"content": "[1]"}}], "usage": {}}),
    )
    ai = llm.build_settings(provider="custom", model="qwen3", base_url="http://localhost:11434/v1/")
    resp = llm.make_client(ai).generate(ai.model, "p", wants_json=True)
    assert resp.text == "[1]"
    assert "response_format" not in calls[1]["json"]
    assert calls[1]["url"] == "http://localhost:11434/v1/chat/completions"
    assert llm.estimate_cost(ai.model, resp.usage_metadata)[2] is None


def test_claude_uses_native_messages_api(monkeypatch):
    calls = _stub_post(monkeypatch, _Resp(200, {
        "content": [{"type": "text", "text": "{\"best\": 1}"}],
        "usage": {"input_tokens": 7, "cache_read_input_tokens": 3, "output_tokens": 2},
    }))
    ai = llm.build_settings(provider="anthropic", api_key="sk-ant", model="claude-sonnet-5")
    resp = llm.make_client(ai).generate(ai.model, "p", wants_json=True)
    assert json.loads(resp.text) == {"best": 1}
    assert calls[0]["url"] == "https://api.anthropic.com/v1/messages"
    assert calls[0]["headers"]["x-api-key"] == "sk-ant"
    assert resp.usage_metadata.prompt_token_count == 10


def test_errors_lead_with_status_code_for_retry_logic(monkeypatch):
    _stub_post(monkeypatch, _Resp(429, {"error": "rate limited"}))
    ai = llm.build_settings(provider="deepseek", api_key="k", model="deepseek-v4-pro")
    try:
        llm.make_client(ai).generate(ai.model, "p", wants_json=False)
    except RuntimeError as e:
        assert str(e).startswith("429 ")
    else:
        raise AssertionError("expected an error")


def test_model_list_filters_and_orders(monkeypatch):
    payload = {"data": [
        {"id": "zzz/other", "name": "Other", "pricing": {"prompt": "0.1", "completion": "0.1"}},
        {"id": "google/gemma:free", "name": "Gemma", "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "google/nano-banana", "architecture": {"output_modalities": ["image", "text"]}},
        {"id": "openai/text-embedding-3", "name": "Embed"},
        {"id": "x/y:batch", "name": "Batch"},
        {"id": "anthropic/claude-sonnet-5", "name": "Claude Sonnet 5"},
    ]}
    monkeypatch.setattr(httpx, "get", lambda url, headers=None, timeout=None: _Resp(200, payload))
    ai = llm.build_settings(provider="openrouter", require_model=False)
    ids = [(m["id"], m["recommended"], m["free"]) for m in llm.list_models(ai)]
    assert ids == [
        ("anthropic/claude-sonnet-5", True, False),
        ("google/gemma:free", False, True),
        ("zzz/other", False, False),
    ]


def test_trailer_cost_total_survives_providers_without_prices(monkeypatch):
    """DeepSeek run crashed adding None costs; the total is now just unknown."""
    import main
    assert main._sum_costs([None, None]) is None
    assert main._sum_costs([0.5, None]) is None
    assert main._sum_costs([0.5, 0.25]) == 0.75


def test_failure_labels_follow_the_chosen_provider(monkeypatch):
    import main
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("LLM_MODEL", "deepseek-v4-flash")
    assert main._active_ai() == ("deepseek", "deepseek-v4-flash")
    monkeypatch.setenv("LLM_MODEL", "")
    assert main._active_ai() == ("gemini", main.DEFAULT_GEMINI_MODEL)
