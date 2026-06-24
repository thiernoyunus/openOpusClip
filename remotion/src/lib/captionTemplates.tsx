import React from "react";
import { interpolate, spring, random, Easing } from "remotion";
import type { SubtitleStyle, SubtitleAnimation } from "./types";
import type { GroupingOptions } from "./captions";
import { isRTL } from "./rtl";

/**
 * Caption template system.
 *
 * A template owns how a single word looks and animates. Subtitles.tsx provides
 * the shared scaffold (timing, grouping, positioning, fade) and delegates each
 * word to `renderWord`. Classic templates reproduce the original 4 animations;
 * the "effects" templates are ports of the HeyGen HyperFrames caption styles
 * (GSAP timelines re-expressed as Remotion frame math).
 */

export interface WordRenderArgs {
  word: string;
  isActive: boolean; // the word being spoken right now
  isPast: boolean; // already spoken within this block
  frame: number; // block-relative frame (0 at block start)
  fps: number;
  wordStartFrame: number; // block-relative
  wordEndFrame: number; // block-relative
  style: SubtitleStyle;
  fontStack: string;
  uppercase: boolean;
  seed: number; // stable per-word seed for deterministic randomness
  isEmphasis?: boolean; // the one "key" word in the block (drives size-contrast styles)
}

/** A per-template tunable surfaced as a slider in the customize panel. */
export interface CaptionExtra {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface CaptionTemplate {
  id: string;
  label: string;
  category: "classic" | "effects";
  /** Overrides style.fontFamily (signature font for effect templates). */
  font?: string;
  uppercase?: boolean;
  grouping?: GroupingOptions;
  /** Applied to the style when this template is picked in the panel. */
  defaultStyle: Partial<SubtitleStyle>;
  /** Per-template tunables surfaced as extra sliders (e.g. animation speed). */
  extras?: CaptionExtra[];
  /** Optional styling for the block wrapper (e.g. a background pill). */
  containerStyle?: (style: SubtitleStyle) => React.CSSProperties;
  /**
   * Template draws its own vertical-stack layout (so the shared scaffold must
   * NOT switch the container to flex-column). Podcast does this to keep its
   * emphasis-aware 3-line look; everything else uses the generic column stack.
   */
  selfStacks?: boolean;
  renderWord: (args: WordRenderArgs) => React.ReactNode;
}

// --- shared helpers ---------------------------------------------------------

/** 8-direction text outline faked with text-shadow (CSS stroke is unreliable here). */
function strokeShadow(style: SubtitleStyle): string {
  const w = style.borderWidth;
  if (!w || w <= 0) return "";
  const c = style.borderColor;
  return [
    `${w}px 0 0 ${c}`,
    `-${w}px 0 0 ${c}`,
    `0 ${w}px 0 ${c}`,
    `0 -${w}px 0 ${c}`,
    `${w}px ${w}px 0 ${c}`,
    `-${w}px ${w}px 0 ${c}`,
    `${w}px -${w}px 0 ${c}`,
    `-${w}px -${w}px 0 ${c}`,
  ].join(", ");
}

function boxStyle(style: SubtitleStyle): React.CSSProperties {
  if (style.bgOpacity <= 0) return {};
  const alpha = Math.round(style.bgOpacity * 255)
    .toString(16)
    .padStart(2, "0");
  return {
    backgroundColor: `${style.bgColor}${alpha}`,
    borderRadius: 10,
    padding: "8px 18px",
  };
}

// --- classic word (none / pop / karaoke / word-highlight) -------------------

const ClassicWord: React.FC<WordRenderArgs & { animation: SubtitleAnimation }> = ({
  word,
  isActive,
  frame,
  fps,
  wordStartFrame,
  style,
  fontStack,
  uppercase,
  animation,
}) => {
  let color = isActive ? style.highlightColor : style.fontColor;
  let transform = "";
  let extra: React.CSSProperties = {};
  let glow = "";

  if (isActive) {
    if (animation === "pop") {
      const s = spring({
        frame: frame - wordStartFrame,
        fps,
        config: { mass: 0.5, stiffness: 300, damping: 12 },
        durationInFrames: 10,
      });
      transform = `scale(${interpolate(s, [0, 1], [1, 1.2])})`;
    } else if (animation === "karaoke") {
      extra = {
        backgroundColor: style.highlightColor,
        color: style.bgColor || "#000000",
        borderRadius: 6,
        padding: "0 8px",
      };
      color = extra.color as string;
    } else if (animation === "word-highlight") {
      glow = `0 0 14px ${style.highlightColor}, 0 0 28px ${style.highlightColor}66`;
    }
  }

  const stroke = strokeShadow(style);
  const isKaraoke = animation === "karaoke" && isActive;
  const textShadow = isKaraoke
    ? "none"
    : [stroke, glow].filter(Boolean).join(", ") || "none";

  return (
    <span
      style={{
        fontFamily: fontStack,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight ?? 800,
        color,
        textTransform: uppercase ? "uppercase" : "none",
        textShadow,
        transform,
        display: "inline-block",
        ...extra,
      }}
    >
      {word}
    </span>
  );
};

function classicTemplate(
  id: string,
  label: string,
  animation: SubtitleAnimation,
  extra: Partial<SubtitleStyle> = {}
): CaptionTemplate {
  return {
    id,
    label,
    category: "classic",
    grouping: { maxWords: 4, maxChars: 24 },
    // A full preset so picking a classic style yields a clean, predictable look
    // (and resets effect-only fields like the matrix green).
    defaultStyle: {
      template: id,
      animation,
      // Configured animation defaults (visible/editable in Customize). Word stays
      // "none" so the classic word behavior (driven by `animation`) is preserved;
      // "clean" (no word motion) gets a gentle word fade so it isn't lifeless.
      captionAnimation: "fade-in",
      wordAnimation: animation === "none" ? "fade-in" : "none",
      emojiAnimation: "pop-in",
      fontFamily: "Inter",
      fontSize: 56,
      fontColor: "#FFFFFF",
      highlightColor: "#FFDD00",
      borderColor: "#000000",
      borderWidth: animation === "none" ? 2 : 3,
      bgColor: "#000000",
      bgOpacity: 0,
      ...extra,
    },
    containerStyle: boxStyle,
    renderWord: (args) => <ClassicWord {...args} animation={animation} />,
  };
}

// --- glitch-rgb -------------------------------------------------------------

const GlitchWord: React.FC<WordRenderArgs> = ({
  word,
  isActive,
  frame,
  fps,
  wordStartFrame,
  style,
  fontStack,
  seed,
  uppercase,
}) => {
  const t = frame - wordStartFrame;
  const dur = Math.round(0.18 * fps);
  const base = "0 4px 14px rgba(0,0,0,0.55)";
  let textShadow = base;
  let transform = "";

  if (isActive && t >= 0 && t < dur) {
    const mag = 5 + random(`${seed}:${frame}:m`) * 7;
    const ty = -(2 + random(`${seed}:${frame}:y`) * 4);
    const skew = (random(`${seed}:${frame}:s`) - 0.5) * 3;
    textShadow = `${mag.toFixed(1)}px 0 #ff003c, ${(-mag).toFixed(1)}px 0 #00e5ff, ${base}`;
    transform = `translateY(${ty.toFixed(1)}px) skewX(${skew.toFixed(1)}deg)`;
  }

  const stroke = strokeShadow(style);
  return (
    <span
      style={{
        fontFamily: fontStack,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight ?? 700,
        letterSpacing: "0.03em",
        textTransform: uppercase ? "uppercase" : "none",
        color: style.fontColor,
        textShadow: stroke ? `${stroke}, ${textShadow}` : textShadow,
        transform,
        display: "inline-block",
      }}
    >
      {word}
    </span>
  );
};

// --- matrix-decode ----------------------------------------------------------

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

function scramble(word: string, seed: number, frame: number, revealCount: number): string {
  // RTL (Arabic, etc.): never scramble. Substituting Latin glyphs and rendering
  // partial words would both garble the text and break Arabic letter-joining.
  if (isRTL(word)) return word;
  // Split by code point so emojis / surrogate pairs aren't sliced in half.
  const chars = Array.from(word);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === " ") {
      out += " ";
    } else if (i < revealCount) {
      out += ch;
    } else {
      out += GLYPHS[Math.floor(random(`${seed}:${i}:${frame}`) * GLYPHS.length)];
    }
  }
  return out;
}

const MatrixWord: React.FC<WordRenderArgs> = ({
  word,
  frame,
  fps,
  wordStartFrame,
  style,
  fontStack,
  seed,
}) => {
  const t = frame - wordStartFrame;
  const speed = style.effectParams?.decodeSpeed ?? 1;
  const dur = Math.max(1, Math.round((0.28 * fps) / speed));

  // RTL (Arabic) can't be scrambled per-letter (it breaks shaping), so it has no
  // decode animation: keep it hidden until its own timestamp, then show the
  // whole shaped word. Without this, scramble() returns the full RTL word even
  // at t<0, leaking upcoming Arabic words at the block start.
  const rtl = isRTL(word);
  let display: string;
  if (rtl) {
    display = word;
  } else if (t < 0) {
    display = scramble(word, seed, frame, 0);
  } else if (t < dur) {
    const reveal = Math.floor((t / dur) * word.length);
    display = scramble(word, seed, frame, reveal);
  } else {
    display = word;
  }

  const color = style.fontColor || "#00ff41";
  return (
    <span
      style={{
        fontFamily: fontStack,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight ?? 700,
        letterSpacing: "0.04em",
        color,
        textShadow: `0 0 10px ${color}99, 0 0 2px ${color}, 0 3px 10px rgba(0,0,0,0.5)`,
        display: "inline-block",
        whiteSpace: "pre",
        opacity: rtl && t < 0 ? 0 : 1,
      }}
    >
      {display}
    </span>
  );
};

// --- particle-burst ---------------------------------------------------------

const PARTICLE_COLORS = ["#FFD700", "#FF6B6B", "#4ECDC4", "#FFE66D", "#A78BFA", "#22D3EE"];
const NUM_PARTICLES = 8;

const ParticleWord: React.FC<WordRenderArgs> = ({
  word,
  isActive,
  frame,
  fps,
  wordStartFrame,
  style,
  fontStack,
  seed,
  uppercase,
}) => {
  const t = frame - wordStartFrame;
  const s = isActive
    ? spring({
        frame: t,
        fps,
        config: { mass: 0.4, stiffness: 200, damping: 11 },
        durationInFrames: 8,
      })
    : 0;
  const scale = isActive ? interpolate(s, [0, 1], [1, 1.12]) : 1;
  const color = isActive ? style.highlightColor || "#FFD700" : style.fontColor;

  const burst = Math.max(1, Math.round(0.12 * fps));
  const life = Math.round(0.55 * fps);
  const showParticles = t >= 0 && t < burst + life;
  const stroke = strokeShadow(style);

  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        fontFamily: fontStack,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight ?? 900,
        letterSpacing: "0.05em",
        textTransform: uppercase ? "uppercase" : "none",
        color,
        opacity: isActive ? 1 : 0.5,
        transform: `scale(${scale})`,
        textShadow: stroke || "0 4px 14px rgba(0,0,0,0.5)",
      }}
    >
      {word}
      {showParticles &&
        Array.from({ length: NUM_PARTICLES }).map((_, i) => {
          const angle =
            (i / NUM_PARTICLES) * Math.PI * 2 + random(`${seed}:p${i}:a`) * 0.8;
          const dist = 50 + random(`${seed}:p${i}:d`) * 90;
          const size = 5 + random(`${seed}:p${i}:s`) * 8;
          const ex = interpolate(t, [0, burst], [0, 1], {
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          });
          const x = Math.cos(angle) * dist * ex;
          const y = -Math.sin(angle) * dist * ex;
          const opacity =
            t < burst
              ? interpolate(t, [0, burst], [0, 1])
              : interpolate(t, [burst, burst + life], [1, 0], {
                  extrapolateRight: "clamp",
                });
          return (
            <span
              key={i}
              style={{
                position: "absolute",
                left: "50%",
                top: "40%",
                width: size,
                height: size,
                borderRadius: "50%",
                backgroundColor: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
                transform: `translate(${x}px, ${y}px)`,
                opacity,
                pointerEvents: "none",
              }}
            />
          );
        })}
    </span>
  );
};

// --- additional HyperFrames ports -------------------------------------------

/** Append an alpha byte to a #rrggbb color; pass others through unchanged. */
function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    return color + Math.round(alpha * 255).toString(16).padStart(2, "0");
  }
  return color;
}

function entrySpring(t: number, fps: number): number {
  return spring({ frame: t, fps, config: { mass: 0.5, stiffness: 200, damping: 12 }, durationInFrames: 10 });
}

// highlight — marker bar sweeps in behind each word as it's spoken
const HighlightWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const on = frame >= wordStartFrame;
  const t = frame - wordStartFrame;
  const scaleX = on ? interpolate(t, [0, Math.max(1, Math.round(0.15 * fps))], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }) : 0;
  const marker = style.highlightColor || "#FFE94E";
  return (
    <span style={{ position: "relative", display: "inline-block", fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", letterSpacing: "0.02em", color: on ? "#141414" : style.fontColor, textShadow: on ? "none" : "0 4px 14px rgba(0,0,0,0.45)", padding: "0 6px" }}>
      <span style={{ position: "absolute", left: 0, top: "8%", bottom: "8%", right: 0, background: marker, borderRadius: 6, transform: `scaleX(${scaleX})`, transformOrigin: "left center", zIndex: 0, opacity: isActive || isPast ? 1 : 0 }} />
      <span style={{ position: "relative", zIndex: 1 }}>{word}</span>
    </span>
  );
};

// gradient-fill — flowing multi-color "Siri" gradient clipped to the text
const SIRI_GRADIENT = "linear-gradient(90deg,#fe9f1b,#f76e49,#ff2063,#fd56cb,#ef7aff,#fe9f1b)";
const GradientFillWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const period = Math.max(1, Math.round(3 * fps));
  const pos = ((frame % period) / period) * 100;
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.08]) : 1;
  return (
    <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, letterSpacing: "0.03em", display: "inline-block", transform: `scale(${scale})`, backgroundImage: SIRI_GRADIENT, backgroundSize: "300% 100%", backgroundPosition: `${pos}% 0`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.5))" }}>{word}</span>
  );
};

// neon-glow — dim base, the spoken word ignites with a neon glow
const NeonGlowWord: React.FC<WordRenderArgs> = ({ word, isActive, style, fontStack, uppercase }) => {
  const neon = style.highlightColor || "#00FFF0";
  const color = isActive ? neon : withAlpha(neon, 0.16);
  const glow = isActive ? `0 0 8px ${neon}, 0 0 22px ${neon}, 0 0 44px ${withAlpha(neon, 0.5)}` : "none";
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, textTransform: uppercase ? "uppercase" : "none", letterSpacing: "0.04em", color, textShadow: glow, display: "inline-block" }}>{word}</span>;
};

// neon-accent — white base, each word a punchy assigned accent when spoken
const NEON_ACCENTS = ["#53FF01", "#FF0002", "#FCFF00"];
const NeonAccentWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed, uppercase }) => {
  const accent = NEON_ACCENTS[seed % NEON_ACCENTS.length];
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.1]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `scale(${scale})`, color: isActive ? accent : style.fontColor, textShadow: isActive ? `0 0 12px ${withAlpha(accent, 0.6)}` : "0 4px 14px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// weight-shift — thin base, the spoken word swells to a heavy weight
const WeightShiftWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [0.96, 1.05]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: isActive ? 800 : 300, textTransform: "lowercase", letterSpacing: "-0.03em", display: "inline-block", transform: `scale(${scale})`, color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 2px 6px rgba(0,0,0,0.4)" }}>{word}</span>;
};

// editorial-emphasis — elegant cream serif/sans; spoken word settles + italicizes
const EditorialWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const scale = isActive ? interpolate(entrySpring(t, fps), [0, 1], [1.12, 1]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: isActive ? 700 : 400, fontStyle: isActive ? "italic" : "normal", display: "inline-block", transformOrigin: "0% 100%", transform: `scale(${scale})`, color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 2px 10px rgba(0,0,0,0.45)" }}>{word}</span>;
};

// emoji-pop — chunky stroked words in playful accents, emoji on key words
const EMOJI_ACCENTS = ["#FF76FF", "#FF0002", "#B2F7FF"];
const EMOJI_MAP: Record<string, string> = {
  money: "💰", cash: "💸", fire: "🔥", love: "❤️", best: "🏆", win: "🏆", new: "✨",
  ai: "🤖", big: "💥", huge: "💥", time: "⏰", fast: "⚡", idea: "💡", growth: "📈",
  up: "🚀", boom: "💥", crazy: "🤯", mind: "🧠", deal: "🤝", free: "🎁",
};
const EmojiPopWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed, uppercase }) => {
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.14]) : 1;
  const key = word.toLowerCase().replace(/[^a-z]/g, "");
  const emoji = EMOJI_MAP[key];
  return (
    <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `scale(${scale})`, color: isActive ? EMOJI_ACCENTS[seed % EMOJI_ACCENTS.length] : style.fontColor, WebkitTextStroke: "3px #000000" }}>
      {word}
      {emoji ? <span style={{ WebkitTextStroke: "0", marginLeft: "0.18em" }}>{emoji}</span> : null}
    </span>
  );
};

// kinetic-slam — each word slams down into place with an overshoot
const KineticSlamWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, opacity: 0, display: "inline-block" }}>{word}</span>;
  const p = spring({ frame: t, fps, config: { mass: 0.6, stiffness: 200, damping: 9 }, durationInFrames: 16 });
  const y = interpolate(p, [0, 1], [-120, 0]);
  const opacity = interpolate(t, [0, Math.max(1, Math.round(0.06 * fps))], [0, 1], { extrapolateRight: "clamp" });
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 400, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `translateY(${y}px)`, opacity, color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 6px 18px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// clip-wipe — each word is wiped in left-to-right
const ClipWipeWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const reveal = t < 0 ? 100 : interpolate(t, [0, Math.max(1, Math.round(0.3 * fps))], [100, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const color = isActive ? style.highlightColor || "#FFD700" : isPast ? "rgba(255,255,255,0.45)" : style.fontColor;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", clipPath: `inset(0 ${reveal}% 0 0)`, color, textShadow: "0 4px 14px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// blend-difference — text inverts against the footage via mix-blend-mode
const BlendDifferenceWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.08]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `scale(${scale})`, color: "#ffffff", mixBlendMode: "difference" }}>{word}</span>;
};

// parallax-layers — bold serif with a scaled echo behind for depth
const ParallaxLayersWord: React.FC<WordRenderArgs> = ({ word, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const opacity = interpolate(t, [0, Math.max(1, Math.round(0.18 * fps))], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const c = style.fontColor || "#E50914";
  return (
    <span style={{ position: "relative", display: "inline-block", fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 400, lineHeight: 1, color: c, opacity, WebkitTextStroke: `2px ${c}` }}>
      <span aria-hidden="true" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%) scale(1.7)", opacity: 0.12, whiteSpace: "nowrap", pointerEvents: "none" }}>{word}</span>
      <span style={{ position: "relative", textShadow: "2px 4px 4px rgba(0,0,0,0.5)" }}>{word}</span>
    </span>
  );
};

// texture — warm gradient-filled display type with a fiery glow
const TextureWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const scale = t >= 0 ? interpolate(entrySpring(t, fps), [0, 1], [0.88, 1]) : 0.88;
  const grad = isActive ? "linear-gradient(180deg,#ffe7c2,#ff9d3c)" : "linear-gradient(180deg,#ffd0a0,#ff7a18)";
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 400, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `scale(${scale})`, backgroundImage: grad, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: "drop-shadow(0 4px 24px rgba(255,100,20,0.55))" }}>{word}</span>;
};

// pill-karaoke — gray words darken as spoken, inside a light rounded pill
const PillKaraokeWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, style, fontStack }) => {
  const spoken = isActive || isPast;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 700, textTransform: "lowercase", color: spoken ? style.highlightColor || "#1C1E1D" : style.fontColor || "#A6A6A6", display: "inline-block" }}>{word}</span>;
};

// --- premium "After Effects" styles (hand-animated look) ---------------------

/** Multiply a #rrggbb color toward black by `factor` (0..1). */
function darken(color: string, factor: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return color;
  const ch = (i: number) =>
    Math.max(0, Math.min(255, Math.round(parseInt(color.slice(i, i + 2), 16) * factor)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

// glossy-gradient — Devin Jatho signature: soft glassy gradient that floats + glows
const GlossyGradientWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const float = Math.sin(frame / fps * 1.6 + wordStartFrame) * 3;
  const intro = interpolate(t, [0, Math.max(1, Math.round(0.3 * fps))], [12, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const grad = isActive ? "linear-gradient(180deg,#FFFFFF 0%,#EAF2FF 100%)" : "linear-gradient(180deg,#FFFFFF 0%,#BFD9FF 100%)";
  const glow = isActive ? 0.9 : 0.4;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", letterSpacing: "-0.02em", display: "inline-block", transform: `translateY(${(float + intro).toFixed(2)}px) scale(${isActive ? 1.05 : 1})`, opacity: isActive ? 1 : 0.72, backgroundImage: grad, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: `drop-shadow(0 0 8px rgba(190,217,255,${glow})) drop-shadow(0 4px 18px rgba(120,160,255,${glow * 0.5}))` }}>{word}</span>;
};

// extrude-3d — hard isometric 3D block that punches toward camera
const Extrude3DWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  let scale = 1, depth = 5, lift = 0;
  if (isActive) {
    const s = spring({ frame: t, fps, config: { mass: 0.6, stiffness: 260, damping: 11 }, durationInFrames: 11 });
    scale = interpolate(s, [0, 1], [0.6, 1]);
    depth = Math.max(0, interpolate(s, [0, 1], [0, 8]));
    lift = interpolate(s, [0, 1], [6, 0]);
  }
  const color = isActive ? style.highlightColor : style.fontColor;
  const ex = darken(color, 0.5);
  const layers: string[] = [];
  for (let i = 1; i <= Math.round(depth); i++) layers.push(`${i}px ${i}px 0 ${ex}`);
  const ts = [...layers, strokeShadow(style)].filter(Boolean).join(", ") || "none";
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 400, textTransform: uppercase ? "uppercase" : "none", letterSpacing: "0.01em", display: "inline-block", transform: `translateY(${lift.toFixed(2)}px) scale(${scale.toFixed(3)})`, color, textShadow: ts }}>{word}</span>;
};

// flip-3d — each word hinges down into place on the X axis (perspective)
const Flip3DWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const p = t < 0 ? 0 : spring({ frame: t, fps, config: { mass: 0.5, stiffness: 170, damping: 14 }, durationInFrames: 12 });
  const rotX = interpolate(p, [0, 1], [-92, 0]);
  const opacity = t < 0 ? 0 : interpolate(t, [0, 3], [0, 1], { extrapolateRight: "clamp" });
  const b = interpolate(p, [0, 1], [0.4, 1]);
  return (
    <span style={{ perspective: "620px", display: "inline-block" }}>
      <span style={{ display: "inline-block", fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", transform: `rotateX(${rotX.toFixed(1)}deg)`, transformOrigin: "center top", filter: `brightness(${b.toFixed(2)})`, opacity, color: isActive ? style.highlightColor : style.fontColor, textShadow: strokeShadow(style) || "0 3px 10px rgba(0,0,0,0.5)" }}>{word}</span>
    </span>
  );
};

// whip-blur — word streaks in from the side with directional motion-blur ghosts
const WhipBlurWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed, uppercase }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, opacity: 0, display: "inline-block" }}>{word}</span>;
  const dir = seed % 2 ? 1 : -1;
  const e = interpolate(t, [0, Math.max(1, Math.round(0.23 * fps))], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const x = interpolate(e, [0, 1], [dir * 120, 0]);
  const color = isActive ? style.highlightColor : style.fontColor;
  const tt: React.CSSProperties["textTransform"] = uppercase ? "uppercase" : "none";
  return (
    <span style={{ position: "relative", display: "inline-block", transform: `translateX(${x.toFixed(1)}px) scaleX(${(1 + (1 - e) * 0.18).toFixed(3)})`, transformOrigin: dir > 0 ? "left center" : "right center" }}>
      {e < 1 && [1, 2, 3].map((k) => (
        <span key={k} style={{ position: "absolute", left: 0, top: 0, fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: tt, color, opacity: (1 - e) * (0.35 / k), filter: `blur(${((1 - e) * 4).toFixed(1)}px)`, transform: `translateX(${(dir * 14 * k).toFixed(0)}px)`, pointerEvents: "none" }}>{word}</span>
      ))}
      <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: tt, color, textShadow: strokeShadow(style) || "0 3px 10px rgba(0,0,0,0.5)", display: "inline-block" }}>{word}</span>
    </span>
  );
};

// zoom-rush — word rushes from oversize+blurred to crisp with chromatic fringe
const ZoomRushWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, opacity: 0, display: "inline-block" }}>{word}</span>;
  const e = interpolate(t, [0, Math.max(1, Math.round(0.2 * fps))], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const scale = interpolate(e, [0, 1], [1.9, 1]) * (isActive ? 1.06 : 1);
  const blurPx = interpolate(e, [0, 1], [10, 0]);
  const split = (1 - e) * 8;
  const color = isActive ? style.highlightColor : style.fontColor;
  const frontFilter = isActive ? `blur(${blurPx.toFixed(1)}px) drop-shadow(0 0 10px ${color})` : `blur(${blurPx.toFixed(1)}px)`;
  return (
    <span style={{ position: "relative", display: "inline-block", transform: `scale(${scale.toFixed(3)})` }}>
      {e < 1 && (
        <>
          <span style={{ position: "absolute", left: 0, top: 0, fontFamily: fontStack, fontWeight: style.fontWeight ?? 400, fontSize: style.fontSize, textTransform: uppercase ? "uppercase" : "none", color: "#FF0044", mixBlendMode: "screen", transform: `translateX(${(-split).toFixed(1)}px)` }}>{word}</span>
          <span style={{ position: "absolute", left: 0, top: 0, fontFamily: fontStack, fontWeight: style.fontWeight ?? 400, fontSize: style.fontSize, textTransform: uppercase ? "uppercase" : "none", color: "#00E5FF", mixBlendMode: "screen", transform: `translateX(${split.toFixed(1)}px)` }}>{word}</span>
        </>
      )}
      <span style={{ fontFamily: fontStack, fontWeight: style.fontWeight ?? 400, fontSize: style.fontSize, textTransform: uppercase ? "uppercase" : "none", color, filter: frontFilter, textShadow: strokeShadow(style) || "0 3px 10px rgba(0,0,0,0.5)", display: "inline-block" }}>{word}</span>
    </span>
  );
};

// squash-pop — liquid squash & stretch cartoon physics on entry
const SquashPopWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const s = t < 0 ? 0 : spring({ frame: t, fps, config: { mass: 0.45, stiffness: 240, damping: 9 }, durationInFrames: 14 });
  const scaleY = interpolate(s, [0, 0.5, 1], [1.35, 0.82, 1]) + (isActive ? Math.sin(t / 3) * 0.02 : 0);
  const scaleX = interpolate(s, [0, 0.5, 1], [0.7, 1.18, 1]);
  const opacity = t < 0 ? 0 : interpolate(t, [0, 2], [0, 1], { extrapolateRight: "clamp" });
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, display: "inline-block", transformOrigin: "center bottom", transform: `scale(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)})`, opacity, color: isActive ? style.highlightColor : style.fontColor, textShadow: strokeShadow(style) || "0 3px 10px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// chrome-shine — metallic gradient with a specular highlight that sweeps across
const ChromeShineWord: React.FC<WordRenderArgs> = ({ word, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const intro = t < 0 ? 0 : spring({ frame: t, fps, config: { mass: 0.5, stiffness: 200, damping: 12 }, durationInFrames: 9 });
  const y = interpolate(intro, [0, 1], [-24, 0]);
  const sc = interpolate(intro, [0, 1], [1.08, 1]);
  const pos = interpolate(t, [0, Math.max(1, Math.round(0.6 * fps))], [-120, 220], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 400, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `translateY(${y.toFixed(1)}px) scale(${sc.toFixed(3)})`, opacity: t < 0 ? 0 : 1, backgroundImage: "linear-gradient(110deg,#7a7a7a 0%,#ffffff 42%,#e9e9e9 50%,#8f8f8f 58%,#ffffff 100%)", backgroundSize: "250% 100%", backgroundPosition: `${pos.toFixed(0)}% 0`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", WebkitTextStroke: `${Math.max(1, style.borderWidth || 2)}px ${style.borderColor || "#111111"}`, filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.5))" }}>{word}</span>;
};

// apple — Apple keynote/marketing style: each word blur-fades up into place
const AppleWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, opacity: 0, display: "inline-block" }}>{word}</span>;
  const e = interpolate(t, [0, Math.max(1, Math.round(0.45 * fps))], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const blur = (1 - e) * 10;
  const ty = (1 - e) * 14;
  const scale = interpolate(e, [0, 1], [0.96, 1]);
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 600, letterSpacing: "-0.02em", display: "inline-block", opacity: e, filter: blur > 0.1 ? `blur(${blur.toFixed(1)}px)` : "none", transform: `translateY(${ty.toFixed(1)}px) scale(${scale.toFixed(3)})`, color: isActive ? style.highlightColor : style.fontColor, textShadow: strokeShadow(style) || "0 2px 12px rgba(0,0,0,0.45)" }}>{word}</span>;
};

// --- trending viral styles (TikTok/Reels/Shorts 2026) -----------------------

// hormozi — Montserrat Black all-caps, thick outline, spoken word pops in color
const HormoziWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const s = isActive ? spring({ frame: t, fps, config: { mass: 0.5, stiffness: 200, damping: 11 }, durationInFrames: 9 }) : 0;
  const scale = isActive ? interpolate(s, [0, 1], [1, 1.16]) : 1;
  const rot = isActive ? interpolate(s, [0, 1], [-5, 0]) : 0;
  const stroke = strokeShadow(style);
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, textTransform: uppercase ? "uppercase" : "none", letterSpacing: "-0.01em", display: "inline-block", transform: `scale(${scale}) rotate(${rot}deg)`, color: isActive ? style.highlightColor : style.fontColor, textShadow: stroke || "0 4px 14px rgba(0,0,0,0.6)" }}>{word}</span>;
};

// tiktok-bounce — each word bounces into place as it's spoken (TikTok native)
const TikTokBounceWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  const shown = t >= 0;
  const p = shown ? spring({ frame: t, fps, config: { mass: 0.4, stiffness: 220, damping: 10 }, durationInFrames: 12 }) : 0;
  const scale = shown ? interpolate(p, [0, 1], [0.3, 1]) : 0;
  const stroke = strokeShadow(style);
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 800, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", opacity: shown ? 1 : 0, transform: `scale(${scale})`, color: isActive ? style.highlightColor : style.fontColor, textShadow: stroke || "0 3px 10px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// typewriter — characters type out per word with a blinking cursor
const TypewriterWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, wordEndFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 700, opacity: 0, display: "inline-block" }}>{word}</span>;
  const dur = Math.max(1, wordEndFrame - wordStartFrame);
  const speed = style.effectParams?.typeSpeed ?? 1;
  // Split by code point so emojis / surrogate pairs aren't sliced in half.
  const chars = Array.from(word);
  // RTL: reveal the whole word at once. A partial Arabic word would render as
  // disconnected, isolated letters (broken contextual shaping).
  const shown = isRTL(word)
    ? chars.length
    : Math.min(chars.length, Math.floor((t / dur) * chars.length * speed) + 1);
  const blink = Math.floor(frame / Math.max(1, Math.round(0.4 * fps))) % 2 === 0;
  return (
    <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 700, display: "inline-block", color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 3px 10px rgba(0,0,0,0.5)" }}>
      {chars.slice(0, shown).join("")}
      {isActive ? <span style={{ opacity: blink ? 1 : 0.15, fontWeight: 400 }}>|</span> : null}
    </span>
  );
};

// mrbeast — chunky rounded type, big bouncy pop, vibrant per-word color + wiggle
const MRBEAST_PALETTE = ["#FFE000", "#00E676", "#FF1744", "#2979FF", "#FF6D00", "#D500F9"];
const MrBeastWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed, uppercase }) => {
  const t = frame - wordStartFrame;
  const s = isActive ? spring({ frame: t, fps, config: { mass: 0.45, stiffness: 240, damping: 9 }, durationInFrames: 9 }) : 0;
  const scale = isActive ? interpolate(s, [0, 1], [1, 1.22]) : 1;
  const wiggle = isActive ? Math.sin((t / fps) * 22) * 2 : 0;
  const stroke = strokeShadow(style);
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: style.fontWeight ?? 900, textTransform: uppercase ? "uppercase" : "none", display: "inline-block", transform: `scale(${scale}) rotate(${wiggle.toFixed(2)}deg)`, color: isActive ? MRBEAST_PALETTE[seed % MRBEAST_PALETTE.length] : style.fontColor, textShadow: stroke || "0 4px 14px rgba(0,0,0,0.6)" }}>{word}</span>;
};

// dynamic-minimal — the 2026 "minimalism" meta: clean, no outline, subtle emphasis
const MinimalWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const s = isActive ? spring({ frame: t, fps, config: { mass: 0.5, stiffness: 200, damping: 14 }, durationInFrames: 8 }) : 0;
  const scale = isActive ? interpolate(s, [0, 1], [1, 1.06]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: isActive ? 800 : 600, display: "inline-block", transform: `scale(${scale})`, color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 2px 8px rgba(0,0,0,0.45)" }}>{word}</span>;
};

// podcast — minimal viral podcast edit (SF-Pro-style): the key word is big and
// bold, the rest small; every word fades + slides up into place as it's spoken,
// over a duplicated drop shadow. Reverse-engineered from the "minimal text
// animation" Premiere tutorial. Emphasis word = block's highlighted/longest word.
const PodcastWord: React.FC<WordRenderArgs> = ({ word, isEmphasis, frame, fps, wordStartFrame, style, fontStack, uppercase }) => {
  const t = frame - wordStartFrame;
  // snappy bouncy pop on the word's timestamp (≈ GSAP back.out(1.7), ~0.15s):
  // a short spring with low damping overshoots past 1 then settles.
  const shown = t >= 0;
  const p = shown
    ? spring({ frame: t, fps, config: { mass: 0.5, stiffness: 220, damping: 10 }, durationInFrames: Math.max(1, Math.round(0.18 * fps)) })
    : 0;
  const scale = shown ? interpolate(p, [0, 1], [0.7, 1]) : 0.7;
  const opacity = shown ? interpolate(t, [0, Math.max(1, Math.round(0.05 * fps))], [0, 1], { extrapolateRight: "clamp" }) : 0;
  const size = isEmphasis ? style.fontSize : style.fontSize * 0.52;
  // duplicated drop shadow for the bold "pop" the tutorial calls out
  const shadow = "0 2px 7px rgba(0,0,0,0.55), 0 5px 18px rgba(0,0,0,0.45)";
  return (
    <span
      style={{
        // Vertical stack (default): the emphasis word claims a full flex row so
        // the others wrap above/below it — the reference's stacked layout (e.g.
        // giving / SPACE / to each other). Horizontal: everything flows on one
        // wrapped line. Toggled per-clip via style.verticalStack.
        flexBasis: isEmphasis && style.verticalStack !== false ? "100%" : "auto",
        textAlign: "center",
        fontFamily: fontStack,
        fontSize: size,
        fontWeight: isEmphasis ? 800 : 700,
        textTransform: uppercase ? "uppercase" : "none",
        lineHeight: 1,
        letterSpacing: "-0.01em",
        display: "inline-block",
        opacity,
        transform: `scale(${scale.toFixed(3)})`,
        color: isEmphasis ? style.highlightColor || style.fontColor : style.fontColor,
        textShadow: shadow,
      }}
    >
      {word}
    </span>
  );
};

// --- registry ---------------------------------------------------------------

export const CAPTION_TEMPLATES: CaptionTemplate[] = [
  classicTemplate("classic-pop", "Pop", "pop"),
  classicTemplate("classic-karaoke", "Karaoke", "karaoke"),
  classicTemplate("classic-highlight", "Highlight", "word-highlight"),
  classicTemplate("classic-bar", "Bar", "word-highlight", {
    fontSize: 48,
    highlightColor: "#FFFFFF",
    borderWidth: 0,
    bgOpacity: 0.65,
  }),
  classicTemplate("classic-clean", "Clean", "none"),
  {
    id: "hormozi",
    label: "Hormozi",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 4, maxChars: 22 },
    defaultStyle: { template: "hormozi", animation: "none", captionAnimation: "pop-in", wordAnimation: "none", emojiAnimation: "bounce-in", fontFamily: "Montserrat", fontSize: 74, fontColor: "#FFFFFF", highlightColor: "#FFE000", borderColor: "#000000", borderWidth: 7, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <HormoziWord {...args} />,
  },
  {
    id: "tiktok-bounce",
    label: "TikTok Bounce",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 4, maxChars: 24 },
    defaultStyle: { template: "tiktok-bounce", animation: "none", captionAnimation: "scale-bounce", wordAnimation: "none", emojiAnimation: "bounce-in-wiggle", fontFamily: "Inter", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#3DD68C", borderColor: "#000000", borderWidth: 4, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <TikTokBounceWord {...args} />,
  },
  {
    id: "typewriter",
    label: "Typewriter",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 5, maxChars: 28 },
    defaultStyle: { template: "typewriter", animation: "none", captionAnimation: "typewriter", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Inter", fontSize: 58, fontColor: "#FFFFFF", highlightColor: "#FFE000", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    extras: [{ key: "typeSpeed", label: "Type speed", min: 0.5, max: 3, step: 0.1, default: 1 }],
    renderWord: (args) => <TypewriterWord {...args} />,
  },
  {
    id: "mrbeast",
    label: "MrBeast",
    category: "effects",
    font: "Gabarito",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "mrbeast", animation: "none", captionAnimation: "scale-bounce", wordAnimation: "none", emojiAnimation: "bounce-in", fontFamily: "Gabarito", fontSize: 74, fontColor: "#FFFFFF", highlightColor: "#FFE000", borderColor: "#000000", borderWidth: 7, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <MrBeastWord {...args} />,
  },
  {
    id: "dynamic-minimal",
    label: "Minimal",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 5, maxChars: 30 },
    defaultStyle: { template: "dynamic-minimal", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Inter", fontSize: 60, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <MinimalWord {...args} />,
  },
  {
    id: "podcast",
    label: "Podcast",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 5, maxChars: 28 },
    defaultStyle: { template: "podcast", animation: "none", captionAnimation: "slide-up", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Inter", fontSize: 96, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    selfStacks: true,
    renderWord: (args) => <PodcastWord {...args} />,
  },
  {
    id: "glossy-gradient",
    label: "Glossy",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "glossy-gradient", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Montserrat", fontSize: 78, fontColor: "#FFFFFF", highlightColor: "#EAF2FF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <GlossyGradientWord {...args} />,
  },
  {
    id: "extrude-3d",
    label: "3D Extrude",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "extrude-3d", animation: "none", captionAnimation: "pop-in", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Anton", fontSize: 84, fontColor: "#FFFFFF", highlightColor: "#FFE45C", borderColor: "#141414", borderWidth: 2, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <Extrude3DWord {...args} />,
  },
  {
    id: "flip-3d",
    label: "3D Flip",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "flip-3d", animation: "none", captionAnimation: "rotate-wiggle-small", wordAnimation: "none", emojiAnimation: "rotate", fontFamily: "Montserrat", fontSize: 70, fontColor: "#F2F2F2", highlightColor: "#3DDC97", borderColor: "#0E0E0E", borderWidth: 2, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <Flip3DWord {...args} />,
  },
  {
    id: "whip-blur",
    label: "Whip Blur",
    category: "effects",
    font: "Outfit",
    grouping: { maxWords: 4, maxChars: 22 },
    defaultStyle: { template: "whip-blur", animation: "none", captionAnimation: "slide-up", wordAnimation: "none", emojiAnimation: "slide-up", fontFamily: "Outfit", fontSize: 66, fontColor: "#FFFFFF", highlightColor: "#FF4D6D", borderColor: "#111111", borderWidth: 2, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <WhipBlurWord {...args} />,
  },
  {
    id: "zoom-rush",
    label: "Zoom Rush",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "zoom-rush", animation: "none", captionAnimation: "zoom-in", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Anton", fontSize: 84, fontColor: "#FFFFFF", highlightColor: "#00E0FF", borderColor: "#0A0A0A", borderWidth: 2, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ZoomRushWord {...args} />,
  },
  {
    id: "squash-pop",
    label: "Squash Pop",
    category: "effects",
    font: "Gabarito",
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "squash-pop", animation: "none", captionAnimation: "scale-bounce", wordAnimation: "none", emojiAnimation: "bounce-in", fontFamily: "Gabarito", fontSize: 70, fontColor: "#FFFFFF", highlightColor: "#FFD23F", borderColor: "#1B1B1B", borderWidth: 3, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <SquashPopWord {...args} />,
  },
  {
    id: "chrome-shine",
    label: "Chrome",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "chrome-shine", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Anton", fontSize: 84, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#111111", borderWidth: 2, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ChromeShineWord {...args} />,
  },
  {
    id: "apple",
    label: "Apple",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 4, maxChars: 26 },
    defaultStyle: { template: "apple", animation: "none", captionAnimation: "slide-up", wordAnimation: "none", emojiAnimation: "fade-in", fontFamily: "Inter", fontSize: 62, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <AppleWord {...args} />,
  },
  {
    id: "glitch-rgb",
    label: "Glitch RGB",
    category: "effects",
    font: "Space Grotesk",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 22 },
    defaultStyle: {
      template: "glitch-rgb",
      animation: "none", captionAnimation: "blink-fade", wordAnimation: "none", emojiAnimation: "pop-in",
      fontFamily: "Space Grotesk",
      fontSize: 70,
      fontColor: "#FFFFFF",
      highlightColor: "#00E5FF",
      borderColor: "#000000",
      borderWidth: 0,
      bgColor: "#000000",
      bgOpacity: 0,
    },
    renderWord: (args) => <GlitchWord {...args} />,
  },
  {
    id: "matrix-decode",
    label: "Matrix",
    category: "effects",
    font: "Space Grotesk",
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: {
      template: "matrix-decode",
      animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale",
      fontFamily: "Space Grotesk",
      fontSize: 66,
      fontColor: "#00FF41",
      highlightColor: "#00FF41",
      borderColor: "#000000",
      borderWidth: 0,
      bgColor: "#000000",
      bgOpacity: 0,
    },
    extras: [{ key: "decodeSpeed", label: "Decode speed", min: 0.5, max: 2, step: 0.1, default: 1 }],
    renderWord: (args) => <MatrixWord {...args} />,
  },
  {
    id: "particle-burst",
    label: "Particle Burst",
    category: "effects",
    font: "Outfit",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: {
      template: "particle-burst",
      animation: "none", captionAnimation: "pop-in", wordAnimation: "none", emojiAnimation: "bounce-in",
      fontFamily: "Outfit",
      fontSize: 70,
      fontColor: "#FFFFFF",
      highlightColor: "#FFD700",
      borderColor: "#000000",
      borderWidth: 0,
      bgColor: "#000000",
      bgOpacity: 0,
    },
    renderWord: (args) => <ParticleWord {...args} />,
  },
  {
    id: "highlight",
    label: "Marker",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 4, maxChars: 22 },
    defaultStyle: { template: "highlight", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Montserrat", fontSize: 62, fontColor: "#FFFFFF", highlightColor: "#FFE94E", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <HighlightWord {...args} />,
  },
  {
    id: "gradient-fill",
    label: "Gradient",
    category: "effects",
    font: "Montserrat",
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "gradient-fill", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Montserrat", fontSize: 72, fontColor: "#FFFFFF", highlightColor: "#FF2063", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <GradientFillWord {...args} />,
  },
  {
    id: "neon-glow",
    label: "Neon Glow",
    category: "effects",
    font: "Outfit",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "neon-glow", animation: "none", captionAnimation: "blink-fade", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Outfit", fontSize: 66, fontColor: "#00FFF0", highlightColor: "#00FFF0", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <NeonGlowWord {...args} />,
  },
  {
    id: "neon-accent",
    label: "Neon Accent",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 4, maxChars: 22 },
    defaultStyle: { template: "neon-accent", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Montserrat", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#53FF01", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <NeonAccentWord {...args} />,
  },
  {
    id: "weight-shift",
    label: "Weight Shift",
    category: "effects",
    font: "Montserrat",
    grouping: { maxWords: 4, maxChars: 24 },
    defaultStyle: { template: "weight-shift", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Montserrat", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#FFDD00", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <WeightShiftWord {...args} />,
  },
  {
    id: "editorial-emphasis",
    label: "Editorial",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 4, maxChars: 26 },
    defaultStyle: { template: "editorial-emphasis", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "fade-in", fontFamily: "Inter", fontSize: 64, fontColor: "#F5F0D0", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <EditorialWord {...args} />,
  },
  {
    id: "emoji-pop",
    label: "Emoji Pop",
    category: "effects",
    font: "Gabarito",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "emoji-pop", animation: "none", captionAnimation: "pop-in", wordAnimation: "none", emojiAnimation: "bounce-in-wiggle", fontFamily: "Gabarito", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#FF76FF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <EmojiPopWord {...args} />,
  },
  {
    id: "kinetic-slam",
    label: "Kinetic Slam",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "kinetic-slam", animation: "none", captionAnimation: "slide-up-in", wordAnimation: "none", emojiAnimation: "bounce-in", fontFamily: "Anton", fontSize: 80, fontColor: "#FFFFFF", highlightColor: "#FFD700", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <KineticSlamWord {...args} />,
  },
  {
    id: "clip-wipe",
    label: "Clip Wipe",
    category: "effects",
    font: "Poppins",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "clip-wipe", animation: "none", captionAnimation: "border-reveal", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Poppins", fontSize: 66, fontColor: "#FFFFFF", highlightColor: "#FFD700", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ClipWipeWord {...args} />,
  },
  {
    id: "blend-difference",
    label: "Blend",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "blend-difference", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Montserrat", fontSize: 72, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <BlendDifferenceWord {...args} />,
  },
  {
    id: "parallax-layers",
    label: "Parallax",
    category: "effects",
    font: "Instrument Serif",
    grouping: { maxWords: 2, maxChars: 16 },
    defaultStyle: { template: "parallax-layers", animation: "none", captionAnimation: "slide-up", wordAnimation: "none", emojiAnimation: "fade-in", fontFamily: "Instrument Serif", fontSize: 108, fontColor: "#E50914", highlightColor: "#E50914", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ParallaxLayersWord {...args} />,
  },
  {
    id: "texture",
    label: "Texture",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "texture", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "scale", fontFamily: "Anton", fontSize: 78, fontColor: "#FFD0A0", highlightColor: "#FFAA44", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <TextureWord {...args} />,
  },
  {
    id: "pill-karaoke",
    label: "Pill",
    category: "effects",
    font: "Poppins",
    grouping: { maxWords: 4, maxChars: 24 },
    defaultStyle: { template: "pill-karaoke", animation: "none", captionAnimation: "fade-in", wordAnimation: "none", emojiAnimation: "pop-in", fontFamily: "Poppins", fontSize: 58, fontColor: "#A6A6A6", highlightColor: "#1C1E1D", borderColor: "#000000", borderWidth: 0, bgColor: "#E7E5E7", bgOpacity: 0 },
    containerStyle: () => ({ backgroundColor: "#E7E5E7", borderRadius: 22, padding: "10px 32px", boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }),
    renderWord: (args) => <PillKaraokeWord {...args} />,
  },
];

const ANIMATION_TO_TEMPLATE: Record<SubtitleAnimation, string> = {
  pop: "classic-pop",
  karaoke: "classic-karaoke",
  "word-highlight": "classic-highlight",
  none: "classic-clean",
};

/** Resolve the template id for a style, falling back via its legacy `animation`. */
export function resolveTemplateId(style: SubtitleStyle): string {
  if (style.template) return style.template;
  return ANIMATION_TO_TEMPLATE[style.animation] ?? "classic-pop";
}

export function getCaptionTemplate(id: string): CaptionTemplate {
  return CAPTION_TEMPLATES.find((t) => t.id === id) ?? CAPTION_TEMPLATES[0];
}
