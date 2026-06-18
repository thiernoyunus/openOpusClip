import os
import json
import re
import subprocess
import time
from google import genai
from google.genai import types

class VideoEditor:
    def __init__(self, api_key):
        self.client = genai.Client(api_key=api_key)
        self.model_name = "gemini-3-flash-preview" 

    def upload_video(self, video_path):
        """Uploads video to Gemini File API."""
        print(f"📤 Uploading {video_path} to Gemini...")
        
        # Ensure we are passing a path that exists
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"Video file not found: {video_path}")
            
        # Using 'file' keyword instead of 'path'
        try:
            file_upload = self.client.files.upload(file=video_path)
        except Exception as e:
            print(f"❌ Gemini Upload Error: {e}")
            raise e
        
        # Wait for processing
        print("⏳ Waiting for video processing by Gemini...")
        while True:
            file_info = self.client.files.get(name=file_upload.name)
            if file_info.state == "ACTIVE":
                print("✅ Video processed and ready.")
                return file_upload
            elif file_info.state == "FAILED":
                raise Exception("Video processing failed by Gemini.")
            time.sleep(2)

    def get_ffmpeg_filter(self, video_file_obj, duration, fps=30, width=None, height=None, transcript=None):
        """Asks Gemini for a raw FFmpeg filter string."""
        if width is None or height is None:
            # Keep prompt usable even if caller didn't pass dimensions.
            width, height = 1080, 1920
        
        transcript_text = json.dumps(transcript) if transcript else "Not available."

        prompt = f"""
        You are an expert FFmpeg video editor. Your task is to generate a complex video filter string to make a short video viral, BUT ONLY apply effects where they make sense contextually.

        Video Duration: {duration} seconds.
        Video FPS: {fps}
        Video Resolution (MUST KEEP EXACT): {width}x{height}
        
        TRANSCRIPT (Context of what is being said):
        {transcript_text}

        Goal: Enhance the video with dynamic zooms, cuts (simulated with punch-ins), and visual effects to increase retention, but DO NOT overdo it. Random effects are bad. Contextual effects are good.

        Instructions:
        1. ANALYZE THE VIDEO AND TRANSCRIPT: Understand the mood, the pacing, and the key moments.
        2. APPLY EFFECTS ONLY WHEN RELEVANT:
           - Use "punch-in" zooms (zoompan) to emphasize key points, jokes, or dramatic moments in the speech.
           - slow zooms to face when the speaker is speaking
           - Use visual effects (contrast, saturation, sharpness) to highlight mood changes or specific segments.
           - If nothing significant is happening, keep it simple. It is BETTER to have no effect than a random/distracting one.
           - Avoid constant motion if the speaker is delivering a serious or steady message.
        3. Create a single valid FFmpeg filter complex string (for the -vf flag).
        4. Use filters like `zoompan`, `eq` (contrast), `hue` (saturation/bw), `unsharp`.
        5. Pacing: Align effects with the rhythm of the speech (from transcript) or visual action.
        6. CRITICAL SYNTAX RULES:
           - DO NOT use comparison operators like `<`, `>`, `<=`, `>=` anywhere. They frequently break FFmpeg expression parsing.
           - USE FFmpeg expression FUNCTIONS instead:
             - `between(x,a,b)`
             - `lt(x,y)`, `lte(x,y)`, `gt(x,y)`, `gte(x,y)`
             - `if(cond,then,else)`
           - Always wrap expression values in single quotes: `z='...'`, `x='...'`, `y='...'`, `enable='...'`.
           
           - FOR `zoompan`: 
             - Prefer `on` (output frame index) to avoid time-variable quirks.
             - Convert seconds to frames using FPS={fps}: `frame = seconds * {fps}`.
             - Use `between(on, startFrame, endFrame)` for segmenting and pacing.
             - Example:
              `zoompan=z='1.1*between(on,0,75)+1.3*between(on,76,150)+1.15*between(on,151,300)+1.2*gte(on,301)'`
             - ALWAYS set zoompan output size to EXACT `{width}x{height}` using `s={width}x{height}`.
             - ALWAYS set `fps={fps}` and `d=1`.
             - DO NOT use `scale`, `crop`, `pad` unless you keep EXACT `{width}x{height}` (no aspect ratio changes).
             
           - FOR `eq`, `hue`, `curves`, `unsharp` (Visual Effects): 
             - **DO NOT** use dynamic expressions for parameter values (e.g. `contrast='1+0.5*t'`).
             - **USE TIMELINE EDITING** via the `enable` option.
             - Create MULTIPLE filter instances for different time ranges.
             - **SYNTAX FOR ENABLE:**
              - **USE** `between(t,start,end)` for clarity and robustness.
              - **USE** single quotes around the enable expression.
              - **Example:** `eq=contrast=1.2:enable='between(t,0,3)'`
              - **Example:** `hue=s=0:enable='between(t,10,12)'`
             - This is much safer and robust than boolean multiplication.
        
        Constraints:
        - Output JSON with a single key: "filter_string".
        - The value must be the RAW filter string ready to be passed to `-vf`.
        - OUTPUT MUST KEEP EXACT RESOLUTION AND ASPECT RATIO: {width}x{height}.
        - Do NOT output 1280x720 or 1080x1080 unless the input is exactly that.
        - IMPORTANT: Do NOT include the `-vf` flag itself, just the filter content.
        - IMPORTANT: Ensure syntax is correct for FFmpeg. 
        
        Output JSON:
        {{
            "filter_string": "..."
        }}
        """

        print("🤖 Asking Gemini for FFmpeg filter...")
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=[video_file_obj, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )
        
        print(f"🔍 DEBUG: Gemini Raw Response:\n{response.text}")

        try:
            # Clean response text (remove potential markdown blocks)
            text = response.text
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]
            
            if text.endswith("```"):
                text = text[:-3]
                
            text = text.strip()
            
            # Additional cleanup for potential trailing characters outside JSON
            # Find the first '{' and last '}'
            start_idx = text.find('{')
            end_idx = text.rfind('}')
            
            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx+1]
            
            print(f"🔍 DEBUG: Cleaned JSON Text:\n{text}")
                
            return json.loads(text)
        except json.JSONDecodeError:
            print(f"❌ Failed to parse JSON: {response.text}")
            return None

    def get_effects_config(self, video_file_obj, duration, fps=30, width=None, height=None, transcript=None):
        """Asks Gemini for a structured EffectsConfig JSON for Remotion rendering."""
        if width is None or height is None:
            width, height = 1080, 1920

        transcript_text = json.dumps(transcript) if transcript else "Not available."

        prompt = f"""
        You are an expert video editor analyzing a video and its transcript to generate dynamic visual effects for a Remotion-based renderer.

        Video Duration: {duration} seconds.
        Video FPS: {fps}
        Video Resolution: {width}x{height}

        TRANSCRIPT (Context of what is being said):
        {transcript_text}

        Your task is to produce a structured JSON describing time-based effect segments that cover the FULL video duration.

        Each segment has these fields:
        - "startSec" (number): Start time in seconds.
        - "endSec" (number): End time in seconds.
        - "zoom" (number): Zoom level. 1.0 = no zoom, max 1.5. Use subtle values like 1.05-1.2 for most cases.
        - "zoomCenterX" (number): Horizontal focus point for zoom, 0.0 (left) to 1.0 (right). 0.5 = center.
        - "zoomCenterY" (number): Vertical focus point for zoom, 0.0 (top) to 1.0 (bottom). 0.5 = center.
        - "brightness" (number): Brightness multiplier. 1.0 = normal. Range 0.8-1.2.
        - "contrast" (number): Contrast multiplier. 1.0 = normal. Range 0.8-1.3.
        - "saturate" (number): Saturation multiplier. 1.0 = normal. Range 0.8-1.3.

        Instructions:
        1. ANALYZE the video content and transcript to understand mood, pacing, and key moments.
        2. Apply CONTEXTUAL effects aligned with speech and action:
           - Use slow, subtle zooms toward the speaker's face during speaking moments.
           - Emphasize key moments, punchlines, or dramatic beats with slightly stronger zoom or contrast.
           - Keep transitions smooth — avoid jarring jumps between segments.
           - If nothing significant is happening, keep values at defaults (zoom 1.0, all multipliers 1.0).
        3. Segments MUST cover the entire video duration from 0 to {duration} seconds with no gaps.
        4. Prefer fewer, longer segments with gradual changes over many rapid short segments.
        5. Output ONLY valid JSON, no explanations.

        Output format:
        {{
            "segments": [
                {{
                    "startSec": 0,
                    "endSec": 3.5,
                    "zoom": 1.0,
                    "zoomCenterX": 0.5,
                    "zoomCenterY": 0.5,
                    "brightness": 1.0,
                    "contrast": 1.0,
                    "saturate": 1.0
                }}
            ]
        }}
        """

        print("🤖 Asking Gemini for Remotion effects config...")
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=[video_file_obj, prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json"
            )
        )

        print(f"🔍 DEBUG: Gemini Raw Response:\n{response.text}")

        try:
            # Clean response text (remove potential markdown blocks)
            text = response.text
            if text.startswith("```json"):
                text = text[7:]
            elif text.startswith("```"):
                text = text[3:]

            if text.endswith("```"):
                text = text[:-3]

            text = text.strip()

            # Find the first '{' and last '}'
            start_idx = text.find('{')
            end_idx = text.rfind('}')

            if start_idx != -1 and end_idx != -1:
                text = text[start_idx:end_idx+1]

            print(f"🔍 DEBUG: Cleaned JSON Text:\n{text}")

            return json.loads(text)
        except json.JSONDecodeError:
            print(f"❌ Failed to parse effects config JSON: {response.text}")
            return None

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
                model=self.model_name,
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
                model=self.model_name,
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

    @staticmethod
    def _split_filter_chain(filter_string: str) -> list[str]:
        """Split a -vf filter chain on commas, respecting single-quoted substrings."""
        parts: list[str] = []
        start = 0
        in_quote = False
        for i, ch in enumerate(filter_string):
            if ch == "'":
                in_quote = not in_quote
            elif ch == "," and not in_quote:
                parts.append(filter_string[start:i])
                start = i + 1
        parts.append(filter_string[start:])
        return parts

    @classmethod
    def _enforce_zoompan_output_size(cls, filter_string: str, width: int, height: int) -> str:
        """Force any zoompan filter to output the same geometry as the input clip."""
        parts = cls._split_filter_chain(filter_string)
        out_parts: list[str] = []
        for part in parts:
            if "zoompan=" in part:
                # Force s=WxH inside zoompan options (digitsxdigits only).
                if re.search(r":s=\d+x\d+", part):
                    part = re.sub(r":s=\d+x\d+", f":s={width}x{height}", part)
                else:
                    part = f"{part}:s={width}x{height}"
            out_parts.append(part)
        return ",".join(out_parts)

    @staticmethod
    def _sanitize_filter_string(filter_string: str) -> str:
        """
        Best-effort sanitizer for Gemini-generated FFmpeg expressions.
        Converts comparison operators (t<3, on>=75, etc.) into FFmpeg expr functions (lt(), gte(), ...),
        which are far more reliably parsed across FFmpeg builds.
        """
        s = filter_string

        # Order matters: handle >= / <= before > / <
        patterns: list[tuple[re.Pattern[str], str]] = [
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*>=\s*(-?\d+(?:\.\d+)?)"), r"gte(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*<=\s*(-?\d+(?:\.\d+)?)"), r"lte(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*>\s*(-?\d+(?:\.\d+)?)"), r"gt(\1,\2)"),
            (re.compile(r"(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*<\s*(-?\d+(?:\.\d+)?)"), r"lt(\1,\2)"),
        ]
        for pat, repl in patterns:
            s = pat.sub(repl, s)

        return s

    def apply_edits(self, input_path, output_path, filter_data):
        """Executes FFmpeg with the generated filter."""
        
        if not filter_data or "filter_string" not in filter_data:
            print("⚠️ No filter string found. Copying original.")
            subprocess.run(['ffmpeg', '-y', '-i', input_path, '-c', 'copy', output_path])
            return

        filter_string = filter_data["filter_string"]
        
        # Get input dimensions so we can enforce geometry (avoid broken aspect ratios).
        try:
            probe_cmd = ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', input_path]
            res_out = subprocess.check_output(probe_cmd, env={**os.environ, "LANG": "C.UTF-8"}).decode().strip()
            w, h = map(int, res_out.split('x'))
        except Exception as e:
            print(f"⚠️ Could not probe resolution: {e}")
            w, h = None, None

        # Sanitize common expression pitfalls (e.g., t<3 / on>=75) before executing FFmpeg.
        sanitized = self._sanitize_filter_string(filter_string)
        if sanitized != filter_string:
            print("🧼 Sanitized AI Filter (converted comparisons to lt/lte/gt/gte functions)")
            print(f"🧼 Before: {filter_string}")
            print(f"🧼 After:  {sanitized}")
            filter_string = sanitized

        # Enforce zoompan output size to preserve aspect ratio / resolution.
        if w and h:
            enforced = self._enforce_zoompan_output_size(filter_string, w, h)
            if enforced != filter_string:
                print(f"📐 Enforced zoompan output size to {w}x{h}")
                filter_string = enforced

            # Ensure square pixels (avoid weird display stretching in some players).
            if "setsar=" not in filter_string:
                filter_string = f"{filter_string},setsar=1"

        print(f"🎬 Executing AI Filter: {filter_string}")
        
        cmd = [
            'ffmpeg', '-y',
            '-i', input_path,
            '-vf', filter_string,
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-c:a', 'copy',
            output_path
        ]
        
        # Use explicit environment with UTF-8 to avoid ascii errors in subprocess
        env = os.environ.copy()
        # On some minimal docker images, we need to ensure we use a UTF-8 locale
        # Try C.UTF-8 first, fallback to en_US.UTF-8 if available, but C.UTF-8 is usually safer for minimal
        env["LANG"] = "C.UTF-8"
        env["LC_ALL"] = "C.UTF-8"
        
        try:
            # We must encode arguments if filesystem is ascii but we have unicode chars
            # But subprocess in Python 3 handles unicode args by encoding them with os.fsencode().
            # If sys.getfilesystemencoding() is ascii, this fails.
            # We can't change fs encoding at runtime easily.
            # Workaround: pass bytes directly? subprocess allows bytes in args.
            
            # Convert command elements to bytes assuming utf-8 if they are strings
            cmd_bytes = []
            for arg in cmd:
                if isinstance(arg, str):
                    cmd_bytes.append(arg.encode('utf-8'))
                else:
                    cmd_bytes.append(arg)
            
            subprocess.run(cmd_bytes, check=True, env=env)
        except subprocess.CalledProcessError as e:
            print(f"❌ FFmpeg failed: {e}")
            raise e

if __name__ == "__main__":
    pass