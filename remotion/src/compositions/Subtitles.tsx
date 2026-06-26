import React, { useCallback, useEffect, useState } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  delayRender,
  continueRender,
} from "remotion";
import type { SubtitleConfig, SubtitleStyle } from "../lib/types";
import { groupCaptionsIntoBlocks, getActiveWordIndex } from "../lib/captions";
import { dominantDir } from "../lib/rtl";
import { getFontStack, captionFontFaces, BUNDLED_CAPTION_FONTS } from "../lib/fonts";
import { getCaptionTemplate, resolveTemplateId } from "../lib/captionTemplates";

interface SubtitlesProps {
  config: SubtitleConfig;
}

const POSITION_MAP: Record<string, React.CSSProperties> = {
  top: { top: "12%", bottom: "auto" },
  middle: { top: "45%", bottom: "auto" },
  bottom: { bottom: "10%", top: "auto" },
};

// Drop-shadow size presets (offsetY/blur in px). Applied as a CSS `filter` on the
// whole caption block, so it layers over every template uniformly without touching
// any per-word renderer. `none`/undefined → no filter.
const SHADOW_MAP: Record<string, { oy: number; blur: number }> = {
  small: { oy: 2, blur: 4 },
  medium: { oy: 4, blur: 10 },
  large: { oy: 8, blur: 20 },
};

/**
 * Combined CSS `filter` for the caption block: an optional drop-shadow preset
 * plus an optional glow halo. Both layer over every template uniformly without
 * touching any per-word renderer. Returns undefined when neither is set.
 */
function blockFilter(style: SubtitleStyle): string | undefined {
  const parts: string[] = [];

  const preset = style.shadow && SHADOW_MAP[style.shadow];
  if (preset) {
    const color = style.shadowColor ?? "#000000";
    parts.push(`drop-shadow(0 ${preset.oy}px ${preset.blur}px ${color})`);
  }

  if (style.glow) {
    const color = style.glowColor ?? "#FFFFFF";
    // Map intensity 0–100 to a font-size-relative blur so the glow reads the
    // same across caption sizes. Two stacked shadows give a denser halo.
    const intensity = style.glowIntensity ?? 30;
    const blur = (intensity / 100) * (style.fontSize ?? 56) * 0.5;
    parts.push(`drop-shadow(0 0 ${blur.toFixed(1)}px ${color})`);
    parts.push(`drop-shadow(0 0 ${(blur / 2).toFixed(1)}px ${color})`);
  }

  return parts.length ? parts.join(" ") : undefined;
}

// Above/below emojis are tied to the caption LINE, not a single word: every
// emoji in the on-screen block shows centered above (or below) the line for the
// block's full duration, so the viewer actually has time to register it. The row
// container handles placement; each item handles size + entrance animation.
function emojiRowStyle(
  style: SubtitleStyle,
  placement: "above-word" | "below-word"
): React.CSSProperties {
  // Gap between the emoji row and the caption line, scaled to the caption size.
  const gap = (style.emojiGap ?? 0.2) * style.fontSize;
  const isAbove = placement === "above-word";
  return {
    position: "absolute",
    left: "50%",
    transform: "translateX(-50%)",
    ...(isAbove ? { bottom: "100%", marginBottom: gap } : { top: "100%", marginTop: gap }),
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: `${Math.round(style.fontSize * 0.15)}px`,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: 2,
  };
}

function emojiItemStyle(
  style: SubtitleStyle,
  placement: "above-word" | "below-word",
  animation: NonNullable<SubtitleStyle["emojiAnimation"]>,
  frame: number,
  fps: number
): React.CSSProperties {
  const size = style.emojiSize ?? 1;
  // Entrance is anchored to the block start (frame 0 of the block Sequence) so
  // every emoji is up for the whole time the caption line is on screen.
  const introFrames = Math.max(1, Math.round(0.25 * fps));
  const p = interpolate(frame, [0, introFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const isAbove = placement === "above-word";
  const normalized = animation === "pop" ? "pop-in" : animation === "bounce" ? "bounce-in" : animation;
  const popScale =
    normalized === "pop-in" || normalized === "scale" || normalized === "bounce-in" || normalized === "bounce-in-wiggle"
      ? 0.45 + p * 0.65
      : 1;
  // Bounce/float away from the caption line: up when above, down when below.
  const dir = isAbove ? -1 : 1;
  const bounceY =
    normalized === "bounce-in" || normalized === "bounce-in-wiggle"
      ? dir * Math.sin(p * Math.PI) * style.fontSize * 0.18
      : 0;
  const floatY = normalized === "float" ? dir * Math.sin(frame / 6) * style.fontSize * 0.06 : 0;
  const slideDistance = style.fontSize * 0.65 * (1 - p);
  const slideX =
    normalized === "slide-right"
      ? -slideDistance
      : normalized === "slide-left"
        ? slideDistance
        : normalized === "slide-bottom-right" || normalized === "slide-diagonal-bottom-right"
          ? -slideDistance
          : normalized === "slide-top-right" || normalized === "slide-diagonal-top-right"
            ? -slideDistance
            : normalized === "slide-diagonal-bottom-left" || normalized === "slide-diagonal-top-left"
              ? slideDistance
              : 0;
  const slideY =
    normalized === "slide-up"
      ? style.fontSize * 0.65 * (1 - p)
      : normalized === "slide-up-down"
        ? // rises from below, overshoots past the rest point, then settles
          style.fontSize * (0.65 * (1 - p) - Math.sin(p * Math.PI) * 0.25)
      : normalized === "slide-down"
        ? -style.fontSize * 0.65 * (1 - p)
        : normalized === "slide-bottom-right" || normalized === "slide-diagonal-bottom-right" || normalized === "slide-diagonal-bottom-left"
          ? -slideDistance
          : normalized === "slide-top-right" || normalized === "slide-diagonal-top-right" || normalized === "slide-diagonal-top-left"
            ? slideDistance
            : 0;
  const wiggle = normalized === "bounce-in-wiggle" ? Math.sin(p * Math.PI * 4) * 10 * (1 - p) : 0;
  const rotate = normalized === "rotate" ? 360 * p : wiggle;

  return {
    display: "inline-block",
    fontSize: Math.round(style.fontSize * 0.82 * size),
    lineHeight: 1,
    opacity: normalized === "none" ? 1 : p,
    transform: `translate(${slideX.toFixed(1)}px, ${(slideY + bounceY + floatY).toFixed(1)}px) rotate(${rotate.toFixed(1)}deg) scale(${popScale.toFixed(3)})`,
    // Scale grows away from the caption line (bottom edge when above, top when below).
    transformOrigin: isAbove ? "center bottom" : "center top",
    WebkitTextStroke: "none",
    textShadow: "none",
    filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.5))",
  };
}

function easeProgress(frame: number, frames: number): number {
  return interpolate(frame, [0, Math.max(1, frames)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
}

function captionMotion(
  animation: NonNullable<SubtitleStyle["captionAnimation"]>,
  style: SubtitleStyle,
  frame: number,
  fps: number,
  durationFrames: number,
  rtl: boolean
): { opacity?: number; transformParts: string[]; innerStyle?: React.CSSProperties } {
  const intro = Math.min(durationFrames, Math.max(1, Math.round(0.42 * fps)));
  const p = easeProgress(frame, intro);
  // "-out" presets are EXITS: stay fully visible until the block's tail, then
  // animate out. ep is 0 for most of the block and ramps 0->1 over the last
  // ~0.42s. (Treating them as entrances previously left the caption invisible.)
  const exitFrames = Math.min(durationFrames, Math.max(1, Math.round(0.42 * fps)));
  const ep = easeProgress(frame - (durationFrames - exitFrames), exitFrames);
  const dir = rtl ? -1 : 1; // flip horizontal slides for RTL
  const transformParts: string[] = [];
  let opacity: number | undefined = 1;
  const innerStyle: React.CSSProperties = {};

  switch (animation) {
    case "none":
      return { opacity: 1, transformParts };
    case "show-in":
      opacity = frame <= 1 ? 0 : 1;
      break;
    case "fade":
    case "fade-in":
      opacity = p;
      break;
    case "fade-out":
      opacity = 1 - ep;
      break;
    case "pop-in":
      opacity = p;
      transformParts.push(`scale(${(0.72 + p * 0.28).toFixed(3)})`);
      break;
    case "pop-out":
      opacity = 1 - ep;
      transformParts.push(`scale(${(1 + ep * 0.22).toFixed(3)})`);
      break;
    case "bounce-in":
    case "scale-bounce":
      opacity = p;
      transformParts.push(`scale(${(1 + Math.sin(p * Math.PI) * 0.18).toFixed(3)})`);
      break;
    case "zoom-out":
      opacity = 1 - ep;
      transformParts.push(`scale(${(1 - ep * 0.3).toFixed(3)})`);
      break;
    case "zoom-in":
      opacity = p;
      transformParts.push(`scale(${(0.7 + p * 0.3).toFixed(3)})`);
      break;
    case "slide-up":
    case "slide-up-in":
      opacity = p;
      transformParts.push(`translateY(${((1 - p) * 70).toFixed(1)}px)`);
      break;
    case "slide-up-out":
      opacity = 1 - ep;
      transformParts.push(`translateY(${(-ep * 70).toFixed(1)}px)`);
      break;
    case "slide-up-zoom":
      opacity = p;
      transformParts.push(`translateY(${((1 - p) * 70).toFixed(1)}px)`);
      transformParts.push(`scale(${(1.18 - p * 0.18).toFixed(3)})`);
      break;
    case "slide-up-zoom-out":
      opacity = 1 - ep;
      transformParts.push(`translateY(${(-ep * 70).toFixed(1)}px)`);
      transformParts.push(`scale(${(1 - ep * 0.18).toFixed(3)})`);
      break;
    case "rotate-left":
    case "rotate-slow-left":
      opacity = p;
      transformParts.push(`rotate(${(-(1 - p) * (animation === "rotate-slow-left" ? 8 : 18)).toFixed(1)}deg)`);
      break;
    case "rotate-right":
    case "rotate-slow-right":
      opacity = p;
      transformParts.push(`rotate(${((1 - p) * (animation === "rotate-slow-right" ? 8 : 18)).toFixed(1)}deg)`);
      break;
    case "scale-rotate-right":
      opacity = p;
      transformParts.push(`rotate(${((1 - p) * 20).toFixed(1)}deg)`);
      transformParts.push(`scale(${(0.75 + p * 0.25).toFixed(3)})`);
      break;
    case "rotate-wiggle":
    case "rotate-wiggle-small":
    case "rotate-wiggle-mini":
    case "rotate-wiggle-scale": {
      opacity = p;
      const amount = animation === "rotate-wiggle" ? 9 : animation === "rotate-wiggle-small" ? 5 : 3;
      transformParts.push(`rotate(${(Math.sin(frame / 2.5) * amount * (1 - p * 0.4)).toFixed(1)}deg)`);
      if (animation === "rotate-wiggle-scale") transformParts.push(`scale(${(1 + Math.sin(frame / 3) * 0.04).toFixed(3)})`);
      break;
    }
    case "pop-in-zoom":
      opacity = p;
      transformParts.push(`scale(${(0.6 + Math.sin(p * Math.PI) * 0.18 + p * 0.4).toFixed(3)})`);
      break;
    case "scale-slow-in":
      opacity = p;
      transformParts.push(`scale(${(0.88 + p * 0.12).toFixed(3)})`);
      break;
    case "typewriter":
    case "typewriter-simple":
    case "slide-left-in-typewriter":
      // Block-level no-op: typewriter "types out" the line WORD BY WORD synced to
      // speech (each word appears at its own timestamp) — handled per-word in the
      // render loop (typewriterWordMotion), not by a block-wide clipPath wipe.
      opacity = 1;
      break;
    case "letter-fade-in":
      opacity = p;
      break;
    case "letter-spacing-in":
    case "letter-spacing-bounce-in":
    case "letter-spacing-large-in": {
      opacity = p;
      const start = animation === "letter-spacing-large-in" ? 0.35 : 0.18;
      const bounce = animation === "letter-spacing-bounce-in" ? Math.sin(p * Math.PI) * 0.05 : 0;
      innerStyle.letterSpacing = `${(start * (1 - p) + bounce).toFixed(3)}em`;
      break;
    }
    case "screw-in":
      opacity = p;
      transformParts.push(`rotate(${((1 - p) * -60).toFixed(1)}deg)`);
      transformParts.push(`scale(${(0.55 + p * 0.45).toFixed(3)})`);
      break;
    case "slide-right-bounce":
      opacity = p;
      transformParts.push(`translateX(${(((1 - p) * -90 + Math.sin(p * Math.PI) * 10) * dir).toFixed(1)}px)`);
      break;
    case "slide-right-dust":
      opacity = p;
      transformParts.push(`translateX(${((1 - p) * -90 * dir).toFixed(1)}px)`);
      innerStyle.filter = `blur(${((1 - p) * 3).toFixed(1)}px)`;
      break;
    case "slide-up-wiggle":
      opacity = p;
      transformParts.push(`translateY(${((1 - p) * 70).toFixed(1)}px)`);
      transformParts.push(`rotate(${(Math.sin(frame / 2) * 5 * (1 - p)).toFixed(1)}deg)`);
      break;
    case "blink-fade":
      opacity = p * (frame % 6 < 3 ? 1 : 0.45);
      break;
    case "border-reveal":
      opacity = p;
      // reveal from the reading-start edge (left for LTR, right for RTL)
      innerStyle.clipPath = rtl
        ? `inset(0 0 0 ${(1 - p) * 100}%)`
        : `inset(0 ${(1 - p) * 100}% 0 0)`;
      innerStyle.borderBottom = `${Math.max(2, style.fontSize * 0.04)}px solid ${style.highlightColor}`;
      break;
  }

  return { opacity, transformParts, innerStyle };
}

// Returns the per-word motion as composable CSS (NO `display`) so it can be
// merged onto the template's OWN element via cloneElement — keeping that element
// the flex item, which preserves template layout (e.g. Podcast flexBasis:100%)
// and the #39 RTL design. Returns null for "none" (no motion to apply).
function wordMotionStyle(
  animation: NonNullable<SubtitleStyle["wordAnimation"]>,
  frame: number,
  fps: number,
  wordStartFrame: number,
  isActive: boolean,
  isPast: boolean,
  rtl: boolean
): React.CSSProperties | null {
  if (animation === "none") return null;

  const fast = animation.includes("fast");
  const dur = Math.max(1, Math.round((fast ? 0.12 : 0.22) * fps));
  const p = easeProgress(frame - wordStartFrame, dur);
  const visible = isPast || isActive || p > 0;
  const dir = rtl ? -1 : 1; // flip horizontal slides so RTL slides in from the right
  const style: React.CSSProperties = { opacity: visible ? 1 : 0 };

  switch (animation) {
    case "fade-in":
    case "fade-in-fast":
      style.opacity = p;
      break;
    case "show-in":
    case "show-in-fast":
      style.opacity = frame >= wordStartFrame ? 1 : 0;
      break;
    case "zoom-in":
      style.opacity = p;
      style.transform = `scale(${(0.72 + p * 0.28).toFixed(3)})`;
      break;
    case "opacity-30":
      style.opacity = isPast || isActive ? 1 : 0.3;
      break;
    case "slide-up":
    case "slide-up-fast":
      style.opacity = p;
      style.transform = `translateY(${((1 - p) * 24).toFixed(1)}px)`;
      break;
    case "white-flash-reveal":
      style.opacity = p;
      if (p < 0.5) {
        style.textShadow = "0 0 18px #fff, 0 0 32px #fff";
        style.filter = `brightness(${(1.8 - p).toFixed(2)})`;
      }
      break;
    case "slide-right-dust":
      style.opacity = p;
      style.transform = `translateX(${((1 - p) * -28 * dir).toFixed(1)}px)`;
      style.filter = `blur(${((1 - p) * 2.5).toFixed(1)}px)`;
      break;
  }

  return style;
}

/**
 * "Typewriter" caption family: the line types out WORD BY WORD in sync with the
 * audio — each word stays hidden until its own timestamp, then reveals. Returns
 * an opacity GATE (multiplied onto the word) or null for non-typewriter entrances.
 */
function typewriterGate(
  entrance: NonNullable<SubtitleStyle["captionAnimation"]>,
  frame: number,
  wordStartFrame: number,
  fps: number
): number | null {
  if (
    entrance !== "typewriter" &&
    entrance !== "typewriter-simple" &&
    entrance !== "slide-left-in-typewriter"
  ) {
    return null;
  }
  if (entrance === "typewriter-simple") return frame >= wordStartFrame ? 1 : 0; // hard cut
  return easeProgress(frame - wordStartFrame, Math.max(1, Math.round(0.08 * fps))); // quick fade in
}

/**
 * Wrap each word in a real DOM <span> that carries dir="auto" (per-word script
 * direction for RTL) and the per-word motion. Templates render CUSTOM components
 * (e.g. HormoziWord) that ignore a `dir` prop and don't read style.opacity, so
 * the motion/dir MUST live on a wrapping DOM node — not be cloned onto them.
 *
 * - No motion and no gate: `display: contents` so the wrapper generates no box
 *   and the template's own element stays the flex item (preserves template
 *   layout, e.g. Podcast flexBasis:100%).
 * - With motion/gate: the wrapper becomes the flex item (inline-block). For a
 *   self-stacking template's emphasis word we forward flexBasis:100% so Podcast
 *   keeps giving that word its own row even while it animates.
 * `gateOpacity` (typewriter) multiplies the wrapper opacity (CSS opacity nests).
 */
function applyWordMotion(
  rendered: React.ReactNode,
  motion: React.CSSProperties | null,
  gateOpacity: number | null,
  stackEmphasis: boolean,
  key: number
): React.ReactNode {
  if (motion == null && gateOpacity == null) {
    return <span key={key} dir="auto" style={{ display: "contents" }}>{rendered}</span>;
  }
  const style: React.CSSProperties = { display: "inline-block" };
  if (motion) Object.assign(style, motion);
  if (gateOpacity != null) {
    style.opacity = (typeof style.opacity === "number" ? style.opacity : 1) * gateOpacity;
  }
  if (stackEmphasis) {
    style.flexBasis = "100%";
    style.textAlign = "center";
  }
  return <span key={key} dir="auto" style={style}>{rendered}</span>;
}

/** How long a block lingers after its last word, clamped to the next block. */
const TAIL_MS = 320;
/** Block fade in/out length, in frames (~0.27s at 30fps so it reads clearly). */
const FADE_FRAMES = 8;

/** Injects bundled caption @font-face rules and blocks render until they load. */
const FontLoader: React.FC = () => {
  const [handle] = useState(() => delayRender("caption-fonts"));

  const load = useCallback(async () => {
    try {
      await Promise.all(
        BUNDLED_CAPTION_FONTS.map((f) => document.fonts.load(`700 64px "${f}"`))
      );
    } catch {
      // fall through — render with whatever resolved rather than hanging
    }
    continueRender(handle);
  }, [handle]);

  useEffect(() => {
    load();
  }, [load]);

  return <style>{captionFontFaces}</style>;
};

export const Subtitles: React.FC<SubtitlesProps> = ({ config }) => {
  const { fps } = useVideoConfig();
  const template = getCaptionTemplate(resolveTemplateId(config.style));
  // A user "Display words" override wins over the template grouping; bump
  // maxChars alongside it so the word count actually drives the block size.
  const grouping = config.style.maxWords
    ? {
        ...template.grouping,
        maxWords: config.style.maxWords,
        maxChars: config.style.maxWords * 14,
      }
    : template.grouping;
  // A grouped block can straddle a clip boundary (a manual split or trailer cut
  // mid-phrase), and its words may then carry DIFFERENT per-clip placements.
  // Split each block into runs of same-placement words so every run renders in
  // its own clip's position instead of all using the first word's.
  type Block = ReturnType<typeof groupCaptionsIntoBlocks>[number];
  const splitByPlacement = (block: Block): Block[] => {
    const out: Block[] = [];
    let run: Block["words"] = [];
    const flush = () => {
      if (run.length) out.push({ words: run, startMs: run[0].startMs, endMs: run[run.length - 1].endMs, text: run.map((w) => w.text).join(" ") });
    };
    let key: string | null = null;
    for (const w of block.words) {
      const k = JSON.stringify(w.placement ?? null);
      if (run.length && k !== key) { flush(); run = []; }
      run.push(w);
      key = k;
    }
    flush();
    return out;
  };
  const blocks = groupCaptionsIntoBlocks(config.captions, grouping).flatMap(splitByPlacement);

  return (
    <AbsoluteFill>
      <FontLoader />
      {blocks.map((block, i) => {
        const startFrame = Math.round((block.startMs / 1000) * fps);
        const nextStartMs = blocks[i + 1]?.startMs ?? Infinity;
        const effectiveEndMs = Math.min(nextStartMs, block.endMs + TAIL_MS);
        const durationFrames = Math.max(
          1,
          Math.round(((effectiveEndMs - block.startMs) / 1000) * fps)
        );

        return (
          <Sequence
            key={i}
            from={startFrame}
            durationInFrames={durationFrames}
            layout="none"
          >
            <SubtitleBlock
              block={block}
              config={config}
              durationFrames={durationFrames}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

interface SubtitleBlockProps {
  block: ReturnType<typeof groupCaptionsIntoBlocks>[number];
  config: SubtitleConfig;
  durationFrames: number;
}

const SubtitleBlock: React.FC<SubtitleBlockProps> = ({
  block,
  config,
  durationFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { style, position } = config;

  const template = getCaptionTemplate(resolveTemplateId(style));
  const fontStack = getFontStack(template.font ?? style.fontFamily);
  const uppercase = style.uppercase ?? template.uppercase ?? false;

  const currentTimeMs = block.startMs + (frame / fps) * 1000;
  const activeIndex = getActiveWordIndex(block.words, currentTimeMs);
  // RTL blocks (Arabic/Hebrew/etc.) flow right-to-left; with flex-direction:row
  // this reverses the visual word order. Per-word dir="auto" keeps a stray
  // Latin word inside an Arabic line (or vice-versa) correctly oriented.
  const blockDir = dominantDir(block.words);

  // The block's "key" word for size-contrast templates (e.g. Podcast): a
  // manually highlighted word wins, otherwise the longest word stands in.
  const emphasisIndex = (() => {
    const hi = block.words.findIndex((w) => w.highlight === true);
    if (hi >= 0) return hi;
    let idx = 0;
    let len = -1;
    block.words.forEach((w, j) => {
      const l = w.text.replace(/[^\p{L}\p{N}]/gu, "").length;
      if (l > len) {
        len = l;
        idx = j;
      }
    });
    return idx;
  })();

  // Caption placement: a PER-CLIP override (carried on this block's words by
  // remapCaptions) wins as a unit; otherwise the global config position/x,y is
  // used (fully back-compat). With both x/y it's free-dragged; else a preset.
  const placement = block.words[0]?.placement;
  const placeX = placement ? placement.x : config.x;
  const placeY = placement ? placement.y : config.y;
  const placePosition = placement?.position ?? position;
  const freePlaced = typeof placeX === "number" && typeof placeY === "number";
  const outerStyle: React.CSSProperties = freePlaced
    ? {
        position: "absolute",
        left: `${(placeX as number) * 100}%`,
        top: `${(placeY as number) * 100}%`,
        // A fixed width centered on the drag point so the inner block's
        // percentage maxWidth resolves predictably and long captions wrap
        // the same way they do in the preset layouts. Smart placement narrows
        // this (maxWidthPct) so a side caption fits the negative space.
        width: `${Math.round((placement?.maxWidthPct ?? config.maxWidthPct ?? 0.88) * 100)}%`,
        display: "flex",
        justifyContent: "center",
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        ...(POSITION_MAP[placePosition] ?? POSITION_MAP.bottom),
      };
  const containerStyle = template.containerStyle?.(style) ?? {};
  // Generic vertical stacking: lay the words out in a centered column. Templates
  // that draw their own stack (podcast's emphasis-aware layout) opt out and keep
  // the row-wrap container.
  const columnStack = !template.selfStacks && style.verticalStack === true;

  // Above/below emojis render once per line (centered over the block), not per
  // word. Inline emojis stay baked into the word text below. "none" → no emojis.
  const emojiPlacement = style.emojiPlacement ?? "above-word";
  const emojiAnimation = style.emojiAnimation ?? "pop-in";
  const wordAnimation = style.wordAnimation ?? "none";
  const lineEmojis =
    emojiPlacement === "above-word" || emojiPlacement === "below-word"
      ? block.words.filter((w) => w.emoji).map((w) => w.emoji as string)
      : [];

  // Block entrance animation (layers over the per-word template animation).
  // Existing templates already have their own word personality, so default to
  // no block fade. User-selected caption animations opt into motion.
  const entrance = style.captionAnimation ?? "none";
  const motion = captionMotion(entrance, style, frame, fps, durationFrames, blockDir === "rtl");
  const transform =
    [freePlaced ? "translate(-50%, -50%)" : "", ...motion.transformParts]
      .filter(Boolean)
      .join(" ") || undefined;

  // Only the explicit fade preset fades out at the tail. Other Submagic-style
  // choices keep their settled pose until the next caption block replaces them.
  const fade = Math.min(FADE_FRAMES, Math.floor((durationFrames - 1) / 2));
  const opacity =
    entrance === "fade" && fade >= 1
      ? interpolate(
          frame,
          [0, fade, durationFrames - fade, durationFrames],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        )
      : motion.opacity;

  return (
    <div
      style={{
        ...outerStyle,
        transform,
        opacity,
        filter: blockFilter(style),
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: columnStack ? "column" : "row",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          direction: blockDir === "rtl" ? "rtl" : "ltr",
          gap: `${Math.round(style.fontSize * 0.12)}px ${Math.round(
            style.fontSize * 0.28 * (style.wordSpacing ?? 1)
          )}px`,
          maxWidth: "88%",
          // letter-spacing is inherited, so this reaches every word span that
          // doesn't set its own tracking. ponytail: a few effect styles bake
          // their own letterSpacing and won't follow this slider.
          ...(style.letterSpacing != null
            ? { letterSpacing: `${style.letterSpacing}em` }
            : {}),
          ...motion.innerStyle,
          ...containerStyle,
        }}
      >
        {block.words.map((word, i) => {
          const wordStartFrame = Math.round(
            ((word.startMs - block.startMs) / 1000) * fps
          );
          const wordEndFrame = Math.round(
            ((word.endMs - block.startMs) / 1000) * fps
          );
          const isActive = i === activeIndex;
          const isPast = i < activeIndex;
          // Keyword highlight: words flagged `highlight` get the active-word
          // treatment (which is driven by style.highlightColor in every
          // template) even when they aren't the word being spoken. We only
          // force it once the word has appeared (frame >= its start) so entry
          // animations are settled and we don't render a mid-animation pose on
          // a word that hasn't been reached yet. The genuinely active word
          // always wins so its live animation is never overridden.
          const highlighted = word.highlight === true;
          const forceHighlight = highlighted && !isActive && frame >= wordStartFrame;
          const text =
            style.punctuation === false
              ? word.text.replace(/[.,!?;:…؟،؛۔]+$/u, "")
              : word.text;
          // Inline keeps the emoji baked into the word; above/below are rendered
          // once per line in the emoji row below, so the word renders plain here.
          const renderedText =
            word.emoji && emojiPlacement === "inline" ? `${text} ${word.emoji}` : text;
          const renderedWord = template.renderWord({
            word: renderedText,
            isActive: isActive || forceHighlight,
            isPast,
            frame,
            fps,
            wordStartFrame,
            wordEndFrame,
            style,
            fontStack,
            uppercase,
            seed: Math.round(word.startMs),
            isEmphasis: i === emphasisIndex,
            accentColor: word.accentColor,
          });

          // Compose the per-word animation onto the template's OWN element (no
          // wrapper box) so it stays the flex item — preserving template layout
          // (Podcast flexBasis:100%) and the #39 RTL design. dir="auto" handles
          // per-word script direction; container `direction` (dominantDir) sets
          // word order for RTL blocks.
          const motion = wordMotionStyle(
            wordAnimation,
            frame,
            fps,
            wordStartFrame,
            isActive,
            isPast,
            blockDir === "rtl"
          );
          // Typewriter caption animations type the line out word-by-word in sync
          // with speech (gates each word's opacity by its timestamp).
          const gate = typewriterGate(entrance, frame, wordStartFrame, fps);
          // When the wrapper becomes the flex item (motion/gate present), forward
          // Podcast's emphasis-word flexBasis so its vertical stack survives.
          const stackEmphasis =
            template.selfStacks === true &&
            i === emphasisIndex &&
            style.verticalStack !== false;

          return applyWordMotion(renderedWord, motion, gate, stackEmphasis, i);
        })}
        {lineEmojis.length > 0 && (
          <div style={emojiRowStyle(style, emojiPlacement as "above-word" | "below-word")}>
            {lineEmojis.map((emoji, k) => (
              <span key={k} style={emojiItemStyle(style, emojiPlacement as "above-word" | "below-word", emojiAnimation, frame, fps)}>
                {emoji}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
