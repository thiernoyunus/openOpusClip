/**
 * Tiny assert-based self-check for the animated-emoji lookup. No framework.
 * Run: `node remotion/src/lib/animatedEmoji.selfcheck.ts` (Node >= 22.18 strips the types on its own; 22.6-22.17 need --experimental-strip-types).
 */
import assert from "node:assert";
import {
  ANIMATED_EMOJI,
  animatedSlug,
  lottieUrl,
  webpUrl,
  searchAnimatedEmoji,
  searchAnimatedEmojiByCategory,
} from "./animatedEmoji.ts";

// The generated snapshot is non-empty and every row is well formed.
assert.ok(ANIMATED_EMOJI.length > 800, "expected ~880 animated emoji");
for (const e of ANIMATED_EMOJI) {
  assert.match(e.slug, /^[0-9a-f]+(_[0-9a-f]+)*$/, `bad slug: ${e.slug}`);
  assert.ok(e.char.length > 0 && e.search.length > 0, `bad row: ${e.slug}`);
  assert.ok(e.category.length > 0, `missing category: ${e.slug}`);
}

// Known-animated emoji resolve to their CDN slug.
assert.strictEqual(animatedSlug("🔥"), "1f525");
assert.strictEqual(animatedSlug("😀"), "1f600");

// Emoji Google has NOT animated fall back to null so callers draw the plain
// character instead. (Only 4 flags are animated; Brazil is not one of them.)
assert.strictEqual(animatedSlug("🇧🇷"), null);
assert.strictEqual(animatedSlug(undefined), null);
assert.strictEqual(animatedSlug(""), null);

// The same emoji written with and without the trailing variation selector
// (U+FE0F) must find the same artwork.
assert.strictEqual(animatedSlug("☺️"), animatedSlug("☺"));
assert.ok(animatedSlug("☺") !== null, "variation-selector fallback broke");

// URLs point at Google's CDN.
assert.strictEqual(
  lottieUrl("1f525"),
  "https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/lottie.json"
);
assert.strictEqual(
  webpUrl("1f525"),
  "https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.webp"
);

// Search matches the human words, not just the character.
assert.ok(searchAnimatedEmoji("fire").some((e) => e.char === "🔥"), "'fire' should find 🔥");
assert.ok(searchAnimatedEmoji("party").length > 0, "'party' should match something");
assert.strictEqual(searchAnimatedEmoji("").length, ANIMATED_EMOJI.length);
assert.strictEqual(searchAnimatedEmoji("zzzznope").length, 0);
// Pasting the emoji itself into the search box finds it.
assert.ok(searchAnimatedEmoji("🔥").some((e) => e.char === "🔥"), "pasted emoji should match");

// Grouping keeps every emoji and never invents an empty category.
const grouped = searchAnimatedEmojiByCategory("");
assert.strictEqual(
  grouped.reduce((n, g) => n + g.emojis.length, 0),
  ANIMATED_EMOJI.length
);
assert.ok(grouped.every((g) => g.emojis.length > 0), "empty category group");
assert.ok(grouped.length > 1, "expected several categories");
// A narrow query still groups, and drops categories with no match.
const fireGroups = searchAnimatedEmojiByCategory("fire");
assert.ok(fireGroups.length >= 1 && fireGroups.every((g) => g.emojis.length > 0));
assert.strictEqual(searchAnimatedEmojiByCategory("zzzznope").length, 0);

console.log(
  `animatedEmoji selfcheck OK (${ANIMATED_EMOJI.length} emoji, ${grouped.length} categories)`
);
