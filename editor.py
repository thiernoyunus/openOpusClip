import json
from google import genai
from google.genai import types
from gemini_models import get_gemini_model


class VideoEditor:
    def __init__(self, api_key, model_name=None):
        self.client = genai.Client(api_key=api_key)
        self.text_model_name = get_gemini_model(model_name)

    def get_caption_enhancements(self, words: list[str]) -> dict:
        """
        Text-only Gemini call: given the ordered list of caption words, pick a
        SMALL set of contextually fitting emojis to attach to specific word
        indices, and the keyword word indices worth highlighting.

        Returns {"emojis": {index: "🔥", ...}, "highlights": [index, ...]}.
        Robust to malformed responses — returns empty enhancements on any error.
        """
        empty = {"emojis": {}, "highlights": []}
        if not words:
            return empty

        # Number the words so the model can reference them by index precisely.
        numbered = "\n".join(f"{i}: {w}" for i, w in enumerate(words))
        total = len(words)
        # Budgets scale with length but stay sparse (OpusClip-style restraint).
        max_emojis = max(1, min(8, round(total / 12)))
        max_highlights = max(1, min(12, round(total / 6)))

        prompt = f"""You are a social-video caption editor. You are given the ordered words of a short-form video caption track, one per line as "INDEX: WORD".

WORDS ({total} total):
{numbered}

Do TWO things, sparingly and tastefully:
1. EMOJIS: Attach a single fitting emoji to a FEW high-impact words (nouns, actions, or emotional beats). Use at most {max_emojis} emojis total. Do NOT emoji every word — most words get none. Pick the emoji that best matches the word's meaning in context.
2. HIGHLIGHTS: Choose the KEYWORD word indices worth visually highlighting — the words a viewer should remember (power words, numbers, names, key claims). Use at most {max_highlights} highlights total. Be selective.

Rules:
- Reference words ONLY by their integer index shown above (0-based).
- An index may appear in both emojis and highlights.
- Emojis must be a single emoji character (no text).
- If nothing fits, return empty objects/arrays — that is fine.

Return ONLY JSON of this exact shape:
{{
  "emojis": [{{ "index": 3, "emoji": "🔥" }}, {{ "index": 10, "emoji": "🚀" }}],
  "highlights": [3, 7, 10]
}}"""

        try:
            response = self.client.models.generate_content(
                model=self.text_model_name,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    # emojis is an array of {index, emoji} (NOT a free-form map):
                    # Gemini's structured-output validator can reject objects that
                    # rely on additionalProperties. Mapped back to a dict below.
                    response_schema={
                        "type": "object",
                        "properties": {
                            "emojis": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "index": {"type": "integer"},
                                        "emoji": {"type": "string"},
                                    },
                                    "required": ["index", "emoji"],
                                },
                            },
                            "highlights": {
                                "type": "array",
                                "items": {"type": "integer"},
                            },
                        },
                        "required": ["emojis", "highlights"],
                    },
                ),
            )
        except Exception as e:
            print(f"❌ Caption enhancement request failed: {e}")
            return empty

        text = response.text if response and getattr(response, "text", None) else ""
        if not text:
            return empty

        # Defensive cleanup: strip markdown fences / trailing junk, then parse.
        try:
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
            start_idx = text.find("{")
            end_idx = text.rfind("}")
            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx + 1]
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError) as e:
            print(f"❌ Failed to parse caption enhancements JSON: {e}")
            return empty

        if not isinstance(data, dict):
            return empty

        # Normalize and clamp to valid in-range indices so the frontend can
        # merge by index without extra validation.
        raw_emojis = data.get("emojis") or []
        emojis: dict[str, str] = {}
        if isinstance(raw_emojis, list):
            for item in raw_emojis:
                if not isinstance(item, dict):
                    continue
                idx = item.get("index")
                val = item.get("emoji")
                if not isinstance(idx, int) or isinstance(idx, bool):
                    continue
                if 0 <= idx < total and isinstance(val, str) and val.strip():
                    emojis[str(idx)] = val.strip()

        raw_highlights = data.get("highlights") or []
        highlights: list[int] = []
        if isinstance(raw_highlights, list):
            seen = set()
            for h in raw_highlights:
                try:
                    idx = int(h)
                except (ValueError, TypeError):
                    continue
                if 0 <= idx < total and idx not in seen:
                    seen.add(idx)
                    highlights.append(idx)

        return {"emojis": emojis, "highlights": highlights}

    def get_broll_suggestions(self, words_with_ms: list[dict]) -> list[dict]:
        """
        Text-only Gemini call: given the ordered caption words with their
        millisecond start offsets (relative to clip start), suggest UP TO 3
        contextual b-roll inserts. For each insert the model picks a concise
        visual search keyword (good for stock-video search), the startMs (snapped
        to one of the provided word startMs values where the concept is spoken),
        and a durationMs between 2000 and 5000.

        Returns [{"keyword": str, "startMs": int, "durationMs": int}, ...].
        Robust to malformed responses — returns [] on any error/empty input.
        """
        if not words_with_ms:
            return []

        # Build the numbered, time-stamped transcript and the set of valid
        # startMs values the model is allowed to snap to.
        lines: list[str] = []
        valid_ms: set[int] = set()
        for w in words_with_ms:
            if not isinstance(w, dict):
                continue
            text = str(w.get("text", "")).strip()
            try:
                ms = int(w.get("startMs"))
            except (ValueError, TypeError):
                continue
            valid_ms.add(ms)
            lines.append(f"{ms}: {text}")

        if not lines:
            return []

        numbered = "\n".join(lines)

        prompt = f"""You are a short-form video editor choosing B-ROLL inserts. You are given the spoken words of a vertical (9:16) short, one per line as "START_MS: WORD", where START_MS is the millisecond offset from the start of the clip.

WORDS:
{numbered}

Suggest UP TO 3 contextual b-roll inserts — overlay stock-video clips that visually reinforce what is being said. Be selective and tasteful (most shorts need 0-3, not more).

For EACH insert provide:
1. "keyword": a concise visual search phrase for a stock-video library (2-4 words, concrete and filmable, e.g. "city skyline", "ocean waves", "stock market chart", "people running"). NO sentences, NO abstract concepts.
2. "startMs": the moment the related concept is spoken. It MUST be exactly one of the START_MS values shown above.
3. "durationMs": how long the insert should stay on screen, an integer between 2000 and 5000.

Rules:
- Only suggest inserts where a concrete visual clearly matches the words. If nothing fits, return an empty array — that is fine.
- "startMs" MUST be copied verbatim from one of the START_MS values above.
- At most 3 inserts.

Return ONLY a JSON array of this exact shape:
[
  {{ "keyword": "city skyline", "startMs": 1200, "durationMs": 3000 }}
]"""

        try:
            response = self.client.models.generate_content(
                model=self.text_model_name,
                contents=[prompt],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema={
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "keyword": {"type": "string"},
                                "startMs": {"type": "integer"},
                                "durationMs": {"type": "integer"},
                            },
                            "required": ["keyword", "startMs", "durationMs"],
                        },
                    },
                ),
            )
        except Exception as e:
            print(f"❌ B-roll suggestion request failed: {e}")
            return []

        text = response.text if response and getattr(response, "text", None) else ""
        if not text:
            return []

        # Defensive cleanup: strip markdown fences / trailing junk, then parse.
        try:
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
            start_idx = text.find("[")
            end_idx = text.rfind("]")
            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx + 1]
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError) as e:
            print(f"❌ Failed to parse b-roll suggestions JSON: {e}")
            return []

        if not isinstance(data, list):
            return []

        # Normalize / validate each suggestion, clamp duration, snap startMs to a
        # real word offset, and cap the list at 3.
        suggestions: list[dict] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            keyword = item.get("keyword")
            if not isinstance(keyword, str) or not keyword.strip():
                continue
            try:
                start_ms = int(item.get("startMs"))
                duration_ms = int(item.get("durationMs"))
            except (ValueError, TypeError):
                continue
            # Snap startMs to the nearest valid word offset if not exact.
            if start_ms not in valid_ms:
                start_ms = min(valid_ms, key=lambda m: abs(m - start_ms))
            duration_ms = max(2000, min(5000, duration_ms))
            suggestions.append({
                "keyword": keyword.strip(),
                "startMs": start_ms,
                "durationMs": duration_ms,
            })
            if len(suggestions) >= 3:
                break

        return suggestions
