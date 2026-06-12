# Opus Clip — Product Reference

> Internal reference compiled from the official Opus help center (`help.opus.pro`) on 2026-06-11.
> Purpose: understand Opus Clip end-to-end so we can build feature parity (and beyond) in OpenShorts.
> Source index: `https://help.opus.pro/llms.txt`

---

## 1. What Opus Is (the big picture)

Opus is two distinct products under one brand:

| Product | What it does | Maps to OpenShorts |
|---------|--------------|--------------------|
| **OpusClip** | Turns existing **long-form video** into many short, vertical, captioned, social-ready clips. Repurposing/editing engine. | **Clip Generator** |
| **Agent Opus** | Creates **brand-new video from scratch** (script/audio/article/assets → fully produced video with AI visuals or AI UGC avatars). Generation engine. | **AI Shorts (UGC)** |

They are deliberately separate: OpusClip = *fragment & edit existing footage*; Agent Opus = *generate net-new footage*. OpenShorts already attempts to cover **both** sides plus a YouTube Studio.

The core OpusClip promise: **paste a link → get a stack of ranked, captioned, reframed 9:16 clips → edit → schedule/post → export.**

---

## 2. The OpusClip Pipeline (user-facing flow)

```
Set up (brand template, social accounts, team)
   ↓
Submit video (source + options: length, timeframe, prompt, aspect ratio, model)
   ↓
AI processing (transcribe → scene analysis → moment detection → reframe → caption)
   ↓
Results page (ranked clips w/ virality score, titles, transcripts)
   ↓
Editor (captions, layout, B-roll, voiceover, music, overlays, transitions, cleanup)
   ↓
Publish (schedule / bulk schedule / per-platform customize) OR export (HD / 4K / XML)
```

---

## 3. Two Clipping Models: ClipBasic vs ClipAnything

This is the single most important conceptual differentiator and the heart of Opus's moat.

### ClipBasic (legacy / transcript-driven)
- Works **only on talking-head / heavy-dialogue** video.
- Finds moments using **keywords that appear in the transcript**.
- Understanding is limited to **speaker positions**; relies solely on transcript.
- No sentiment, no narrative, no visual reasoning.

### ClipAnything (flagship / multimodal)
The "first multimodal AI clipping" model. Clips **any** moment from **any** video using **visual + audio + sentiment** cues — *including videos with little or no dialogue* (sports, vlogs, gameplay, news, music, B-roll).

Analyzes three dimensions:
- **Visual** — objects, scenes, actions, on-screen text within each frame.
- **Audio** — speakers + non-speech emotional sound (laughter, cheering, shouting, arguing), environmental sound, SFX.
- **Sentiment** — detects emotion and rates each scene's virality potential.

Accepts **natural-language prompts** (full sentences or keywords) to locate: scenes, actions, characters, events, emotional moments, viral topics, compilations. Does **deep multimodal, cross-scene reasoning**. Uses a **narrative library built with award-winning producers**.

| Capability | ClipBasic | ClipAnything |
|------------|-----------|--------------|
| Video types | Talking-head only | Vlogs, sports, TV, BTS, news, music, low-dialogue |
| Prompting | Transcript keywords only | Natural language sentences or keywords |
| Visual understanding | Speaker position only | Objects, colors, actions, text overlays |
| Audio | Transcript only | Speakers + emotional/environmental sound |
| Sentiment/narrative | None | Emotion analysis + narrative templates |
| Reasoning | None | Deep multimodal, cross-scene |

> **OpenShorts today** uses Gemini on the transcript = closer to ClipBasic. The big leap is **multimodal (visual+audio+sentiment) moment detection** like ClipAnything.

### Supporting concepts
- **Scene analysis** — breaks a video into individual scenes, each annotated with transcript, timestamps, visual summary, and emotional sentiment. This is the substrate the model reasons over.
- **Narrative template** — a storytelling structure the model follows when assembling a clip (hook → build → payoff, etc.). By default all suitable templates are enabled and the model auto-selects. Built "in collaboration with award-winning producers."
- **Reprompt & regenerate** — on the results page you can re-prompt the same source video repeatedly to get different cuts (cheap/free iteration).

---

## 4. Submitting a Video

### Supported sources
- **Social/streaming:** YouTube, Twitch, Facebook, LinkedIn, X, Rumble, Kick
- **Podcast:** Apple Podcast
- **Cloud:** Google Drive, Dropbox, Riverside
- **Hosting:** Vimeo, Loom, Frame.io, Medal.tv
- **Meetings/streaming tools:** Zoom, Zoom Clips, StreamYard
- **Direct:** public `.mp4` URLs, local upload (max 30 GB for Pro)
- Links must be **public or unlisted** (private fails).
- Also: upload your own **SRT** alongside the video; **auto-import** latest YouTube videos; live-stream uploads.

### Submission options (the "Submit Panel" / CoPilot)
- **Model:** ClipBasic vs ClipAnything.
- **Clip length:** default **Auto (0–3 min)**; dropdown for other ranges (e.g. <30s, 30–60s, 60–90s, etc.).
- **Specific timeframe:** process only a start→end window (up to 2 hrs) to save credits.
- **Prompt:** natural-language instruction for what to find (ClipAnything) or transcript keywords (ClipBasic).
- **Aspect ratio:** 9:16 (default), 1:1, 16:9.
- **Auto text-overlay hook:** ON by default — generates a one-line attention hook on the top ~10 clips.
- **Brand template:** apply branding/layout/caption presets to the whole project up front.
- **Submit without clipping** — process a single full video (no fragmentation).

### How many clips you get
Depends on **video length** and **model**:

| Source length | Clips |
|---------------|-------|
| 0–3 min | 1–2 |
| 3–10 min | 3–14 |
| 10–30 min | 5–21 |
| 30–60 min | 23–32 |
| 60–120 min | 32–42 |
| 120 min+ | 42–55 |

ClipAnything typically yields more than ClipBasic.

---

## 5. Virality Score

AI metric **0–99** predicting social success, assigned per clip. Evaluated on four pillars:
- **Hook** — does the opening grab attention and connect to the core message?
- **Flow** — logical progression with a satisfying resolution.
- **Value** — emotional resonance / audience connection.
- **Trend** — alignment with current viral trends & interests.
- (+ prompt-relevance check when using ClipAnything.)

Results auto-sorted high→low by score. Grid/List view toggle. (Pro/Starter only on Opus; not on free.)

> Strong differentiator vs. a plain "here are your clips" output. Worth replicating with a transparent scoring breakdown.

---

## 6. Results Page

Per clip: AI-generated **title + description** (social-optimized), **transcript**, **virality score**, **thumbnail**, built-in **editor** entry.

Controls:
- **Like/Dislike** — liked clips surface for scheduling; disliked hidden.
- **Sort** — by virality score or chronological position in source.
- **Filter** — user-defined criteria.
- **Export paths** — schedule to social, HD download, 4K download, XML export.
- Pro gets cloud storage of projects (still recommends local saves).

---

## 7. The Editor (feature-by-feature)

This is where OpusClip is deep. Timeline + text-based editing.

### Layout & Reframing
**7 auto layouts:**
1. **Fill** — crop speaker to fill the whole 9:16.
2. **Fit** — original cropped to 4:3 with padded bars top/bottom.
3. **Split** — two speakers stacked when both on screen.
4. **Three** — three speakers (panels/interviews).
5. **Four** — four speakers.
6. **Screenshare** — screen on top half, speaker bottom half (falls back if none detected).
7. **Gameplay** — 30% speaker top / 70% gameplay bottom (streamers).

Applied at **template / clip / per-segment** level. Multi-select segments (Cmd-click or drag) to batch-change. "Save and compile" reprocesses if AI framing is off.

### Subject Tracking
- **Automatic** — AI finds active speaker via voice + motion, follows gradually (no jarring jumps). Default.
- **Manual** — click "Tracker," click the subject to track; AI locks on; expandable selection box; different subjects per scene. Tracks **non-human** subjects too (products, animals, vehicles, text, hands, drone shots).

### Manual Reframe
Crop icon or double-click video → manual reframe window for precise framing.

### Captions & Emojis
- Edit by selecting word(s)/sentence(s) → Edit. Batch edits supported.
- Remove caption only, or delete caption + underlying video segment.
- **Word-level timing** via drag handles (bounded by max range).
- Add missing captions by editing the preceding word (auto re-times).
- **Styling** (Captions tab): font, size, color, stroke, shadow, text case, position (drag on canvas).
- **AI Emoji** — auto-inserts relevant emoji (toggle in AI Enhance); manual per-word emoji via Add menu.
- **Keyword highlighting** — emphasize key words.
- **Brand vocabulary** — teach correct spelling of proper nouns/brand terms (per-clip "Correct All" + save, or project-wide Asset Library list). Existing clips need reprocessing.
- **Subtitle translation** to another language; RTL & Hindi support noted.

### AI Enhance (audio/cleanup module)
- **Remove filler words** ("um", "uh", "like"…) — auto-detected.
- **Remove pauses/silences** — independently toggleable.
- **Speech enhancement** — noise reduction, voice isolation (separate track), volume balancing (Pro).
- **Auto censor** curse words — choose words; caption style asterisks `**` or dashes `--`; audio beeped/muted/untouched; revertible; Enterprise gets up to 5 custom word lists (Pro = defaults).

### Adding media & graphics
- **AI B-Roll** — contextual footage, **AI-generated** or **stock (Pexels** now; Storyblocks/Getty planned). Auto (toggle per clip), manual (highlight transcript → Add AI B-Roll), or keyword stock search. Drag/reframe/trim/move/regenerate (regenerate is free). Limits: Free/Starter 3 clips/day AI B-roll; Pro 50/day + unlimited stock.
- **AI Voiceover** — TTS, 20+ voices w/ preview; via "AI hook." Input script, pick voice, adjust tone stability + original-audio volume, generate. Editable/movable/deletable. Beta limits: 20/day, 2000 chars each. Use for hooks, commentary over silence, layered audio.
- **Add Music** — internal library (copyright-free + licensed), search/preview/favorites, or upload (mp3/m4a/ogg/wav, ≤30 min). Default vol 15%, adjustable, trim/split/layer multiple tracks.
- **Text Overlays** — up to **5 simultaneous** (each its own timeline track). Font/size/weight/color, word background color, box radius, width % (1–100). Drag to position, drag edges to time.
- **Auto Text-Overlay Hook** — one-line hook auto-generated on top ~10 clips, on by default, contextual to content.
- **Intro/Outro Cards** (Pro) — upload image/video, "Add as Intro/Outro" or drag to start/end placeholders.
- **Transitions** — 6 manual (cross fade, cross zoom, zoom in, zoom out, fade in, fade out) + **Auto Transitions** (detects jump cuts, applies automatically).

### Timeline editing
- **Trim & Extend** — drag segment boundaries; pull frames from original video beyond clip bounds.
- **Rearrange scenes** — drag to reorder segments in timeline.
- **Split clip** into 2 and download separately.
- **Duplicate clips.**
- **Snap editing** — magnetic alignment to segment boundaries, layout blocks, playhead, other layers; toggle via toolbar or **S**; guideline indicators; on by default.
- **Keyboard shortcuts** for precise editing.
- **Set custom thumbnail.**

---

## 8. Brand Templates & Setup

Set up **first** for consistency:
- **Brand template** — logo, custom fonts, caption style, layout prefs, colors; applied across all clips. (Free/Starter = 1 template; Pro = 2.)
- **Social accounts** — connect for direct posting.
- **Team workspace** — create team, name + logo, invite via link, owner manages members; credits shared across workspace.
- **Custom fonts & logo** upload.
- **Upload custom media assets** to an asset library.

---

## 9. Publishing & Distribution

- **Schedule clips** — from results page or a **social media calendar**; pick date/time, clips, platforms; AI-generated descriptions + hashtags. Cancel via Calendar tab.
- **Bulk Scheduler** (Pro) — queue many clips, assign order/position numbers, set start time + interval (every 2 hrs / daily); posts sequentially. **YouTube only for now** (others coming). Keeps running after app closed.
- **Per-platform post customization** — hashtags (TikTok shows trendiness/popular tags), Instagram collaborator tagging (public handles), AI titles/descriptions/hashtags (editable). iOS app supports editing before publish.
- **Link short → original long video** (drives traffic back).
- Direct platform connections: YouTube, Instagram (Business/Creator), Facebook, TikTok, X. Posting rate limits + ownership verification flows exist.

---

## 10. Export

- **HD download**; **4K download/post**.
- **XML export** → import into **Adobe Premiere Pro** and **DaVinci Resolve** (hand off to pro editors with cuts/captions intact).
- **Download transcripts & subtitles** of original video (SRT).
- **Bulk download.**

---

## 11. OpusSearch (video library search)

Separate "search your whole library" product:
- Indexes transcripts, topics, speakers, mood, key moments.
- Natural-language query by topic/phrase/person/emotional tone.
- Connect YouTube or upload; auto-imports new YouTube videos.
- Filters (People/Topics/Mood/Duration), sort by relevancy/recency.
- Trend detection across your library; team role-based access.
- **OmniSearch** (Ctrl/Cmd+K) global search; bulk select → export clips. Desktop only.

---

## 12. Agent Opus (generation engine — maps to OpenShorts "AI Shorts")

Transforms **scripts, blogs, podcasts, images, audio, or a topic prompt** into fully produced video. Key idea: it **"directs"** rather than stitches — proprietary **"Long Take"** technique morphs visuals between scenes (fluid) instead of hard cuts.

- **Inputs:** script, transcript, audio (mp3/wav), video, or concept prompt. Audio/video input ≤ 450 words / ~4 min.
- **Creation modes:** Script/Audio→Video, **AI UGC** (AI avatars + voice cloning), Assets→Ads, News/Article→Video, Motion Graphics (animated infographics).
- **Style library:** 12+ presets (Watercolor, Claymation, 2D Line, Animation, Blue Vox, Halftone, Pen & Ink, Schematic, Economic, Marcinelle, Claire, Vox) + custom style from image/text.
- **Assets:** upload ≤8 photos in 3 buckets — Objects (products), Actors (people), Logos — integrated into generated scenes.
- **Voiceover:** AI voice library, voice cloning (30s sample), or upload.
- **Aspect ratios:** 9:16, 16:9, 1:1.
- **Human-in-the-loop:** 5-min script-approval window, clarification prompts, **shot-level regeneration**, keyframe/motion editing.
- **Not for:** heavy editing, long-form cutting (that's OpusClip's job), paywalled content, photorealistic specific real people/places. Captions can't be added post-gen yet. <3 min recommended.

---

## 13. API (for completeness)

REST API (Pro Beta / Business). API key from dashboard. **1 credit = 1 minute** of processed video.
- Endpoints: Create Project, Get Clips, Edit Clips (trim/extend/captions), Social Posting (generate copy + publish/schedule/cancel), Brand Templates, Webhooks, Share Project, Transcripts, Collections, Censor jobs, Generative jobs (thumbnails).
- Limits: 30 req/min per key; concurrency 4 (Pro Beta) → 50 (Business); video ≤10 hrs, ≤30 GB.
- Webhooks for real-time processing notifications.

---

## 14. Credits / Pricing model

- **1 credit per minute** of imported original video (rounds: <1 min → 1; partial rounds down, e.g. 4.5 → 4).
- +1 credit per clip published **to X**.
- Plans (approx): Starter 150/mo, Pro 300/pack (stackable), Max 1,500/pack, Enterprise custom. Monthly credits expire 60 days; yearly 12 months.
- Limit by timeframe to save credits. Failed/deleted posts auto-refund.

---

## 15. Gap Analysis — OpenShorts today vs OpusClip

**OpenShorts already has** (per CLAUDE.md): YouTube/local ingest, faster-whisper transcription, PySceneDetect, Gemini moment detection, FFmpeg extraction, dual-mode vertical reframing (TRACK MediaPipe+YOLO / GENERAL blurred-bg), subtitles, hook overlay, ElevenLabs dubbing, S3 backup, Upload-Post social posting, AI Shorts (UGC), YouTube Studio.

### Biggest missing pieces (ranked by product impact)

| Priority | Feature | OpenShorts status | Notes |
|----------|---------|-------------------|-------|
| **P0** | **Multimodal moment detection (ClipAnything)** | Transcript-only (≈ClipBasic) | Add visual + audio + sentiment analysis, not just transcript. The core differentiator. |
| **P0** | **Virality score (0–99, Hook/Flow/Value/Trend)** | Missing | Ranks & sorts output; huge perceived value. Cheap to add on top of Gemini. |
| **P0** | **Real editor** (timeline + text-based) | Likely minimal | Captions/layout/trim/overlays editing UI is the product's center of gravity. |
| **P1** | **Caption styling + AI emojis + keyword highlight** | Basic subtitles | Animated/styled captions are table stakes for shorts. |
| **P1** | **Multiple auto layouts** (split/three/four/screenshare/gameplay) | Only TRACK/GENERAL | Multi-speaker & screenshare layouts. |
| **P1** | **Manual + click-to-track subject tracking** | Auto track only | User override of AI focus. |
| **P1** | **Filler-word / pause removal** | Missing | One-click pacing cleanup. |
| **P1** | **Result page w/ like-dislike, sort, reprompt** | Unknown | The hub UX. |
| **P2** | **AI B-Roll** (stock + generated) | Missing | Pexels integration is easy first step. |
| **P2** | **AI Voiceover (TTS hooks)** | Have dubbing, not TTS hooks | ElevenLabs TTS already in stack. |
| **P2** | **Add music library** | Missing | Licensed/free music + upload. |
| **P2** | **Transitions (auto + manual)** | Missing | FFmpeg filters already in editor.py. |
| **P2** | **Text overlays (multi-track)** | Single hook overlay | Up to 5 tracks. |
| **P2** | **Brand templates + brand vocabulary** | Missing | Consistency layer. |
| **P2** | **Speech enhancement / denoise** | Missing | |
| **P2** | **Auto censor curse words** | Missing | |
| **P3** | **Scheduling + bulk scheduler + per-platform copy** | Have posting, not scheduling | Calendar + queue. |
| **P3** | **XML export (Premiere/DaVinci)** | Missing | Pro-editor handoff. |
| **P3** | **More import sources** | YT/local only | Drive, Dropbox, Vimeo, Zoom, etc. |
| **P3** | **OpusSearch (library search)** | Missing | Bigger separate effort. |
| **P3** | **Custom thumbnails, intro/outro, snap editing, duplicate/split** | Missing | Editor polish. |

### Strategic takeaways for building OpenShorts
1. **The transcript-only → multimodal jump is the headline upgrade.** Everything Opus markets (ClipAnything, virality, narrative) rests on analyzing **frames + audio events + sentiment**, not just words. With Gemini 2.x multimodal (video understanding) this is now achievable in one model call per scene.
2. **Virality score is low-effort, high-perceived-value** — a structured Gemini rubric (Hook/Flow/Value/Trend → 0–99) on each candidate clip, then sort. Do this early.
3. **The editor is the product.** Opus's depth (captions, layouts, B-roll, overlays, cleanup, timeline) is the retention engine. OpenShorts needs a real web editor, not just a one-shot pipeline.
4. **Two engines, one app** — keep Clip Generator (OpusClip) and AI Shorts (Agent Opus) as distinct flows, which OpenShorts already does.
