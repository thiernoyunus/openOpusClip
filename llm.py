"""Pick which AI provider answers the text prompts (clip finding, trailer, captions).

Gemini keeps its native SDK. Every other provider goes through a tiny client that
mimics the one Gemini call the pipeline uses — client.models.generate_content(
model=, contents=, config=) returning .text and .usage_metadata — so the callers
don't change. Almost every provider speaks OpenAI's chat format; Claude gets its
own adapter because Anthropic's OpenAI-compatible endpoint ignores JSON mode.

Model lists come live from each provider, so new models show up without an app
update. RECOMMENDED only orders/stars the list; a stale entry is harmless.
"""

import os
import re
from dataclasses import dataclass

import httpx
from google import genai

from gemini_models import DEFAULT_GEMINI_MODEL, GEMINI_MODELS, get_gemini_pricing

# kind: which wire format to speak. base_url: None = the user types it (Custom).
PROVIDERS = {
    "gemini": {"label": "Google Gemini", "kind": "gemini", "base_url": None},
    "openrouter": {"label": "OpenRouter (every model, one key)", "kind": "openai",
                   "base_url": "https://openrouter.ai/api/v1"},
    "anthropic": {"label": "Anthropic (Claude)", "kind": "anthropic",
                  "base_url": "https://api.anthropic.com/v1"},
    "openai": {"label": "OpenAI", "kind": "openai", "base_url": "https://api.openai.com/v1"},
    "deepseek": {"label": "DeepSeek", "kind": "openai", "base_url": "https://api.deepseek.com/v1"},
    "xai": {"label": "xAI (Grok)", "kind": "openai", "base_url": "https://api.x.ai/v1"},
    "mimo": {"label": "Xiaomi MiMo", "kind": "openai", "base_url": "https://api.xiaomimimo.com/v1"},
    "custom": {"label": "Custom (any OpenAI-compatible API)", "kind": "openai", "base_url": None},
}

RECOMMENDED = {
    "gemini": ["gemini-3.1-pro-preview", *GEMINI_MODELS],
    "openrouter": [
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5.5",
        "google/gemini-3.1-pro-preview",
        "google/gemini-3.8-flash",
        "openai/gpt-6-sol",
        "deepseek/deepseek-v4-pro",
        "x-ai/grok-4.7",
        "xiaomi/mimo-v2.6-pro",
        "moonshotai/kimi-k3",
    ],
    "anthropic": ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5"],
}

# Model ids are passed straight to the provider; this only keeps junk out of
# headers/env/logs (e.g. "anthropic/claude-sonnet-5", "qwen3:8b", "gpt-6@2026").
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$")

# Anything a text-only pipeline can't use: images, audio, embeddings, moderation.
_NON_TEXT_RE = re.compile(
    r"embed|whisper|tts|dall-e|image|imagen|veo|moderation|audio|realtime|"
    r"transcribe|sora|davinci|babbage|search|computer-use|live|aqa|robotics|"
    r":batch$", re.IGNORECASE)

TIMEOUT = httpx.Timeout(600.0, connect=30.0)


@dataclass
class LLMSettings:
    provider: str = "gemini"
    api_key: str = ""
    model: str = DEFAULT_GEMINI_MODEL
    base_url: str = ""

    @property
    def label(self):
        return PROVIDERS[self.provider]["label"]


def clean_model_id(model, provider="gemini"):
    """Return a usable model id or raise ValueError."""
    model = str(model or "").strip()
    if not model:
        return DEFAULT_GEMINI_MODEL if provider == "gemini" else ""
    if not _MODEL_ID_RE.match(model):
        raise ValueError(f"'{model[:60]}' doesn't look like a model name.")
    return model


def build_settings(provider=None, api_key=None, model=None, base_url=None,
                   gemini_key=None, gemini_model=None, require_model=True):
    """Validate one provider choice. Missing provider = today's Gemini behaviour."""
    provider = (provider or "gemini").strip().lower()
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown AI provider '{provider}'.")
    if provider == "gemini":
        api_key = api_key or gemini_key
        model = model or gemini_model
    base_url = (base_url or "").strip() or (PROVIDERS[provider]["base_url"] or "")
    if PROVIDERS[provider]["base_url"] is None and provider != "gemini":
        if not re.match(r"^https?://", base_url):
            raise ValueError("Custom provider needs an API address starting with http:// or https://.")
    model = clean_model_id(model, provider)
    if not model and require_model:
        raise ValueError("Pick a model for the AI provider.")
    return LLMSettings(provider, (api_key or "").strip(), model, base_url.rstrip("/"))


def settings_from_headers(headers, require_model=True):
    """Read the X-AI-* headers the dashboard sends (falls back to X-Gemini-*)."""
    return build_settings(
        require_model=require_model,
        provider=headers.get("X-AI-Provider"),
        api_key=headers.get("X-AI-Key"),
        model=headers.get("X-AI-Model"),
        base_url=headers.get("X-AI-Base-Url"),
        gemini_key=headers.get("X-Gemini-Key"),
        gemini_model=headers.get("X-Gemini-Model"),
    )


def settings_to_env(settings, env):
    """Hand the choice to a main.py subprocess. GEMINI_* stays for Gemini-only steps."""
    env["LLM_PROVIDER"] = settings.provider
    env["LLM_API_KEY"] = settings.api_key
    env["LLM_MODEL"] = settings.model
    env["LLM_BASE_URL"] = settings.base_url
    if settings.provider == "gemini":
        env["GEMINI_API_KEY"] = settings.api_key
        env["GEMINI_MODEL"] = settings.model
    return env


def settings_from_env():
    """main.py side. A plain CLI run with only GEMINI_* set behaves as before."""
    return build_settings(
        provider=os.environ.get("LLM_PROVIDER"),
        api_key=os.environ.get("LLM_API_KEY"),
        model=os.environ.get("LLM_MODEL"),
        base_url=os.environ.get("LLM_BASE_URL"),
        gemini_key=os.environ.get("GEMINI_API_KEY"),
        gemini_model=os.environ.get("GEMINI_MODEL"),
    )


def make_client(settings):
    """A client with Gemini's .models.generate_content() shape."""
    kind = PROVIDERS[settings.provider]["kind"]
    if kind == "gemini":
        return genai.Client(api_key=settings.api_key)
    return _CompatClient(kind, settings)


def estimate_cost(model, usage):
    """(input_cost, output_cost, total_cost, basis) in USD; None where unknown.

    Gemini uses the built-in price table. OpenRouter reports the real charge per
    call. Other providers don't return prices, so only tokens are shown."""
    reported = getattr(usage, "cost_usd", None)
    if reported is not None:
        return None, None, float(reported), "provider_reported"
    if getattr(usage, "provider", "gemini") != "gemini":
        return None, None, None, "unknown"
    in_rate, out_rate = get_gemini_pricing(model)
    input_cost = usage.prompt_token_count / 1_000_000 * in_rate
    output_cost = usage.candidates_token_count / 1_000_000 * out_rate
    return input_cost, output_cost, input_cost + output_cost, "paid_standard"


# --- non-Gemini client --------------------------------------------------------

class _Usage:
    def __init__(self, provider, prompt_tokens, output_tokens, cost_usd=None):
        self.provider = provider
        self.prompt_token_count = int(prompt_tokens or 0)
        self.candidates_token_count = int(output_tokens or 0)
        self.cost_usd = cost_usd


class _Response:
    def __init__(self, text, usage):
        self.text = _clean_json_text(text)
        self.usage_metadata = usage


class _Models:
    def __init__(self, owner):
        self._owner = owner

    def generate_content(self, model, contents, config=None):
        prompt = contents if isinstance(contents, str) else "\n\n".join(
            c for c in contents if isinstance(c, str))
        wants_json = getattr(config, "response_mime_type", None) == "application/json"
        return self._owner.generate(model, prompt, wants_json)


class _CompatClient:
    def __init__(self, kind, settings):
        self.kind = kind
        self.settings = settings
        self.models = _Models(self)

    def generate(self, model, prompt, wants_json):
        if self.kind == "anthropic":
            return self._anthropic(model, prompt, wants_json)
        return self._openai(model, prompt, wants_json)

    def _openai(self, model, prompt, wants_json):
        body = {"model": model, "messages": [{"role": "user", "content": prompt}]}
        if wants_json:
            body["response_format"] = {"type": "json_object"}
        url = f"{self.settings.base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {self.settings.api_key}"}
        resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT)
        if resp.status_code == 400 and wants_json and "response_format" in resp.text:
            # Some models reject JSON mode; the prompts already ask for JSON.
            body.pop("response_format")
            resp = httpx.post(url, json=body, headers=headers, timeout=TIMEOUT)
        data = _json_or_raise(resp, self.settings)
        choice = (data.get("choices") or [{}])[0]
        text = (choice.get("message") or {}).get("content") or ""
        usage = data.get("usage") or {}
        return _Response(text, _Usage(
            self.settings.provider, usage.get("prompt_tokens"),
            usage.get("completion_tokens"), usage.get("cost")))

    def _anthropic(self, model, prompt, wants_json):
        body = {"model": model, "max_tokens": 16000,
                "messages": [{"role": "user", "content": prompt}]}
        if wants_json:
            body["system"] = "Reply with only the JSON the user asks for. No prose, no code fences."
        resp = httpx.post(
            f"{self.settings.base_url}/messages", json=body, timeout=TIMEOUT,
            headers={"x-api-key": self.settings.api_key, "anthropic-version": "2023-06-01"})
        data = _json_or_raise(resp, self.settings)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        usage = data.get("usage") or {}
        prompt_tokens = sum(usage.get(k) or 0 for k in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        return _Response(text, _Usage(self.settings.provider, prompt_tokens, usage.get("output_tokens")))


def _json_or_raise(resp, settings):
    # The status code leads the message so main.py's retry/classify markers
    # ("429", "503", ...) work the same as for Gemini errors.
    if resp.status_code >= 400:
        raise RuntimeError(f"{resp.status_code} {settings.label} error: {resp.text[:500]}")
    return resp.json()


def _clean_json_text(text):
    """Drop <think> blocks and prose around the JSON some models add."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.DOTALL).strip()
    if text[:1] in "{[":
        return text
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    end = max(text.rfind("}"), text.rfind("]"))
    if starts and end > min(starts):
        return text[min(starts):end + 1]
    return text


# --- live model lists ---------------------------------------------------------

def list_models(settings):
    """[{id, label, recommended, free}] the key can use, recommended first."""
    kind = PROVIDERS[settings.provider]["kind"]
    if kind == "gemini":
        client = genai.Client(api_key=settings.api_key)
        found = []
        for m in client.models.list():
            actions = getattr(m, "supported_actions", None) or []
            if actions and "generateContent" not in actions:
                continue
            model_id = m.name.removeprefix("models/")
            # Google's free tier covers Flash / Flash-Lite, not Pro. The API
            # doesn't say so per model, hence the name check.
            found.append((model_id, getattr(m, "display_name", None), "flash" in model_id))
    elif kind == "anthropic":
        resp = httpx.get(f"{settings.base_url}/models", params={"limit": 1000}, timeout=30,
                         headers={"x-api-key": settings.api_key, "anthropic-version": "2023-06-01"})
        found = [(m["id"], m.get("display_name"), False)
                 for m in _json_or_raise(resp, settings).get("data", [])]
    else:
        headers = {"Authorization": f"Bearer {settings.api_key}"} if settings.api_key else {}
        resp = httpx.get(f"{settings.base_url}/models", headers=headers, timeout=30)
        found = []
        for m in _json_or_raise(resp, settings).get("data", []):
            outputs = (m.get("architecture") or {}).get("output_modalities")
            if outputs and outputs != ["text"]:
                continue  # OpenRouter says exactly what each model outputs
            price = m.get("pricing") or {}
            free = bool(price) and all(_is_zero(price.get(k)) for k in ("prompt", "completion"))
            found.append((m["id"], m.get("name"), free))

    recommended = RECOMMENDED.get(settings.provider, [])
    models, seen = [], set()
    for model_id, label, free in found:
        if model_id in seen or _NON_TEXT_RE.search(model_id):
            continue
        seen.add(model_id)
        models.append({"id": model_id, "label": label or model_id,
                       "recommended": model_id in recommended, "free": free})
    rank = {m: i for i, m in enumerate(recommended)}
    models.sort(key=lambda m: (rank.get(m["id"], len(rank)), m["id"]))
    return models


def _is_zero(value):
    try:
        return float(value) == 0
    except (TypeError, ValueError):
        return False
