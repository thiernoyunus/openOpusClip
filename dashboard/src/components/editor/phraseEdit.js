/**
 * Pure helpers for editing a selected phrase (several caption words) in the
 * transcript: retype its text, or give it one emoji that stays on screen for
 * as long as the phrase is. Each takes the caption array and returns a new one.
 */

const EMOJI_KEYS = ['emoji', 'emojiAnimated', 'emojiAuto', 'emojiSpan'];

function withoutEmoji(word) {
    const next = { ...word };
    EMOJI_KEYS.forEach((k) => delete next[k]);
    return next;
}

/** Every caption index sharing `index`'s phrase emoji (just `index` when none). */
export function spanIndices(captions, index) {
    const span = captions[index]?.emojiSpan;
    if (!span) return [index];
    const out = [];
    captions.forEach((w, i) => {
        if (w.emojiSpan === span) out.push(i);
    });
    return out;
}

/**
 * Put one emoji on a phrase. Every word gets the emoji plus a shared
 * `emojiSpan` id, which tells the renderer to show it once per caption block
 * for the phrase's whole duration. A single word stays a plain word emoji.
 * Picked by hand, so a later AI pass leaves it alone (no emojiAuto).
 */
export function setPhraseEmoji(captions, indices, emoji, animated) {
    const set = new Set(indices);
    const span = set.size > 1 ? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : null;
    return captions.map((w, i) => {
        if (!set.has(i)) return w;
        const next = { ...withoutEmoji(w), emoji, emojiAnimated: animated === true };
        if (span) next.emojiSpan = span;
        return next;
    });
}

/**
 * Take the emoji off the given words, and off the rest of any phrase they
 * belong to, so removing a phrase emoji from one of its words removes it
 * everywhere it shows.
 */
export function clearEmojis(captions, indices) {
    const set = new Set(indices);
    const spans = new Set(indices.map((i) => captions[i]?.emojiSpan).filter(Boolean));
    return captions.map((w, i) => (set.has(i) || (w.emojiSpan && spans.has(w.emojiSpan)) ? withoutEmoji(w) : w));
}

/**
 * Replace the text of a phrase. Same word count: each word keeps its own
 * timing and styling and just takes the new text. Different count: the new
 * words share the phrase's spoken time, longer words getting more of it, and
 * each takes the styling of the old word it lands on. Empty text is a no-op
 * (removing words is what Remove caption is for).
 */
export function retextPhrase(captions, indices, text) {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || indices.length === 0) return captions;
    const old = [...indices].sort((a, b) => captions[a].startMs - captions[b].startMs || a - b);

    if (tokens.length === old.length) {
        const next = [...captions];
        old.forEach((idx, k) => {
            next[idx] = { ...captions[idx], text: tokens[k] };
        });
        return next;
    }

    // Lay the old words' spoken time end to end (skipping any gaps between
    // them) and hand it out to the new words by character count.
    const slots = old.map((idx) => ({ idx, start: captions[idx].startMs, end: captions[idx].endMs }));
    const total = slots.reduce((s, x) => s + Math.max(0, x.end - x.start), 0);
    const weights = tokens.map((t) => Math.max(1, [...t].length));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // Position on the laid-out timeline -> {slot, ms}. `atStart` puts a point
    // that sits exactly on a slot boundary at the start of the next slot.
    const locate = (t, atStart) => {
        let acc = 0;
        for (let s = 0; s < slots.length; s++) {
            const len = Math.max(0, slots[s].end - slots[s].start);
            const last = s === slots.length - 1;
            if (t < acc + len || (!atStart && t <= acc + len) || last) {
                return { s, ms: slots[s].start + Math.min(len, Math.max(0, t - acc)) };
            }
            acc += len;
        }
        return { s: 0, ms: slots[0].start };
    };

    const used = new Set();
    let cum = 0;
    const fresh = tokens.map((token, k) => {
        const a = total > 0 ? (cum / weightSum) * total : 0;
        cum += weights[k];
        const b = total > 0 ? (cum / weightSum) * total : 0;
        const from = total > 0 ? locate(a, true) : { s: Math.min(slots.length - 1, Math.floor((k * slots.length) / tokens.length)), ms: 0 };
        const slot = slots[from.s];
        const to = total > 0 ? locate(b, false) : null;
        const startMs = total > 0 ? from.ms : slot.start + ((slot.end - slot.start) * k) / tokens.length;
        let endMs = total > 0 ? to.ms : slot.start + ((slot.end - slot.start) * (k + 1)) / tokens.length;
        // A word whose middle falls in a gap between two old words (say a
        // pause that was cut) would vanish from the video, so it stops at the
        // end of the word it starts in instead.
        const mid = (startMs + endMs) / 2;
        if (!slots.some((x) => mid >= x.start && mid <= x.end)) endMs = slot.end;
        const base = captions[slot.idx];
        // Styling comes from the old word underneath; a single-word emoji is
        // kept once, not copied onto every new word that lands on it.
        const word = { ...(used.has(slot.idx) && !base.emojiSpan ? withoutEmoji(base) : base) };
        used.add(slot.idx);
        word.text = token;
        word.startMs = Math.round(startMs);
        word.endMs = Math.max(Math.round(startMs), Math.round(endMs));
        return word;
    });

    // Drop the old words, then slot each new one in by start time so the
    // array stays in time order (the transcript groups words assuming it).
    const drop = new Set(old);
    const next = captions.filter((_, i) => !drop.has(i));
    fresh.forEach((w) => {
        let lo = 0;
        let hi = next.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (next[m].startMs <= w.startMs) lo = m + 1;
            else hi = m;
        }
        next.splice(lo, 0, w);
    });
    return next;
}
