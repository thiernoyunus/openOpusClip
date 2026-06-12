# OpenShorts Redesign — Agreed Scope

> Locked with the user on 2026-06-11, before starting the Opus-Clip-style dark redesign.
> Design system + screen teardown: see [opus-reference/ui-teardown.md](opus-reference/ui-teardown.md).
> Direction: **clone Opus Clip's look closely, dark theme** (shadcn zinc palette, Poppins+Geist, 6px radius, white primary CTA).

## Navigation / tools (current left rail → target)

Current tabs: Dashboard (Clip Generator), AI Shorts, AI Agent, UGC Gallery, YouTube Studio, [Gallery—disabled], Settings.

| Tool | Decision |
|------|----------|
| **Clip Generator** ("Create Viral Shorts", `dashboard`) | KEEP — primary tool |
| **AI Shorts** (UGC, `saasshorts`) | KEEP |
| **AI Agent** (`ai-agent`, Bot) | KEEP & restyle |
| **YouTube Studio** (`thumbnails`) | KEEP |
| **UGC Gallery** (`ugc-gallery`) | **REMOVE from nav** — hide only (leave component code in place, reversible) |
| **Gallery** (`gallery`) | already disabled — leave disabled |
| **Settings** | KEEP — Gemini + all API keys (fal.ai, ElevenLabs, Upload-Post) |

- **AI Shorts output**, now that UGC Gallery is hidden, lives **inline in the AI Shorts tab** (verify current code surfaces results there; adjust if it depended on UGCGallery).

## Homepage layout (adopt Opus structure)
- Compact **submit card** (center) → **feature-shortcut row** → **projects grid** below. Removes the current empty giant-hero.
- Feature-shortcut row = **our 3 tools** (Create Viral Shorts · AI Shorts · YouTube Studio), NOT Opus's 10 shortcuts.

## Submit card (keep + adapt, ref #1)
- KEEP (non-negotiable): **YouTube link drop + Upload**.
- KEEP: **Whisper model selector**.
- ADAPT: white primary CTA styling ("Generate Clips").
- ADD: inline **upload progress** state — "Uploading X% · N min left · Cancel".
- Optional: "Try a sample project" link (user's call, not committed).

## Processing / status / logs (adopt Opus, refs #2 & #3) — behavioral change
- ADD: project-card **progress overlay** — green "X% (ETA Nm)" pill on the thumbnail.
- REPLACE the current always-visible logs with Opus's **click-to-view pattern**: clicking the project/status opens a **"Your video is processing" modal** with terminal-style logs:
  `Fetching video "…"` → `Curation method: …` → `From 0:00:00 to 0:20:01, preferred clip length …` → `Estimated waiting time ~Nmin` → `Processing & analyzing… X%`, with a Close button.
- KEEP: **cost display** (credits/cost of processing a clip) — keep visible.

## Clip results & editing (keep, restyle only)
- KEEP & restyle (working fine): **hook overlay, subtitles, translate/voice-dub, scheduling**, and **cost** on results.
- Phase 2 additions (NOT in this redesign pass): virality score, Opus-style stacked action column, multi-clip ranked grid, real timeline editor, layouts, filler/pause removal, etc. (see parity gap in opusclip-reference.md).

## Out of scope for the redesign pass
- New AI capabilities (multimodal detection, virality scoring, editor) — those are separate feature work after the visual redesign.

## Build order (proposed)
1. Tailwind theme + fonts (zinc tokens, Poppins/Geist) — foundation.
2. App shell + left rail (restyle, hide UGC Gallery, active states).
3. **Homepage** (submit card + 3-tool shortcut row + projects grid) — first POC for approval.
4. Upload-progress + processing modal + card progress overlay (logs UX).
5. Results/clip view restyle (keep features).
6. AI Shorts / AI Agent / YouTube Studio / Settings restyle.
