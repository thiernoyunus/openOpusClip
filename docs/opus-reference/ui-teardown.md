# Opus Clip — UI Teardown & Design System

> Captured live from `clip.opus.pro` (logged-in account) on 2026-06-11 via browser automation.
> Tokens below are **real values pulled from the running app** with `getComputedStyle`, not eyeballed.
> Goal: clone Opus Clip's UI closely, **dark theme**, for the OpenShorts dashboard.
>
> Note: raw PNGs couldn't be exported to disk (the browser screenshot tool keeps them server-side),
> so this doc + the extracted tokens ARE the durable reference. Screens were reviewed visually in-session.

---

## 1. Design System (extracted real values)

Opus is built on the **shadcn/ui "zinc" dark palette** with a two-font system. This is the single most
important takeaway: we can reproduce it almost exactly with Tailwind + the zinc scale.

### Color tokens (exact, from the live app)

| Role | Value | Hex | Notes |
|------|-------|-----|-------|
| App background (dashboard) | `rgb(14,16,21)` | `#0E1015` | slightly blue-black |
| Canvas / deepest bg (editor) | `rgb(9,9,11)` | `#09090B` | zinc-950 |
| Surface / card | `rgb(24,24,27)` | `#18181B` | zinc-900 |
| Raised surface / secondary button | `rgb(39,39,42)` | `#27272A` | zinc-800 |
| Border / divider | `rgb(39,39,42)` | `#27272A` | zinc-800 (borders are subtle) |
| Hover surface | `rgb(47,47,47)` | `#2F2F2F` | ~zinc-800/750 |
| Text primary | `rgb(250,250,250)` | `#FAFAFA` | zinc-50 |
| Text high-contrast (on white btn) | `rgb(24,24,27)` | `#18181B` | zinc-900 |
| Text muted | `rgb(155,158,163)` | `#9B9EA3` | ~zinc-400 |
| Text very muted | `rgba(255,255,255,0.5)` | — | 50% white |
| **Primary CTA** | `rgb(250,250,250)` | `#FAFAFA` | **white button, dark text** ("Export", "Get clips in 1 click") |
| Keyword highlight (transcript) | green | ~`#3DD68C` | AI-detected keywords shown green in transcript |

**Key insight:** the primary action button is **white with near-black text** (not a colored accent).
Color in the UI comes from small accent icons (the feature shortcuts each have their own gradient icon),
not from large colored surfaces. The chrome is almost entirely greyscale zinc. This is what makes it look
premium and calm rather than the "muted indigo everywhere" look our current app has.

### Typography

| Use | Font | Notes |
|-----|------|-------|
| Display / big headings | **Poppins** | bold, e.g. the dashboard wordmark/hero |
| UI / body / buttons | **Geist Sans** | `__GeistSans_*` — all controls, labels, transcript |
| Fallback stack | Avenir, Roboto, PingFang SC, Helvetica, Arial, sans-serif | |

Sizes seen: buttons 12–14px, transcript 12–16px, labels 12px. Weights: 400 body, 500 buttons/labels.

### Shape & spacing

- **Border radius: 6px** on buttons/inputs/cards (some inner chips 4px). Consistent, restrained — not pill-shaped.
- Buttons: `padding: 0 12px`, height ~32–36px, icon + label, 12–14px text.
- Borders are 1px `#27272A`, very low contrast — surfaces are separated by background-shade steps, not strong lines.
- Generous but not wasteful spacing; the editor is dense and information-rich.

### Ready-to-use Tailwind theme (drop-in starting point)

```js
// tailwind.config.js (extend)
theme: {
  extend: {
    colors: {
      bg:        '#0E1015',  // app background
      canvas:    '#09090B',  // deepest (editor canvas)
      surface:   '#18181B',  // cards/panels (zinc-900)
      surface2:  '#27272A',  // raised / secondary btn / border (zinc-800)
      hover:     '#2F2F2F',
      border:    '#27272A',
      fg:        '#FAFAFA',   // primary text
      muted:     '#9B9EA3',   // secondary text
      accent:    '#3DD68C',   // keyword/positive green (use sparingly)
    },
    borderRadius: { DEFAULT: '6px' },
    fontFamily: {
      display: ['Poppins', 'sans-serif'],
      sans: ['Geist Sans', 'Avenir', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
    },
  },
}
```
(Equivalent to: use Tailwind's `zinc` scale — `zinc-950/900/800/400/50` — plus white primary buttons.)

---

## 2. Screen: Dashboard / Home  (`/dashboard`)

**Layout:** thin left icon rail · large centered content · everything on `#0E1015`.

- **Left rail (icon-only, ~64px):** collapse-chevron at top; profile avatar w/ dropdown; "add team" icon;
  then primary nav (Home [active], Create/grid-plus, Folder/projects, Calendar/scheduler, Chart/analytics,
  Link/connections); bottom cluster (crown/upgrade, database/storage, book/docs, help/?). Active item has a
  subtle highlighted background. **No text labels** — we should consider adding labels or tooltips.
- **Top bar (right-aligned):** notifications bell w/ red count badge · credits pill (`⚡ 40`) · "Add more credits" button.
- **Free-plan banner:** centered pill "You are using the Free Plan… watermark and limited features." + dark "Upgrade" button.
- **Submit card (hero, centered, ~480px wide):** a `#18181B` card containing:
  - URL input with link icon, rotating placeholder ("Drop a YouTube link" → "Drop a Rumble link" → "Drop a Zoom link" …) — cycles through supported sources.
  - Two secondary actions: "⬆ Upload" and "Google Drive".
  - Full-width **white** primary button: "Get clips in 1 click".
  - Behind the card: a huge faint "OpusClip" wordmark watermark in the background (Poppins, very low opacity).
- **Feature shortcut row (10 items):** circular gradient icon + label, some with a "New" tag:
  Long to shorts · AI Captions · Video editor · Enhance speech (New) · AI Sound Effect (New) ·
  AI Reframe · AI B-Roll · AI hook · Upscale (New) · Script to video (New).
  → This is a smart pattern: surfaces every capability as a one-click entry point. Our app hides these.
- **Projects section:** tabs "All projects (N)" / "Saved projects (N)"; right side shows storage "0 GB / 0 GB",
  "Auto-save" toggle, "Auto-import (Beta)" toggle. Below: a grid of project cards.
- **Project card:** 16:9 thumbnail with plan badge ("Free Plan") + optional "New" tag overlaid top corners;
  "2 days before expiring" overlay bottom; title below (e.g. "AI Company.mp4"); model label ("ClipBasic"); "…" menu.
- Bottom-right floating "Questions?" help button (persists across screens).

---

## 3. Screen: Project / Clip detail (results)  (`/clip/{id}`)

For single-clip projects this shows one clip; for multi-clip it's a grid (see §3b). Layout: left rail persists ·
center video preview · right action column.

- **Top bar:** project title (left) · centered search "Find keywords or moments… ⌘K" · notifications · credits · Add credits.
- **Sub-header:** "Original clips" title · count "Original clips (1)" · right-side controls: **Select**, **Filter**,
  sort icon, upload icon, "…" overflow.
- **Center:** like / dislike buttons (top-left of preview) · 9:16 (or source-ratio) video preview · below it the
  clip title · a "Transcript" section (CC icon) with the full transcript text in muted color.
- **Right action column (stacked buttons):**
  - Primary group: **Publish on Social** · **Export XML** (Premiere icon) · **Download HD** · **Download 4K** 👑
    (plan-gated) · **Upscale & download** (`⚡1129` credit cost shown inline).
  - Edit group: **Edit clip** (opens editor) · **AI hook** · **Enhance speech** · **Add B-Roll** · aspect chip "16:9" · **Duplicate**.
  - Each button: `#27272A` bg, small colored leading icon, 12px label, 6px radius.
- Bottom-right: "Remove watermark" (white) + "Questions?".

### 3b. Multi-clip results grid (virality scores) — NOT captured
Our account's existing projects were single "Original clips," so the signature **ranked clip grid with
Virality Scores (0–99)** didn't render (it requires generating clips, which costs credits). From docs (see
`opusclip-reference.md`): clips shown as cards sorted high→low by virality score, Grid/List toggle, each card
shows score badge + AI title + thumbnail + like/dislike. **We still need a real screenshot of this** — either
generate one clip in Opus, or pull the public help-center image. Flagging as the one gap.

---

## 4. Screen: Editor  (`/editor-ux/{id}`)  ★ most important

The deepest, densest screen. Four regions: **left transcript · center canvas · right icon rail · bottom timeline.**

- **Top bar:** ‹ back · project title · undo / redo · keyboard-shortcuts icon · **Save changes** (`#27272A`) ·
  **Export** (white primary) · credits (`⚡40`) · avatar.
- **Left panel (~37% width) — transcript / text-based editing:**
  - "Speech cleanup" pill button (top-left) · search · filter · download icons.
  - "+ Extend a clip" button.
  - The full **editable transcript**. Words carry inline **timing pills** (e.g. `0.44s`, `1.28s`) and AI
    **keyword highlights in green** (e.g. *civilizations, hubris, nemesis*). You edit the video by editing this text.
- **Center — canvas/preview:**
  - Control strip above canvas: aspect chip "📱 9:16" · "Layout: Fit" (dropdown) · "Tracker: OFF".
  - 9:16 preview with **reframe selection box** (corner + edge handles) and a floating mini-toolbar (crop icon ·
    image/replace icon · dropdown).
- **Right rail (icon + label, vertical):** **AI enhance · Captions · Media · Brand template · B-Roll ·
  Transitions · T (Text)**. Clicking one slides out a settings panel to its left (see §4a/§4b).
- **Bottom — timeline (full width):**
  - Controls: "Hide timeline" · split · trash · frame/fit icon.
  - Transport (centered): skip-back · play · skip-forward · timecode `00:00.00 / 20:06.08`.
  - Zoom slider (− …… +) on the right.
  - Ruler with frame/second ticks (0, 100, 200 …).
  - Track label ("Fit") · **filmstrip thumbnail row** · **audio waveform row** beneath.
  - "+" add-track/media button far left.

### 4a. Captions panel (right rail → Captions)
- Tabs: **Presets · Font · Effects**.
- **Presets** = 2-column grid of style cards, each rendering a live caption preview:
  "No captions", "Karaoke", "Beasty", "Deep Diver", + more (varied highlight colors, e.g. magenta/white
  word-by-word highlight styles). This is the animated-caption-template picker.

### 4b. AI enhance panel (right rail → AI enhance)
Header "AI enhance", then a list (icon + label, some with toggles):
- **Remove filler words**
- **Remove pauses**
- **Auto censor**
- **Speech enhancement** (toggle)
  - ↳ Auto Generate AI B-Roll
  - ↳ Auto generate stock B-Roll
  - ↳ Auto generate AI hook
- **AI emoji** (toggle)

### 4c. Layout dropdown (center → "Layout: Fit")
"Global layout settings ›" + "Current layout" radio list with icons:
**Fill · Fit (✓) · Split · Three · Four · ScreenShare · Gameplay** — matches the 7 documented auto-layouts.

---

## 5. Component inventory (what we need to build to match)

| Component | Opus behavior |
|-----------|---------------|
| Icon rail nav | 64px, icon-only, active = subtle bg highlight, top + bottom clusters |
| Submit card | card + rotating-source URL input + Upload/Drive + white CTA + bg wordmark |
| Feature shortcut chips | circular gradient icon + label + optional "New" tag, horizontal row |
| Project card | 16:9 thumb, corner badges, expiry overlay, title, model label, "…" menu |
| Credits pill / banner | `⚡N` pill, free-plan banner with Upgrade |
| Action button (secondary) | `#27272A`, leading colored icon, 12px, 6px radius |
| Primary button | **white bg, #18181B text**, 6px radius |
| Right-rail settings panels | slide-out panel, header + list/grid, tabs where needed |
| Caption preset card | live-preview tile in a 2-col grid |
| Toggle rows | label + right-aligned switch (AI enhance list) |
| Timeline | filmstrip + waveform tracks, ruler, transport, zoom slider |
| Search w/ ⌘K | centered top-bar omnisearch |

---

## 6. Direct implications for our redesign

1. **Adopt the zinc dark palette + white primary buttons** verbatim (tokens in §1). Drop the muted-indigo-everywhere look.
2. **Two fonts:** Poppins (display) + Geist Sans (UI). Both are free/Google-hostable.
3. **6px radius everywhere**, 1px `#27272A` borders, separate surfaces by shade not by heavy lines.
4. **Fill the empty hero** on our Clip Generator screen with Opus's pattern: compact submit card + feature
   shortcut row + projects grid below — instead of a giant title in dead space.
5. **Give the left rail polish** (active states, tooltips/labels, top+bottom clusters).
6. **Build the editor toward Opus's 4-region layout** (transcript · canvas · icon rail · timeline) — this is the
   biggest structural gap and the highest-value screen, but also the largest effort; stage it after the
   dashboard + results reskin.
7. Still **need the multi-clip virality-grid reference** (the one screen we couldn't capture) before building
   the results page faithfully.
