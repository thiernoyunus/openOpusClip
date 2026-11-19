/**
 * Assert-based self-check for phrase editing. No framework.
 * Run: `npm run test:phrase` (from dashboard/).
 */
import assert from 'node:assert';
import { retextPhrase, setPhraseEmoji, clearEmojis, spanIndices } from './phraseEdit.js';

const words = [
    { text: 'AI', startMs: 0, endMs: 200 },
    { text: 'is', startMs: 200, endMs: 300, highlight: true },
    { text: 'not', startMs: 300, endMs: 500 },
    { text: 'going', startMs: 500, endMs: 800, emoji: '🔥' },
    { text: 'anywhere', startMs: 900, endMs: 1400 },
];

// Same word count: text swaps in place, timing and styling kept.
{
    const out = retextPhrase(words, [1, 2], 'was never');
    assert.deepStrictEqual(out.map((w) => w.text), ['AI', 'was', 'never', 'going', 'anywhere']);
    assert.strictEqual(out[1].startMs, 200);
    assert.strictEqual(out[1].highlight, true);
    assert.strictEqual(out[2].endMs, 500);
}

// Fewer words: they share the phrase's time, and the array stays in order.
{
    const out = retextPhrase(words, [0, 1, 2], 'Robots');
    assert.deepStrictEqual(out.map((w) => w.text), ['Robots', 'going', 'anywhere']);
    assert.strictEqual(out[0].startMs, 0);
    assert.strictEqual(out[0].endMs, 500);
}

// More words: time is split by length, and no word is centred in the gap
// between "going" (ends 800) and "anywhere" (starts 900), where it would be
// dropped if that pause were cut.
{
    const out = retextPhrase(words, [3, 4], 'going to go far');
    const texts = out.map((w) => w.text);
    assert.deepStrictEqual(texts, ['AI', 'is', 'not', 'going', 'to', 'go', 'far']);
    for (let i = 1; i < out.length; i++) assert.ok(out[i].startMs >= out[i - 1].startMs, 'kept in time order');
    for (const w of out.slice(3)) {
        assert.ok(w.endMs >= w.startMs);
        const mid = (w.startMs + w.endMs) / 2;
        assert.ok(!(mid > 800 && mid < 900), `${w.text} is centred in the gap`);
    }
    assert.strictEqual(out[3].startMs, 500);
    assert.strictEqual(out[out.length - 1].endMs, 1400);
    // The word emoji on "going" stays on one new word only.
    assert.strictEqual(out.filter((w) => w.emoji === '🔥').length, 1);
}

// Empty text changes nothing.
assert.strictEqual(retextPhrase(words, [0, 1], '   '), words);

// Phrase emoji: every word shares one span; a single word gets no span.
{
    const out = setPhraseEmoji(words, [0, 1, 2], '💰', false);
    const span = out[0].emojiSpan;
    assert.ok(span);
    assert.ok(out.slice(0, 3).every((w) => w.emoji === '💰' && w.emojiSpan === span && w.emojiAnimated === false));
    assert.strictEqual(out[3].emoji, '🔥');
    assert.deepStrictEqual(spanIndices(out, 1), [0, 1, 2]);
    assert.deepStrictEqual(spanIndices(out, 3), [3]);

    const one = setPhraseEmoji(words, [4], '🚀', true);
    assert.strictEqual(one[4].emoji, '🚀');
    assert.strictEqual(one[4].emojiSpan, undefined);

    // Removing from one word of the phrase clears the whole phrase.
    const cleared = clearEmojis(out, [1]);
    assert.ok(cleared.slice(0, 3).every((w) => !w.emoji && !w.emojiSpan));
    assert.strictEqual(cleared[3].emoji, '🔥');

    // Retyping a phrase keeps its phrase emoji on every new word.
    const retyped = retextPhrase(out, [0, 1, 2], 'Money is not real at all');
    assert.ok(retyped.slice(0, 6).every((w) => w.emoji === '💰' && w.emojiSpan === span));
}

console.log('phraseEdit self-check passed');
