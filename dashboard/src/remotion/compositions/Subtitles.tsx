import React, { useCallback, useEffect, useState } from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
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

function shadowFilter(style: SubtitleStyle): string | undefined {
  const preset = style.shadow && SHADOW_MAP[style.shadow];
  if (!preset) return undefined;
  const color = style.shadowColor ?? "#000000";
  return `drop-shadow(0 ${preset.oy}px ${preset.blur}px ${color})`;
}

/** How long a block lingers after its last word, clamped to the next block. */
const TAIL_MS = 320;
/** Block fade in/out length, in frames. */
const FADE_FRAMES = 4;

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
  const blocks = groupCaptionsIntoBlocks(config.captions, template.grouping);

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
        transform: "translate(-50%, -50%)",
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

  // Block-level fade so captions enter/leave smoothly instead of popping.
  // Short blocks need a smaller fade, otherwise the in/out points collide and
  // produce a non-increasing input range (interpolate throws on that).
  const fade = Math.min(FADE_FRAMES, Math.floor((durationFrames - 1) / 2));
  const opacity =
    fade >= 1
      ? interpolate(
          frame,
          [0, fade, durationFrames - fade, durationFrames],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        )
      : 1;

  return (
    <div
      style={{
        ...outerStyle,
        opacity,
        filter: shadowFilter(style),
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
            style.fontSize * 0.28
          )}px`,
          maxWidth: "88%",
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
          // Append the emoji to the word text so it lives inside the same
          // animated span the template renders (timing/animation still apply).
          const renderedText = word.emoji ? `${word.text} ${word.emoji}` : word.text;
          return (
            <React.Fragment key={i}>
              {template.renderWord({
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
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
