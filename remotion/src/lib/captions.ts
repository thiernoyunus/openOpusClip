import type { CaptionWord } from "./types";
import { isRTL } from "./rtl";

export interface CaptionBlock {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  text: string;
}

export interface GroupingOptions {
  /**
   * HARD ceiling on words per block — the user's "Display words" choice. A block
   * never shows more than this; a phrase longer than it IS split (as evenly as
   * possible), a phrase that fits stays whole.
   */
  maxWords?: number;
  /** Char ceiling (also hard). */
  maxChars?: number;
  /** Duration ceiling (ms). */
  maxDurationMs?: number;
  /** A silent gap >= this between words is a natural pause boundary. */
  pauseThresholdMs?: number;
  /** A gap < this means the words are co-articulated (bonded) — kept together when possible, e.g. "ice cream". */
  bondGapMs?: number;
}

const DEFAULTS: Required<GroupingOptions> = {
  maxWords: 4,
  maxChars: 24,
  maxDurationMs: 2500,
  pauseThresholdMs: 350,
  bondGapMs: 120,
};

// Latin + Arabic punctuation. Sentence-end tolerates one trailing quote (victory.").
const SENTENCE_END = /[.!?…؟۔]["'”’»]?$/;
const SOFT_BREAK = /[,;:،؛]$/;

/** Cohesion key: explicit per-word language if present, else script via isRTL. */
const cohesionKey = (w: CaptionWord): string =>
  w.language ?? (isRTL(w.text) ? "rtl" : "ltr");

/** The clip's dominant cohesion key — its "base" language. */
function dominantKey(captions: CaptionWord[]): string {
  const counts = new Map<string, number>();
  for (const w of captions) {
    const k = cohesionKey(w);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = "ltr";
  let n = -1;
  for (const [k, c] of counts) if (c > n) { n = c; best = k; }
  return best;
}

/**
 * Mark words that belong to a "foreign phrase": a contiguous run whose cohesion
 * key differs from the clip's dominant key AND is >= 2 words long (e.g. an
 * Arabic hadith quote inside an English talk). Such a run is kept together as
 * one unit. A LONE foreign word (run of 1, e.g. "Allah" inside Arabic) is NOT
 * marked, so it stays in the base-language flow instead of being isolated.
 */
function markForeignPhrases(captions: CaptionWord[], base: string): boolean[] {
  const mark = new Array(captions.length).fill(false);
  let i = 0;
  while (i < captions.length) {
    const k = cohesionKey(captions[i]);
    let j = i + 1;
    while (j < captions.length && cohesionKey(captions[j]) === k) j++;
    if (k !== base && j - i >= 2) for (let x = i; x < j; x++) mark[x] = true;
    i = j;
  }
  return mark;
}

/**
 * Groups word-level captions into SHORT reel blocks that never split a phrase
 * the viewer reads as a unit. Two cohesion rules layer over the size caps:
 *
 *  1. A foreign-language run (cohesion != the clip's base language, >= 2 words)
 *     — e.g. an Arabic quote inside an English talk — is emitted as its own
 *     block, kept whole regardless of any internal pause. This is the "العاقبة
 *     للمتقين stays on one caption" fix.
 *  2. Base-language words follow normal reel cadence: break early at sentence
 *     ends, soft punctuation, and real pauses. The "Display words" count
 *     (maxWords) is a HARD ceiling — a block never exceeds it. When a run hits
 *     the ceiling with no natural break, it is split at its LOOSEST internal
 *     seam (the largest micro-gap) so a co-articulated tail like "ice cream"
 *     carries to the next block instead of being cut in half.
 *
 * So the slider and cohesion combine cleanly: a phrase that FITS in your chosen
 * word count stays whole; a phrase LONGER than it is split (as evenly as the
 * gaps allow) to honour your count.
 *
 * Back-compat: an English-only clip has no foreign runs — pure base cadence,
 * same as before but respecting maxWords as a true ceiling and avoiding bonded
 * cuts. Whisper data (no per-word language) falls back to script via isRTL.
 * Grouping is recomputed at render time, so saved projects regroup, no migration.
 */
export function groupCaptionsIntoBlocks(
  captions: CaptionWord[],
  options: GroupingOptions = {}
): CaptionBlock[] {
  const opts = { ...DEFAULTS, ...options };
  if (captions.length === 0) return [];

  const base = dominantKey(captions);
  const isForeign = markForeignPhrases(captions, base);

  const blocks: CaptionBlock[] = [];
  let current: CaptionWord[] = [];

  const emit = (words: CaptionWord[]) => {
    if (words.length === 0) return;
    blocks.push({
      words: [...words],
      startMs: words[0].startMs,
      endMs: words[words.length - 1].endMs,
      text: words.map((w) => w.text).join(" "),
    });
  };
  const flush = () => { emit(current); current = []; };
  const charLen = (ws: CaptionWord[]) =>
    ws.reduce((n, w) => n + w.text.length + 1, 0);

  // current is full (== maxWords) and the next word can't be added: emit a head
  // and carry a tail, cutting at the loosest internal seam (largest gap >=
  // bondGapMs) so the most-bonded trailing words stay together. If every seam is
  // co-articulated, emit the whole block (no better cut exists).
  const splitAtLoosestSeam = () => {
    let cutAfter = -1;
    let widest = opts.bondGapMs; // only worth cutting at a real seam
    for (let k = 0; k < current.length - 1; k++) {
      const g = current[k + 1].startMs - current[k].endMs;
      if (g >= widest) { widest = g; cutAfter = k; }
    }
    if (cutAfter === -1) { flush(); return; }
    emit(current.slice(0, cutAfter + 1));
    current = current.slice(cutAfter + 1);
  };

  for (let i = 0; i < captions.length; i++) {
    // Foreign phrase: emit it as its own block(s), never merged with base text.
    if (isForeign[i]) {
      flush();
      let j = i;
      while (j < captions.length && isForeign[j]) j++;
      const phrase = captions.slice(i, j);
      // Usually one chunk (a 2-4 word quote). A quote longer than the word count
      // is split into BALANCED chunks (a 5-word phrase is [3][2], never [4][1]).
      const nChunks = Math.ceil(phrase.length / opts.maxWords);
      const size = Math.ceil(phrase.length / nChunks);
      for (let s = 0; s < phrase.length; s += size) emit(phrase.slice(s, s + size));
      i = j - 1;
      continue;
    }

    const word = captions[i];
    current.push(word);
    const next = captions[i + 1];

    // Strong breaks: sentence end, end of stream, or the next word opens a
    // foreign phrase. (current is always <= maxWords here, so this is safe.)
    if (SENTENCE_END.test(word.text) || !next || isForeign[i + 1]) {
      flush();
      continue;
    }

    const gap = next.startMs - word.endMs;
    const softBreak = SOFT_BREAK.test(word.text) && current.length >= 2;
    // Natural reel cadence: break early at a soft-punctuation seam or a real pause.
    if (softBreak || gap >= opts.pauseThresholdMs) {
      flush();
      continue;
    }

    // Hard ceiling (the user's word count, plus char/duration guards): never
    // exceed it — break at the loosest seam so a bonded tail carries over.
    const durationMs = word.endMs - current[0].startMs;
    if (
      current.length >= opts.maxWords ||
      charLen(current) > opts.maxChars ||
      durationMs >= opts.maxDurationMs
    ) {
      splitAtLoosestSeam();
    }
  }

  flush();
  return blocks;
}

/**
 * Index of the word that is "live" at a given time. Unlike a strict
 * start<=t<end test, this keeps the most recently started word active through
 * the silent gaps between words, so a highlight never flickers off mid-block.
 * Returns -1 only before the first word starts.
 */
export function getActiveWordIndex(
  words: CaptionWord[],
  timeMs: number
): number {
  let active = -1;
  for (let i = 0; i < words.length; i++) {
    if (timeMs >= words[i].startMs) active = i;
    else break;
  }
  return active;
}
