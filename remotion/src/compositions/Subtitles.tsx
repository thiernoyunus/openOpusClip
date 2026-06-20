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

function emojiStyle(
  style: SubtitleStyle,
  placement: "above-word" | "below-word",
  animation: NonNullable<SubtitleStyle["emojiAnimation"]>,
  frame: number,
  fps: number,
  wordStartFrame: number
): React.CSSProperties {
  const size = style.emojiSize ?? 1;
  const introFrames = Math.max(1, Math.round(0.25 * fps));
  const p = interpolate(frame, [wordStartFrame, wordStartFrame + introFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const popScale = animation === "pop" ? 0.45 + p * 0.65 : 1;
  const bounceY = animation === "bounce" ? -Math.sin(p * Math.PI) * style.fontSize * 0.18 : 0;
  const floatY = animation === "float" ? Math.sin((frame - wordStartFrame) / 6) * style.fontSize * 0.06 : 0;
  // Gap between the emoji and the caption word, scaled to the caption size so it
  // reads the same across font sizes. Anchor the emoji's near edge to the word
  // edge and push it away by the gap; with the matching transform-origin, larger
  // emojis grow away from the text instead of overlapping it.
  const gap = (style.emojiGap ?? 0.2) * style.fontSize;
  const isAbove = placement === "above-word";
  const anchor = isAbove ? { bottom: "100%" } : { top: "100%" };
  const gapOffset = isAbove ? -gap : gap;

  return {
    position: "absolute",
    left: "50%",
    ...anchor,
    fontSize: Math.round(style.fontSize * 0.82 * size),
    lineHeight: 1,
    opacity: p,
    transform: `translate(-50%, ${(gapOffset + bounceY + floatY).toFixed(1)}px) scale(${popScale.toFixed(3)})`,
    transformOrigin: isAbove ? "center bottom" : "center top",
    WebkitTextStroke: "none",
    textShadow: "none",
    filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.5))",
    pointerEvents: "none",
    zIndex: 2,
  };
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
  const blocks = groupCaptionsIntoBlocks(config.captions, grouping);

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

  // Free-drag placement wins when both x/y are set; otherwise fall back to the
  // top/middle/bottom preset (existing behavior, fully back-compat).
  const freePlaced =
    typeof config.x === "number" && typeof config.y === "number";
  const outerStyle: React.CSSProperties = freePlaced
    ? {
        position: "absolute",
        left: `${(config.x as number) * 100}%`,
        top: `${(config.y as number) * 100}%`,
        // A fixed width centered on the drag point so the inner block's
        // percentage maxWidth resolves predictably and long captions wrap
        // the same way they do in the preset layouts.
        width: "88%",
        display: "flex",
        justifyContent: "center",
      }
    : {
        position: "absolute",
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        ...(POSITION_MAP[position] ?? POSITION_MAP.bottom),
      };
  const containerStyle = template.containerStyle?.(style) ?? {};
  // Generic vertical stacking: lay the words out in a centered column. Templates
  // that draw their own stack (podcast's emphasis-aware layout) opt out and keep
  // the row-wrap container.
  const columnStack = !template.selfStacks && style.verticalStack === true;

  // Block entrance animation (layers over the per-word template animation).
  // The composed transform also carries the free-drag centering when placed.
  const entrance = style.captionAnimation ?? "fade";
  const introDur = Math.min(durationFrames, Math.max(1, Math.round(0.4 * fps)));
  const introP = interpolate(frame, [0, introDur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const slide =
    entrance === "slide-up" || entrance === "slide-up-zoom"
      ? `translateY(${((1 - introP) * 70).toFixed(1)}px)`
      : "";
  const zoom =
    entrance === "zoom-in" || entrance === "slide-up-zoom"
      ? `scale(${(0.7 + 0.3 * introP).toFixed(3)})`
      : "";
  const transform =
    [freePlaced ? "translate(-50%, -50%)" : "", slide, zoom]
      .filter(Boolean)
      .join(" ") || undefined;

  // Block-level fade so captions enter/leave smoothly instead of popping.
  // Short blocks need a smaller fade, otherwise the in/out points collide and
  // produce a non-increasing input range (interpolate throws on that).
  // "none" entrance opts out of the fade entirely (hard cut).
  const fade = Math.min(FADE_FRAMES, Math.floor((durationFrames - 1) / 2));
  const opacity =
    entrance === "none" || fade < 1
      ? 1
      : interpolate(
          frame,
          [0, fade, durationFrames - fade, durationFrames],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

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
          display: "flex",
          flexDirection: columnStack ? "column" : "row",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
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
              ? word.text.replace(/[.,!?;:…]+$/u, "")
              : word.text;
          const emojiPlacement = style.emojiPlacement ?? "above-word";
          const emojiAnimation = style.emojiAnimation ?? "pop";
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
          });

          if (!word.emoji || emojiPlacement === "none" || emojiPlacement === "inline") {
            return <React.Fragment key={i}>{renderedWord}</React.Fragment>;
          }

          return (
            <span
              key={i}
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {renderedWord}
              <span
                style={emojiStyle(
                  style,
                  emojiPlacement,
                  emojiAnimation,
                  frame,
                  fps,
                  wordStartFrame
                )}
              >
                {word.emoji}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
};
