import { z } from "zod";

// --- Word-level caption ---
export interface CaptionWord {
  text: string;
  startMs: number;
  endMs: number;
  /**
   * Optional emoji attached to this word (AI-inserted or manual). Display style
   * controls decide whether it renders inline, above, below, or hidden.
   */
  emoji?: string;
  /**
   * When true, this word is a highlighted keyword and gets the active-word
   * highlight treatment even when it isn't the word currently being spoken.
   * Optional → existing caption data is unaffected (back-compat).
   */
  highlight?: boolean;
}

// --- Subtitle config ---
export type SubtitleAnimation = "none" | "word-highlight" | "pop" | "karaoke";
export type SubtitlePosition = "top" | "middle" | "bottom";
export type SubtitleEmojiPlacement = "none" | "above-word" | "below-word" | "inline";
export type SubtitleEmojiAnimation = "none" | "pop" | "bounce" | "float";

export type SubtitleShadow = "none" | "small" | "medium" | "large";
export type SubtitleEntrance =
  | "none"
  | "fade"
  | "slide-up"
  | "zoom-in"
  | "slide-up-zoom";

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  highlightColor: string;
  borderColor: string;
  borderWidth: number;
  bgColor: string;
  bgOpacity: number;
  animation: SubtitleAnimation;
  /**
   * Caption template id (see captionTemplates.tsx). Optional for back-compat:
   * when absent the renderer derives a "classic" template from `animation`.
   */
  template?: string;
  // --- Tier 2 customization overrides (all optional → back-compat). ---
  /** Per-word font weight 100–900. When unset each template uses its designed weight. */
  fontWeight?: number;
  /** Override the template's baked uppercase behavior. */
  uppercase?: boolean;
  /** Drop shadow applied to the whole caption block (size preset). */
  shadow?: SubtitleShadow;
  /** Drop shadow color (defaults to black). */
  shadowColor?: string;
  /** Max words per on-screen block (overrides the template's grouping). */
  maxWords?: number;
  /** Extra spacing between letters, in em (inherited by word spans). */
  letterSpacing?: number;
  /** Multiplier on the horizontal gap between words (1 = template default). */
  wordSpacing?: number;
  /** Block entrance animation, layered over the per-word template animation. */
  captionAnimation?: SubtitleEntrance;
  /** When false, trailing punctuation is stripped from displayed words. */
  punctuation?: boolean;
  /** Per-template tunables (e.g. typewriter/matrix speed), keyed by control. */
  effectParams?: Record<string, number>;
  /**
   * Podcast template: stack the emphasized word on its own line (vertical) vs
   * flow all words on one wrapped line (horizontal). Defaults to vertical.
   * Generic toggle for other templates too (column vs row), default horizontal.
   */
  verticalStack?: boolean;
  /** Glow effect on the caption block (a colored blur halo behind the text). */
  glow?: boolean;
  /** Glow color (defaults to white). */
  glowColor?: string;
  /** Glow strength 0–100 (mapped to a font-size-relative blur). Default 30. */
  glowIntensity?: number;
  /** Where word-attached emojis render. Defaults to above-word. */
  emojiPlacement?: SubtitleEmojiPlacement;
  /** Native emoji motion preset. Defaults to pop. */
  emojiAnimation?: SubtitleEmojiAnimation;
  /** Emoji size multiplier relative to caption text. Defaults to 1. */
  emojiSize?: number;
  /**
   * Gap between an above/below emoji and the caption word, as a fraction of the
   * caption font size (0.2 = 20%). Larger values push the emoji further away.
   * Defaults to 0.2.
   */
  emojiGap?: number;
}

export interface SubtitleConfig {
  captions: CaptionWord[];
  position: SubtitlePosition;
  style: SubtitleStyle;
  /**
   * Free-drag caption placement. Normalized 0..1, center-anchored, relative to
   * the 9:16 frame. When BOTH are present they override `position`; when absent
   * the top/middle/bottom preset is used (back-compat default).
   */
  x?: number;
  y?: number;
}

// --- Hook config ---
export type HookPosition = "top" | "center" | "bottom";
export type HookSize = "S" | "M" | "L";
export type HookEntrance = "spring" | "fade" | "slide-up" | "none";

export interface HookConfig {
  text: string;
  position: HookPosition;
  size: HookSize;
  entranceAnimation: HookEntrance;
  displayDurationSec: number;
}

// --- Effects config ---
export interface EffectSegment {
  startSec: number;
  endSec: number;
  zoom: number;
  zoomCenterX: number;
  zoomCenterY: number;
  brightness: number;
  contrast: number;
  saturate: number;
}

export interface EffectsConfig {
  segments: EffectSegment[];
}

// --- Framing config (non-destructive reframing, schema: docs/video-editor-plan.md §2) ---
// All coordinates are normalized 0-1 relative to the SOURCE video frame.
// All frame numbers are in SOURCE fps (framing.source.fps), not composition fps.
export type FramingLayout =
  | "fill"
  | "fit"
  | "split"
  | "three"
  | "four"
  | "screenshare"
  | "gameplay";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraKeyframe extends CropRect {
  frame: number;
}

export interface FaceSample extends CropRect {
  frame: number;
}

export interface FaceTrack {
  id: number;
  samples: FaceSample[];
}

export interface FramingSegment {
  id: string;
  startFrame: number;
  endFrame: number; // exclusive
  layout: FramingLayout;
  trackedFaceIds: number[]; // one per panel, reading order
  cameraKeyframes: CameraKeyframe[];
  manualCrop: CropRect | null; // user override; wins over keyframes/tracks
}

/**
 * v3 timeline clip — the main video track is an ORDERED list of these; the
 * array index is the playback order, decoupled from source time (so clips can
 * be reordered/duplicated/inserted). A clip is a slice of the source video
 * [sourceStart, sourceEnd) carrying the same framing decision a v2 segment did.
 * cameraKeyframes[].frame stay ABSOLUTE source frames (a clip reads the subset
 * that falls inside its range).
 */
export interface TimelineClip {
  id: string;
  sourceStart: number; // SOURCE frames, 0 <= sourceStart < sourceEnd <= source.durationFrames
  sourceEnd: number; // exclusive
  layout: FramingLayout;
  trackedFaceIds: number[]; // one per panel, reading order
  cameraKeyframes: CameraKeyframe[];
  manualCrop: CropRect | null;
}

export interface FramingSource {
  file: string;
  fps: number;
  width: number;
  height: number;
  durationFrames: number;
}

/** Removed source range (EDL cut). Sorted, non-overlapping, inside clip bounds. */
export interface SourceCut {
  startFrame: number;
  endFrame: number; // exclusive
}

/** Text overlay track (max 5). Frame times in SOURCE frames, EDL-mapped. */
export interface TextOverlay {
  id: string;
  text: string;
  startFrame: number;
  endFrame: number;
  x: number; // normalized center 0-1
  y: number;
  size: "S" | "M" | "L";
  color: string;
  bg: boolean;
}

export interface MusicConfig {
  url: string;
  volume: number; // 0-1
  originalVolume: number; // 0-1, applied to the source video audio
}

export interface TransitionsConfig {
  fadeIn: boolean;
  fadeOut: boolean;
  cutCrossfade: boolean;
  /**
   * Style of the smooth cut at internal boundaries. 'dip' = dip-to-black
   * (current behavior), 'zoom' = brief zoom punch on the footage. Back-compat:
   * when undefined and cutCrossfade is true, treat as 'dip'.
   */
  cutStyle?: "dip" | "zoom";
}

export interface BrollItem {
  id: string;
  url: string;
  startFrame: number; // SOURCE frames, EDL-mapped
  endFrame: number;
}

export interface FramingConfig {
  version: number;
  source: FramingSource;
  faceTracks: FaceTrack[];
  /**
   * v3 main track: an ordered list of clips. When present this is the single
   * source of truth for what plays and in what order. The editor migrates v1/v2
   * files to this on load (see useEditorState.normalizeFraming).
   */
  clips?: TimelineClip[];
  /**
   * v1/v2 legacy: contiguous, source-ordered layout segments. Optional now —
   * v3 files omit it. Kept so old saved files still load and migrate.
   */
  segments?: FramingSegment[];
  /**
   * v2 (EDL): playable content = [clipInFrame, clipOutFrame] minus cuts.
   * v1 files omit these; consumers default to 0..durationFrames with no cuts.
   * v3: legacy/back-compat only — superseded by clips[]; not consulted by EDL math.
   */
  clipInFrame?: number;
  clipOutFrame?: number;
  /**
   * The clipInFrame value captured when the caption transcript was generated
   * (the ORIGINAL clip start). Caption word ms are relative to this immutable
   * source frame, not the mutable clipInFrame, so trimming the head doesn't
   * shift subtitles. Optional/back-compat: consumers fall back to clipInFrame.
   */
  captionsOriginFrame?: number;
  cuts?: SourceCut[];
  subtitles?: SubtitleConfig | null;
  textOverlays?: TextOverlay[];
  music?: MusicConfig | null;
  transitions?: TransitionsConfig;
  broll?: BrollItem[];
}

// --- Main composition props ---
export interface ShortVideoProps {
  videoUrl: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  subtitles: SubtitleConfig | null;
  hook: HookConfig | null;
  effects: EffectsConfig | null;
  /** 16:9 original clip; when set together with `framing`, it replaces videoUrl as the base layer */
  sourceVideoUrl?: string | null;
  framing?: FramingConfig | null;
}

// --- Zod schemas for validation (used by render service) ---
export const captionWordSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  emoji: z.string().optional(),
  highlight: z.boolean().optional(),
});

export const subtitleStyleSchema = z.object({
  fontFamily: z.string(),
  fontSize: z.number(),
  fontColor: z.string(),
  highlightColor: z.string(),
  borderColor: z.string(),
  borderWidth: z.number(),
  bgColor: z.string(),
  bgOpacity: z.number().min(0).max(1),
  animation: z.enum(["none", "word-highlight", "pop", "karaoke"]),
  template: z.string().optional(),
  fontWeight: z.number().optional(),
  uppercase: z.boolean().optional(),
  shadow: z.enum(["none", "small", "medium", "large"]).optional(),
  shadowColor: z.string().optional(),
  maxWords: z.number().int().min(1).max(8).optional(),
  letterSpacing: z.number().optional(),
  wordSpacing: z.number().optional(),
  captionAnimation: z
    .enum(["none", "fade", "slide-up", "zoom-in", "slide-up-zoom"])
    .optional(),
  punctuation: z.boolean().optional(),
  effectParams: z.record(z.string(), z.number()).optional(),
  verticalStack: z.boolean().optional(),
  glow: z.boolean().optional(),
  glowColor: z.string().optional(),
  glowIntensity: z.number().min(0).max(100).optional(),
  emojiPlacement: z.enum(["none", "above-word", "below-word", "inline"]).optional(),
  emojiAnimation: z.enum(["none", "pop", "bounce", "float"]).optional(),
  emojiSize: z.number().min(0.5).max(4).optional(),
  emojiGap: z.number().min(0).max(1).optional(),
});

export const subtitleConfigSchema = z.object({
  captions: z.array(captionWordSchema),
  position: z.enum(["top", "middle", "bottom"]),
  style: subtitleStyleSchema,
  // Free-drag placement (normalized, center-anchored). Optional → existing
  // configs without x/y still validate and fall back to `position`.
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});

export const hookConfigSchema = z.object({
  text: z.string(),
  position: z.enum(["top", "center", "bottom"]),
  size: z.enum(["S", "M", "L"]),
  entranceAnimation: z.enum(["spring", "fade", "slide-up", "none"]),
  displayDurationSec: z.number().positive(),
});

export const effectSegmentSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  zoom: z.number().min(0.5).max(3),
  zoomCenterX: z.number().min(0).max(1),
  zoomCenterY: z.number().min(0).max(1),
  brightness: z.number().min(0).max(3),
  contrast: z.number().min(0).max(3),
  saturate: z.number().min(0).max(3),
});

export const effectsConfigSchema = z.object({
  segments: z.array(effectSegmentSchema),
});

export const cropRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const cameraKeyframeSchema = cropRectSchema.extend({
  frame: z.number().int().min(0),
});

export const faceTrackSchema = z.object({
  id: z.number().int().min(0),
  samples: z.array(cameraKeyframeSchema),
});

export const framingSegmentSchema = z.object({
  id: z.string(),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
  layout: z.enum(["fill", "fit", "split", "three", "four", "screenshare", "gameplay"]),
  trackedFaceIds: z.array(z.number().int()),
  cameraKeyframes: z.array(cameraKeyframeSchema),
  manualCrop: cropRectSchema.nullable(),
});

export const timelineClipSchema = z.object({
  id: z.string(),
  sourceStart: z.number().int().min(0),
  sourceEnd: z.number().int().positive(),
  layout: z.enum(["fill", "fit", "split", "three", "four", "screenshare", "gameplay"]),
  trackedFaceIds: z.array(z.number().int()),
  cameraKeyframes: z.array(cameraKeyframeSchema),
  manualCrop: cropRectSchema.nullable(),
});

export const sourceCutSchema = z.object({
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
});

export const textOverlaySchema = z.object({
  id: z.string(),
  text: z.string(),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  size: z.enum(["S", "M", "L"]),
  color: z.string(),
  bg: z.boolean(),
});

export const musicConfigSchema = z.object({
  url: z.string(),
  volume: z.number().min(0).max(1),
  originalVolume: z.number().min(0).max(1),
});

export const transitionsConfigSchema = z.object({
  fadeIn: z.boolean(),
  fadeOut: z.boolean(),
  cutCrossfade: z.boolean(),
  cutStyle: z.enum(["dip", "zoom"]).optional(),
});

export const brollItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
});

export const framingConfigSchema = z.object({
  version: z.number().int(),
  source: z.object({
    file: z.string(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationFrames: z.number().int().positive(),
  }),
  // v3 main track. MUST be in the schema: the render path enforces this schema
  // via Remotion selectComposition, and zod strips unknown keys — an unlisted
  // `clips` would be dropped and v3 renders would come out empty.
  clips: z.array(timelineClipSchema).optional(),
  // v1/v2 legacy layout segments — optional so v3 files (which omit it) validate
  segments: z.array(framingSegmentSchema).optional(),
  faceTracks: z.array(faceTrackSchema),
  // v2 EDL + feature payloads — optional so v1 files still validate
  clipInFrame: z.number().int().min(0).optional(),
  clipOutFrame: z.number().int().positive().optional(),
  captionsOriginFrame: z.number().int().min(0).optional(),
  cuts: z.array(sourceCutSchema).optional(),
  subtitles: subtitleConfigSchema.nullable().optional(),
  textOverlays: z.array(textOverlaySchema).optional(),
  music: musicConfigSchema.nullable().optional(),
  transitions: transitionsConfigSchema.optional(),
  broll: z.array(brollItemSchema).optional(),
});

export const shortVideoPropsSchema = z.object({
  videoUrl: z.string(),
  durationInFrames: z.number().int().positive(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  subtitles: subtitleConfigSchema.nullable(),
  hook: hookConfigSchema.nullable(),
  effects: effectsConfigSchema.nullable(),
  sourceVideoUrl: z.string().nullable().optional(),
  framing: framingConfigSchema.nullable().optional(),
});
