import rows from "./animatedEmojiData.ts";

/**
 * Google publishes an animated version of ~880 emoji (Google Noto Emoji,
 * CC BY 4.0). Artwork lives on Google's font CDN; `animatedEmojiData.ts` is our
 * snapshot of which ones exist -- regenerate it with
 * `node scripts/fetch-animated-emoji.mjs`.
 */
export type AnimatedEmoji = {
  /** Codepoint slug used in the CDN path, e.g. "1f525". */
  slug: string;
  /** The plain emoji character, e.g. "🔥". */
  char: string;
  /** Space-separated search words, e.g. "fire burn lit". */
  search: string;
};

export const ANIMATED_EMOJI: AnimatedEmoji[] = rows.map(
  ([slug, char, search]) => ({ slug, char, search })
);

// Some emoji are written with a trailing variation selector (U+FE0F) and some
// without, depending on where the character came from. Index both spellings so
// a pasted "☺" finds the same artwork as "☺️".
const BY_CHAR = new Map<string, string>();
for (const { slug, char } of ANIMATED_EMOJI) {
  BY_CHAR.set(char, slug);
  const bare = char.replace(/️/g, "");
  if (!BY_CHAR.has(bare)) BY_CHAR.set(bare, slug);
}

/** The CDN slug for an emoji character, or null if Google has no animation for it. */
export function animatedSlug(char: string | undefined): string | null {
  if (!char) return null;
  return BY_CHAR.get(char) ?? BY_CHAR.get(char.replace(/️/g, "")) ?? null;
}

const BASE = "https://fonts.gstatic.com/s/e/notoemoji/latest";

/** Frame-accurate vector animation, used when rendering the final video. */
export const lottieUrl = (slug: string) => `${BASE}/${slug}/lottie.json`;
/** Animated image the browser plays on its own, used for editor previews. */
export const webpUrl = (slug: string) => `${BASE}/${slug}/512.webp`;

/** Animated emoji whose search words match `query` (empty query = all of them). */
export function searchAnimatedEmoji(query: string): AnimatedEmoji[] {
  const q = query.trim().toLowerCase();
  if (!q) return ANIMATED_EMOJI;
  return ANIMATED_EMOJI.filter((e) => e.char === q || e.search.includes(q));
}
