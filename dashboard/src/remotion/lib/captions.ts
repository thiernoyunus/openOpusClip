import type { CaptionWord } from "./types";

export interface CaptionBlock {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  text: string;
}

export interface GroupingOptions {
  /** Hard cap on words per on-screen block. */
  maxWords?: number;
  /** Soft cap on characters; adding a word that would exceed this starts a new block. */
  maxChars?: number;
  /** A block never spans more than this long. */
  maxDurationMs?: number;
  /** A silent gap >= this between words forces a new block (natural pause). */
  pauseThresholdMs?: number;
}

const DEFAULTS: Required<GroupingOptions> = {
  maxWords: 4,
  maxChars: 24,
  maxDurationMs: 2500,
  pauseThresholdMs: 350,
};

const SENTENCE_END = /[.!?…]$/;
const SOFT_BREAK = /[,;:]$/;

/**
 * Groups word-level captions into display blocks. Unlike the old fixed
 * maxChars=20 chop, this respects sentence punctuation and natural pauses so
 * blocks break where a viewer expects them to — the same heuristic the
 * HyperFrames caption components use.
 */
export function groupCaptionsIntoBlocks(
  captions: CaptionWord[],
  options: GroupingOptions = {}
): CaptionBlock[] {
  const { maxWords, maxChars, maxDurationMs, pauseThresholdMs } = {
    ...DEFAULTS,
    ...options,
  };

  const blocks: CaptionBlock[] = [];
  let current: CaptionWord[] = [];
  let blockStartMs = 0;
  let charCount = 0;

  const flush = () => {
    if (current.length === 0) return;
    const last = current[current.length - 1];
    blocks.push({
      words: [...current],
      startMs: blockStartMs,
      endMs: last.endMs,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
    charCount = 0;
  };

  for (let i = 0; i < captions.length; i++) {
    const word = captions[i];
    const next = captions[i + 1];

    // Would adding this word overflow the current block? If so, close it first.
    if (current.length > 0) {
      const wouldChars = charCount + word.text.length + 1;
      const wouldDuration = word.endMs - blockStartMs;
      if (
        current.length >= maxWords ||
        wouldChars > maxChars ||
        wouldDuration > maxDurationMs
      ) {
        flush();
      }
    }

    if (current.length === 0) blockStartMs = word.startMs;
    current.push(word);
    charCount += word.text.length + 1;

    // Close on sentence end, on a soft break once the block has some words, on a
    // long pause before the next word, or when the word cap is reached.
    const pause = next ? next.startMs - word.endMs : Infinity;
    const endsSentence = SENTENCE_END.test(word.text);
    const softBreak = SOFT_BREAK.test(word.text) && current.length >= 2;
    if (
      current.length >= maxWords ||
      endsSentence ||
      softBreak ||
      pause >= pauseThresholdMs
    ) {
      flush();
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
