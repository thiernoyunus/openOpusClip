/**
 * Assert-based self-check for emoji search. No framework.
 * Run: `npm run test:emoji` (from dashboard/).
 */
import assert from 'node:assert';
import { EMOJI_CATALOG, findEmoji, normalizeEmoji, searchEmoji } from './emojiCatalog.js';

const top = (q, n = 3) => searchEmoji(q).slice(0, n).map((e) => e.char);
const first = (q) => searchEmoji(q)[0]?.char;

assert.ok(EMOJI_CATALOG.length > 1500, 'catalog should hold the full emoji set');

// The exact emoji you'd expect on a phone keyboard comes first.
assert.strictEqual(first('fire'), '🔥');
assert.strictEqual(first('cat'), '🐈');
assert.strictEqual(first('pizza'), '🍕');
assert.strictEqual(first('red heart'), '❤️');
assert.strictEqual(first('thumbs up'), '👍');
assert.strictEqual(first('rocket'), '🚀');
assert.strictEqual(first('brazil'), '🇧🇷');
assert.ok(top('laugh', 5).includes('😂'), "'laugh' should find 😂");
assert.ok(top('lol', 5).includes('😂'), "'lol' should find 😂");
assert.ok(top('money', 5).includes('💰'), "'money' should find 💰");
assert.ok(top('cats', 5).includes('🐈'), "plural 'cats' should find 🐈");
assert.ok(top('pinata', 1).includes('🪅'), 'accents are ignored (piñata)');

// Word starts only: "cat" must not match the middle of "education" or "vacation".
for (const e of searchEmoji('cat')) {
    assert.ok(
        [...e.nameWords, ...e.keywords].some((w) => w.startsWith('cat') || w === 'cats'),
        `'cat' matched ${e.char} (${e.name}) without a word starting with "cat"`,
    );
}
// Typing a prefix already narrows ("pizz" -> 🍕).
assert.strictEqual(first('pizz'), '🍕');
// Every flag answers "flag".
assert.ok(searchEmoji('flag').length > 250, "'flag' should list every flag");
// Nonsense finds nothing; blank finds nothing.
assert.strictEqual(searchEmoji('zzzznope').length, 0);
assert.strictEqual(searchEmoji('  ').length, 0);
// Pasting the emoji itself finds it, in any spelling.
assert.strictEqual(first('🔥'), '🔥');
assert.strictEqual(first('❤'), '❤️');
// The include filter narrows the pool.
assert.strictEqual(searchEmoji('fire', (e) => e.char !== '🔥').some((e) => e.char === '🔥'), false);

// AI output cleanup.
assert.strictEqual(normalizeEmoji('❤'), '❤️');
assert.strictEqual(normalizeEmoji(' 🚀 '), '🚀');
assert.strictEqual(normalizeEmoji('👍🏽'), '👍🏽');
assert.strictEqual(normalizeEmoji('fire'), null);
assert.strictEqual(normalizeEmoji('🔥🔥'), null);
assert.strictEqual(normalizeEmoji(''), null);
assert.strictEqual(findEmoji('👍🏽')?.char, '👍');

console.log('emoji catalog self-check passed');
