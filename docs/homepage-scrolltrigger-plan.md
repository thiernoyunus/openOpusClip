# Homepage rebuild: GSAP ScrollTrigger "1 video → many clips" showcase

Self-contained build plan. Any model can implement this without reading the
conversation that produced it. Follow it top to bottom.

## Goal

Rework the existing landing page (`dashboard/src/Landing.jsx`) so the hero is an
Opus-Clip-style scroll-driven showcase: as the user scrolls, ONE long 16:9
podcast video visually "explodes" into a row of vertical 9:16 clips, each tagged
with a platform icon (YouTube, Instagram, LinkedIn, TikTok, Facebook, X) and a
real virality-score badge. Further scrolling reveals the app's features
(captions, reframing, virality score, trailer mode, dubbing) with light
scroll-in animations. All existing SEO content (features grid, FAQ, comparison
table, how-it-works) stays on the page below the new showcase — do not delete
it; it ranks.

The animation engine is **GSAP ScrollTrigger** (new dependency, explicitly
requested — `npm i gsap` inside `dashboard/`).

## What exists today (read these first)

- `dashboard/src/Landing.jsx` — current static landing page. Dark theme,
  Tailwind classes using tokens `bg-background`, `bg-surface`, `text-primary`
  (blue), gradient accents purple/pink. Sections in order: nav, hero (text + CTA
  buttons), stats bar, "3 tools in 1", features grid, API keys, how-it-works,
  tech stack, comparison table, use cases, FAQ, CTA, footer. A custom inline
  `TikTokIcon` SVG component already exists in this file; icons otherwise come
  from `lucide-react` (already installed).
- `dashboard/src/main.jsx` — hash routing: no hash → Landing, `#app` → main
  app, `#trailer` → trailer page, `#legal` → legal. `onLaunchApp` prop sets
  `#app`. Keep this contract.
- Stack: React 18 + Vite + Tailwind 3.4. No animation library installed yet.
- `dashboard/public/` — static assets served from `/` (logo, fonts, og-image).

## Setup (builder session)

```bash
git checkout main && git pull
git checkout -b feature/homepage-scrolltrigger
cd dashboard && npm i gsap
```

Dev server: use the `dashboard` entry in `.claude/launch.json` (port 5175), or
`cd dashboard && npm run dev`. Lint must pass: `npm run lint` (strict,
--max-warnings 0).

## Real assets to use (do NOT use stock placeholders)

We have a real processed job to showcase — a two-guest podcast (two sheikhs,
warm living-room set) that the pipeline cut into 15 scored clips.

- **16:9 source video**:
  `output/c298eed8-14ce-4c74-ada3-0a8bf398cbcf/In_Pursuit_of_Knowledge_–_Podcast_Series__Episode_1_Mufti_Muhammad_Ibn_Muneer.mp4`
- **9:16 generated clips** (already reframed vertical):
  `output/ec4a8e92-80ed-496a-9d53-0059cecb2680/In_Pursuit_of_Knowledge_…_clip_{N}.mp4`
  (N = 1..15; `_source.mp4` files are the un-reframed cuts — ignore those)
- **Real virality scores** (from that job's `result.json`, clip index → score):
  clip_1 → 95, clip_2 → 90, clip_3 → 88, clip_4 → 85, clip_5 → 82, clip_6 → 80.
  Use these six for the six platform cards (YouTube 95, Instagram 90,
  LinkedIn 88, TikTok 85, Facebook 82, X 80). Authentic numbers > invented ones.

Produce web-ready derivatives into `dashboard/public/landing/` (create dir).
Keep the page light: **one playing video (the 16:9 source loop) + six static
poster frames** for the clip cards. Do not ship six autoplaying videos.

```bash
mkdir -p dashboard/public/landing
S="output/c298eed8-14ce-4c74-ada3-0a8bf398cbcf/In_Pursuit_of_Knowledge_–_Podcast_Series__Episode_1_Mufti_Muhammad_Ibn_Muneer.mp4"
# 6s muted 720p hero loop from a lively moment (adjust -ss after eyeballing)
ffmpeg -y -ss 00:12:00 -t 6 -i "$S" -vf scale=1280:-2 -an -c:v libx264 -crf 26 -preset veryfast -movflags +faststart dashboard/public/landing/source-loop.mp4
ffmpeg -y -ss 00:12:00 -i "$S" -frames:v 1 -vf scale=1280:-2 dashboard/public/landing/source-poster.jpg
# Poster frame per clip card (pick a frame where a face is big and clear)
C="output/ec4a8e92-80ed-496a-9d53-0059cecb2680"
for n in 1 2 3 4 5 6; do
  f=$(ls "$C" | grep "clip_${n}.mp4$")
  ffmpeg -y -ss 2 -i "$C/$f" -frames:v 1 -vf scale=540:-2 "dashboard/public/landing/clip-${n}.jpg"
done
```

Eyeball every extracted frame (Read tool renders images). Re-pick `-ss` for any
frame that caught a blink/blur. Target: total added assets < 4 MB.

## The scroll showcase (the core of this task)

Reference look (Opus Clip homepage): a floating 16:9 source video sits above a
pill-shaped input bar ("Drop a long video and …" + dark "Get clips" button);
below/after, a row of six 9:16 clip cards, each with a circular platform icon
overlapping its top edge and a "SCORE ▸ 97"-style badge in its bottom-left
corner. Clips have rounded corners (~12-16px), subtle shadow, sit on a dark
radial-gradient stage.

### Structure

New component `dashboard/src/components/landing/ClipShowcase.jsx` (one file),
rendered by `Landing.jsx` directly under the hero text. Layout:

```
<section ref={stageRef}>            // ~300vh tall wrapper (scroll runway)
  <div className="sticky-stage">    // pinned by ScrollTrigger, h-screen
    <video 16:9 source loop />      // centered, ~min(60vw, 720px)
    <div input-bar mock />          // pill: link icon + "Drop a long video and…" + [Get clips] → onLaunchApp
    <div clip-card ×6 />            // absolutely positioned, start hidden behind source
  </div>
</section>
```

Each clip card: poster `<img>`, platform icon in a colored circle half-overlapping
the top edge, score badge bottom-left (`SCORE` label + big green number),
rounded-2xl, ring-1 ring-white/10, shadow-xl.

### Timeline (one gsap.timeline, `scrub: 1`, `pin: true`)

Phase A (0 → 0.25): source video alone, centered, playing. Input bar visible
under it. Slight scale 1 → 0.92 as scroll starts (signals "something's coming").

Phase B (0.25 → 0.65): the explosion. Six cards animate FROM the source's
center (`scale: 0.25, opacity: 0, y: 0`) TO a fanned row beneath/around it
(`scale: 1, opacity: 1`, x offsets spread evenly, slight alternating rotation
-4°..+4°, `stagger: 0.06`). Source simultaneously shrinks toward the top
(`scale → 0.55, y → -20vh`). Ease: `power3.out` feel via scrub.

Phase C (0.65 → 1.0): score badges pop in on each card (`scale 0 → 1`,
`back.out(1.7)`, stagger), platform icons drop in, then a headline line fades in
under the row ("One long video. A week of content.") + "Get clips" CTA pulses
once. Hold to end of runway.

Implementation rules:
- `gsap.registerPlugin(ScrollTrigger)` once at module top.
- All setup inside `useLayoutEffect` with `const ctx = gsap.context(() => {...}, stageRef)`
  and `return () => ctx.revert()` — this is the React-safe pattern; no leaks on
  hash navigation to `#app`.
- Animate ONLY `transform` and `opacity`. Never top/left/width.
- `gsap.matchMedia()`:
  - `(prefers-reduced-motion: reduce)` → no pin, no scrub; render the final
    state statically (source small on top, row of six cards visible).
  - `(max-width: 767px)` → same static final state, cards in a 3×2 grid or a
    horizontally scrollable row (`overflow-x-auto snap-x`). Pinned 300vh scroll
    theater on a phone is punishment, not delight.
- Pause the hero `<video>` when the section leaves the viewport
  (`onToggle: self => video[self.isActive ? 'play' : 'pause']()`).
- Video attrs: `muted playsInline loop autoPlay preload="metadata" poster=…`.

### Feature sections below the showcase

After the showcase, upgrade the EXISTING sections with light scroll reveals —
do not rebuild their content:
- Wrap section headers/cards with a tiny helper (`Reveal`, same file as
  ClipShowcase or inline in Landing.jsx): `gsap.from(el, {opacity: 0, y: 24,
  duration: 0.6, scrollTrigger: {trigger: el, start: 'top 85%'}})` via
  `ScrollTrigger.batch` for card grids (stagger 0.08).
- That's it. No pinning below the hero. One pinned section per page is the
  taste ceiling; two is a carnival.

Insert ONE new section directly after the showcase, "What the AI does to every
clip", as three cards using the real assets: (1) AI captions — use
`clip-1.jpg` (it shows burned captions with a yellow highlight word), (2) AI
reframe — side-by-side 16:9 poster → 9:16 poster of the same moment,
(3) Virality score — mini scoreboard listing the six real titles + scores from
the job. Copy for these already exists in the features array — reuse/trim it.

### Hero copy change

Keep the H1/SEO structure but tighten the hero: headline stays
"Free Open Source Clip Generator" (SEO), swap the paragraph for one line —
"Drop one long video. Get a week of scored, captioned, vertical clips — free,
on your own machine." The input-bar mock in the showcase becomes the primary
CTA (clicking it or "Get clips" calls `onLaunchApp`). Keep the GitHub button.

## Acceptance criteria

1. `npm run lint` passes; page loads at `/` with no console errors.
2. Scrolling pins the stage and plays the explosion smoothly (no layout shift,
   no scroll jank; transforms only — verify with devtools performance overlay
   spot-check).
3. `#app`, `#trailer`, `#legal` routing still work; navigating away and back
   doesn't stack duplicate ScrollTriggers (ctx.revert works — check
   `ScrollTrigger.getAll().length` stays constant across two mounts).
4. Reduced-motion and <768px show the static final composition; nothing pins.
5. Six cards show real posters, correct platform icons (YouTube, Instagram,
   LinkedIn, TikTok, Facebook, X — TikTok/X SVGs: TikTok one already exists in
   Landing.jsx; add a minimal X svg inline), and the real scores 95/90/88/85/82/80.
6. All prior sections (features, FAQ, comparison, how-it-works, footer) still
   present and readable.
7. Added assets in `dashboard/public/landing/` total < 4 MB.

## Verification workflow (builder must do, not ask the user)

1. `preview_start` the `dashboard` server.
2. `preview_eval` `window.scrollTo(...)` through the runway in steps; take
   `preview_screenshot` at: top (phase A), mid-explosion (phase B), settled row
   (phase C), and one feature section.
3. `preview_console_logs` — zero errors.
4. `preview_resize` to mobile (375×812) → confirm static fallback renders.
5. Share the screenshots as proof.

## Out of scope (deliberately)

- No Lottie/three.js/Framer Motion — GSAP only.
- No autoplaying video per clip card (posters only) — revisit only if the page
  feels dead after review.
- No CMS/copy rewrite of FAQ/comparison sections.
- No new routes; landing stays the default no-hash view.

## Notes for the builder

- The repo owner is a non-engineer: write the PR description in plain language
  (what was slow/broken → what changed → what they'll notice), per the global
  CLAUDE.md rules.
- Commit the extracted jpg/mp4 assets (they're small and the page needs them);
  the `output/` job dirs they came from are gitignored scratch — never
  reference `output/` paths at runtime.
## Opus.pro observations (live scrape via Codex, 2026-07-03)

Ground-truth notes from the actual opus.pro homepage, to steal the vibe from:

- Hero: dark page, small label "#1 AI VIDEO CLIPPING TOOL", headline
  **"1 long video, 10 viral clips. Create 10x faster."** Centered "Drop a video
  link" input bar with a "Get free clips" button; "See demos" / "Upload files"
  secondary options.
- Showcase: 16:9 source video on top, rounded input bar ("Drop a long video
  and…" + "Get clips"), row of 9:16 clips beneath with platform icons
  (YouTube, Instagram, LinkedIn, TikTok, Facebook, X) and neon-green score
  badges (97/99/95/98/93/97). **On Opus it is a static AVIF image, not an
  animation** — our scroll-driven version deliberately one-ups it.
- Feature section order on Opus: AI clipping → AI captioning → AI reframe →
  AI B-roll → AI audio enhance → AI voice-over, each demoed with a static
  image. Then social proof ("16M+ creators"), models, teams.
- Palette: black/charcoal background, white text, gray rounded input surfaces,
  black/white CTA contrast, **neon-green score numbers**, colorful platform
  icons.

Apply to our page: keep our existing dark token palette but adopt the
neon-green score numbers on the badges, the black-pill input bar with a
high-contrast "Get clips" button, and mirror the headline pattern with our real
numbers — this job genuinely produced 15 clips, so:
**"1 long video, 15 viral clips."** as the showcase headline
(hero H1 stays the SEO title).
