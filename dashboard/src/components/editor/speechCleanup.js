/**
 * Speech cleanup detectors (Opus-style): scan the word-level transcript for
 * filler words and silent pauses and turn them into EDL cut ranges (source
 * frames). The caller dispatches the combined list as a single ADD_CUTS so the
 * whole cleanup is one undo step, and the cuts are fully reversible through the
 * existing cut/restore UI.
 *
 * Captions are `{ text, startMs, endMs }` with ms RELATIVE TO CLIP START. A
 * word maps to a source frame via `clipInFrame + round((ms/1000) * source.fps)`
 * (the same formula TranscriptPanel's wordToSource uses).
 */

/**
 * Common conversational fillers (lowercased, punctuation stripped before
 * matching). Multi-word phrases ("you know", "i mean") are matched verbatim;
 * their leading single tokens (um/uh/...) are also listed so a lone "um"
 * matches even when not part of a phrase.
 */
export const FILLER_WORDS = new Set([
    'um',
    'uh',
    'uhh',
    'umm',
    'er',
    'ah',
    'hmm',
    'like',
    'you know',
    'so',
    'basically',
    'actually',
    'literally',
    'right',
    'i mean',
    'kind of',
    'sort of',
]);

/** Lowercase and strip surrounding/embedded punctuation so "Um," matches "um". */
function cleanWord(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s']/gu, '')
        .trim();
}

/** Word's [start, end] in SOURCE frames. */
function wordToSourceFrames(word, framing) {
    const clipIn = framing.clipInFrame ?? 0;
    const fps = framing.source.fps;
    return {
        start: clipIn + Math.round((word.startMs / 1000) * fps),
        end: clipIn + Math.round((word.endMs / 1000) * fps),
    };
}

/**
 * Cuts for words whose cleaned text is a filler. Each cut is padded by ~1 frame
 * on each side (kept within the clip bounds) so the trim feels clean.
 */
export function detectFillerCuts(captions, framing) {
    if (!captions || captions.length === 0) return [];
    const clipIn = framing.clipInFrame ?? 0;
    const clipOut = framing.clipOutFrame ?? framing.source.durationFrames;
    const cuts = [];
    const push = (startSrc, endSrc) => {
        const startFrame = Math.max(clipIn, startSrc - 1);
        const endFrame = Math.min(clipOut, endSrc + 1);
        if (endFrame > startFrame) cuts.push({ startFrame, endFrame });
    };
    for (let i = 0; i < captions.length; i += 1) {
        const cleaned = cleanWord(captions[i].text);
        if (!cleaned) continue;
        // Look ahead one word so multi-word fillers ("you know", "i mean",
        // "kind of", "sort of") match — they can never match a single token.
        if (i < captions.length - 1) {
            const phrase = `${cleaned} ${cleanWord(captions[i + 1].text)}`;
            if (FILLER_WORDS.has(phrase)) {
                const { start } = wordToSourceFrames(captions[i], framing);
                const { end } = wordToSourceFrames(captions[i + 1], framing);
                push(start, end);
                i += 1; // consume both words of the phrase
                continue;
            }
        }
        if (FILLER_WORDS.has(cleaned)) {
            const { start, end } = wordToSourceFrames(captions[i], framing);
            push(start, end);
        }
    }
    return cuts;
}

/**
 * Cuts for silent pauses: for each adjacent word pair, if the gap between them
 * exceeds `thresholdMs`, cut the gap (from the previous word's end to the next
 * word's start) in source frames, leaving a ~80ms breathing margin on each side
 * so speech isn't clipped.
 */
export function detectPauseCuts(captions, framing, thresholdMs = 400) {
    if (!captions || captions.length < 2) return [];
    const clipIn = framing.clipInFrame ?? 0;
    const clipOut = framing.clipOutFrame ?? framing.source.durationFrames;
    const fps = framing.source.fps;
    const MARGIN_MS = 80;
    const cuts = [];
    for (let i = 0; i < captions.length - 1; i += 1) {
        const word = captions[i];
        const next = captions[i + 1];
        const gap = next.startMs - word.endMs;
        if (gap <= thresholdMs) continue;
        const gapStartMs = word.endMs + MARGIN_MS;
        const gapEndMs = next.startMs - MARGIN_MS;
        if (gapEndMs <= gapStartMs) continue;
        const startFrame = Math.max(clipIn, clipIn + Math.round((gapStartMs / 1000) * fps));
        const endFrame = Math.min(clipOut, clipIn + Math.round((gapEndMs / 1000) * fps));
        if (endFrame > startFrame) cuts.push({ startFrame, endFrame });
    }
    return cuts;
}
