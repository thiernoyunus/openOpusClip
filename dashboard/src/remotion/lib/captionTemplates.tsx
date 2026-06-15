import React from "react";
import { interpolate, spring, random, Easing } from "remotion";
import type { SubtitleStyle, SubtitleAnimation } from "./types";
import type { GroupingOptions } from "./captions";

/**
 * Caption template system.
 *
 * A template owns how a single word looks and animates. Subtitles.tsx provides
 * the shared scaffold (timing, grouping, positioning, fade) and delegates each
 * word to `renderWord`. Classic templates reproduce the original 4 animations;
 * the "effects" templates are ports of the HeyGen HyperFrames caption styles
 * (GSAP timelines re-expressed as Remotion frame math).
 *
 * IMPORTANT: duplicated at remotion/src/lib/captionTemplates.tsx — keep in sync.
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
  /** Optional styling for the block wrapper (e.g. a background pill). */
  containerStyle?: (style: SubtitleStyle) => React.CSSProperties;
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
        fontWeight: 800,
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
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
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
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
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
  const dur = Math.max(1, Math.round(0.28 * fps));

  let display: string;
  if (t < 0) {
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
        fontWeight: 700,
        letterSpacing: "0.04em",
        color,
        textShadow: `0 0 10px ${color}99, 0 0 2px ${color}, 0 3px 10px rgba(0,0,0,0.5)`,
        display: "inline-block",
        whiteSpace: "pre",
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
        fontWeight: 900,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
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
const HighlightWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, frame, fps, wordStartFrame, style, fontStack }) => {
  const on = frame >= wordStartFrame;
  const t = frame - wordStartFrame;
  const scaleX = on ? interpolate(t, [0, Math.round(0.15 * fps)], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }) : 0;
  const marker = style.highlightColor || "#FFE94E";
  return (
    <span style={{ position: "relative", display: "inline-block", fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", color: on ? "#141414" : style.fontColor, textShadow: on ? "none" : "0 4px 14px rgba(0,0,0,0.45)", padding: "0 6px" }}>
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
    <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 900, letterSpacing: "0.03em", display: "inline-block", transform: `scale(${scale})`, backgroundImage: SIRI_GRADIENT, backgroundSize: "300% 100%", backgroundPosition: `${pos}% 0`, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.5))" }}>{word}</span>
  );
};

// neon-glow — dim base, the spoken word ignites with a neon glow
const NeonGlowWord: React.FC<WordRenderArgs> = ({ word, isActive, style, fontStack }) => {
  const neon = style.highlightColor || "#00FFF0";
  const color = isActive ? neon : withAlpha(neon, 0.16);
  const glow = isActive ? `0 0 8px ${neon}, 0 0 22px ${neon}, 0 0 44px ${withAlpha(neon, 0.5)}` : "none";
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.04em", color, textShadow: glow, display: "inline-block" }}>{word}</span>;
};

// neon-accent — white base, each word a punchy assigned accent when spoken
const NEON_ACCENTS = ["#53FF01", "#FF0002", "#FCFF00"];
const NeonAccentWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed }) => {
  const accent = NEON_ACCENTS[seed % NEON_ACCENTS.length];
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.1]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 800, textTransform: "uppercase", display: "inline-block", transform: `scale(${scale})`, color: isActive ? accent : style.fontColor, textShadow: isActive ? `0 0 12px ${withAlpha(accent, 0.6)}` : "0 4px 14px rgba(0,0,0,0.5)" }}>{word}</span>;
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
const EmojiPopWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack, seed }) => {
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.14]) : 1;
  const key = word.toLowerCase().replace(/[^a-z]/g, "");
  const emoji = EMOJI_MAP[key];
  return (
    <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 900, textTransform: "uppercase", display: "inline-block", transform: `scale(${scale})`, color: isActive ? EMOJI_ACCENTS[seed % EMOJI_ACCENTS.length] : style.fontColor, WebkitTextStroke: "3px #000000" }}>
      {word}
      {emoji ? <span style={{ WebkitTextStroke: "0", marginLeft: "0.18em" }}>{emoji}</span> : null}
    </span>
  );
};

// kinetic-slam — each word slams down into place with an overshoot
const KineticSlamWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  if (t < 0) return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, opacity: 0, display: "inline-block" }}>{word}</span>;
  const p = spring({ frame: t, fps, config: { mass: 0.6, stiffness: 200, damping: 9 }, durationInFrames: 16 });
  const y = interpolate(p, [0, 1], [-120, 0]);
  const opacity = interpolate(t, [0, Math.round(0.06 * fps)], [0, 1], { extrapolateRight: "clamp" });
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 400, textTransform: "uppercase", display: "inline-block", transform: `translateY(${y}px)`, opacity, color: isActive ? style.highlightColor : style.fontColor, textShadow: "0 6px 18px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// clip-wipe — each word is wiped in left-to-right
const ClipWipeWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const reveal = t < 0 ? 100 : interpolate(t, [0, Math.round(0.3 * fps)], [100, 0], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const color = isActive ? style.highlightColor || "#FFD700" : isPast ? "rgba(255,255,255,0.45)" : style.fontColor;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 800, textTransform: "uppercase", display: "inline-block", clipPath: `inset(0 ${reveal}% 0 0)`, color, textShadow: "0 4px 14px rgba(0,0,0,0.5)" }}>{word}</span>;
};

// blend-difference — text inverts against the footage via mix-blend-mode
const BlendDifferenceWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const scale = isActive ? interpolate(entrySpring(frame - wordStartFrame, fps), [0, 1], [1, 1.08]) : 1;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 900, textTransform: "uppercase", display: "inline-block", transform: `scale(${scale})`, color: "#ffffff", mixBlendMode: "difference" }}>{word}</span>;
};

// parallax-layers — bold serif with a scaled echo behind for depth
const ParallaxLayersWord: React.FC<WordRenderArgs> = ({ word, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const opacity = interpolate(t, [0, Math.round(0.18 * fps)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const c = style.fontColor || "#E50914";
  return (
    <span style={{ position: "relative", display: "inline-block", fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 400, lineHeight: 1, color: c, opacity, WebkitTextStroke: `2px ${c}` }}>
      <span aria-hidden="true" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%) scale(1.7)", opacity: 0.12, whiteSpace: "nowrap", pointerEvents: "none" }}>{word}</span>
      <span style={{ position: "relative", textShadow: "2px 4px 4px rgba(0,0,0,0.5)" }}>{word}</span>
    </span>
  );
};

// texture — warm gradient-filled display type with a fiery glow
const TextureWord: React.FC<WordRenderArgs> = ({ word, isActive, frame, fps, wordStartFrame, style, fontStack }) => {
  const t = frame - wordStartFrame;
  const scale = t >= 0 ? interpolate(entrySpring(t, fps), [0, 1], [0.88, 1]) : 0.88;
  const grad = isActive ? "linear-gradient(180deg,#ffe7c2,#ff9d3c)" : "linear-gradient(180deg,#ffd0a0,#ff7a18)";
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 400, textTransform: "uppercase", display: "inline-block", transform: `scale(${scale})`, backgroundImage: grad, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", color: "transparent", filter: "drop-shadow(0 4px 24px rgba(255,100,20,0.55))" }}>{word}</span>;
};

// pill-karaoke — gray words darken as spoken, inside a light rounded pill
const PillKaraokeWord: React.FC<WordRenderArgs> = ({ word, isActive, isPast, style, fontStack }) => {
  const spoken = isActive || isPast;
  return <span style={{ fontFamily: fontStack, fontSize: style.fontSize, fontWeight: 700, textTransform: "lowercase", color: spoken ? style.highlightColor || "#1C1E1D" : style.fontColor || "#A6A6A6", display: "inline-block" }}>{word}</span>;
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
    id: "glitch-rgb",
    label: "Glitch RGB",
    category: "effects",
    font: "Space Grotesk",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 22 },
    defaultStyle: {
      template: "glitch-rgb",
      animation: "none",
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
      animation: "none",
      fontFamily: "Space Grotesk",
      fontSize: 66,
      fontColor: "#00FF41",
      highlightColor: "#00FF41",
      borderColor: "#000000",
      borderWidth: 0,
      bgColor: "#000000",
      bgOpacity: 0,
    },
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
      animation: "none",
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
    defaultStyle: { template: "highlight", animation: "none", fontFamily: "Montserrat", fontSize: 62, fontColor: "#FFFFFF", highlightColor: "#FFE94E", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <HighlightWord {...args} />,
  },
  {
    id: "gradient-fill",
    label: "Gradient",
    category: "effects",
    font: "Montserrat",
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "gradient-fill", animation: "none", fontFamily: "Montserrat", fontSize: 72, fontColor: "#FFFFFF", highlightColor: "#FF2063", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <GradientFillWord {...args} />,
  },
  {
    id: "neon-glow",
    label: "Neon Glow",
    category: "effects",
    font: "Outfit",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "neon-glow", animation: "none", fontFamily: "Outfit", fontSize: 66, fontColor: "#00FFF0", highlightColor: "#00FFF0", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <NeonGlowWord {...args} />,
  },
  {
    id: "neon-accent",
    label: "Neon Accent",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 4, maxChars: 22 },
    defaultStyle: { template: "neon-accent", animation: "none", fontFamily: "Montserrat", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#53FF01", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <NeonAccentWord {...args} />,
  },
  {
    id: "weight-shift",
    label: "Weight Shift",
    category: "effects",
    font: "Montserrat",
    grouping: { maxWords: 4, maxChars: 24 },
    defaultStyle: { template: "weight-shift", animation: "none", fontFamily: "Montserrat", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#FFDD00", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <WeightShiftWord {...args} />,
  },
  {
    id: "editorial-emphasis",
    label: "Editorial",
    category: "effects",
    font: "Inter",
    grouping: { maxWords: 4, maxChars: 26 },
    defaultStyle: { template: "editorial-emphasis", animation: "none", fontFamily: "Inter", fontSize: 64, fontColor: "#F5F0D0", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <EditorialWord {...args} />,
  },
  {
    id: "emoji-pop",
    label: "Emoji Pop",
    category: "effects",
    font: "Gabarito",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "emoji-pop", animation: "none", fontFamily: "Gabarito", fontSize: 64, fontColor: "#FFFFFF", highlightColor: "#FF76FF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <EmojiPopWord {...args} />,
  },
  {
    id: "kinetic-slam",
    label: "Kinetic Slam",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "kinetic-slam", animation: "none", fontFamily: "Anton", fontSize: 80, fontColor: "#FFFFFF", highlightColor: "#FFD700", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <KineticSlamWord {...args} />,
  },
  {
    id: "clip-wipe",
    label: "Clip Wipe",
    category: "effects",
    font: "Poppins",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "clip-wipe", animation: "none", fontFamily: "Poppins", fontSize: 66, fontColor: "#FFFFFF", highlightColor: "#FFD700", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ClipWipeWord {...args} />,
  },
  {
    id: "blend-difference",
    label: "Blend",
    category: "effects",
    font: "Montserrat",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 20 },
    defaultStyle: { template: "blend-difference", animation: "none", fontFamily: "Montserrat", fontSize: 72, fontColor: "#FFFFFF", highlightColor: "#FFFFFF", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <BlendDifferenceWord {...args} />,
  },
  {
    id: "parallax-layers",
    label: "Parallax",
    category: "effects",
    font: "Instrument Serif",
    grouping: { maxWords: 2, maxChars: 16 },
    defaultStyle: { template: "parallax-layers", animation: "none", fontFamily: "Instrument Serif", fontSize: 108, fontColor: "#E50914", highlightColor: "#E50914", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <ParallaxLayersWord {...args} />,
  },
  {
    id: "texture",
    label: "Texture",
    category: "effects",
    font: "Anton",
    uppercase: true,
    grouping: { maxWords: 3, maxChars: 18 },
    defaultStyle: { template: "texture", animation: "none", fontFamily: "Anton", fontSize: 78, fontColor: "#FFD0A0", highlightColor: "#FFAA44", borderColor: "#000000", borderWidth: 0, bgColor: "#000000", bgOpacity: 0 },
    renderWord: (args) => <TextureWord {...args} />,
  },
  {
    id: "pill-karaoke",
    label: "Pill",
    category: "effects",
    font: "Poppins",
    grouping: { maxWords: 4, maxChars: 24 },
    defaultStyle: { template: "pill-karaoke", animation: "none", fontFamily: "Poppins", fontSize: 58, fontColor: "#A6A6A6", highlightColor: "#1C1E1D", borderColor: "#000000", borderWidth: 0, bgColor: "#E7E5E7", bgOpacity: 0 },
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
