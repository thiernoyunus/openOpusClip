import rows from './emojiCatalogData.js';

/**
 * Every emoji the picker offers, with its name and search words (Unicode CLDR
 * + emojilib + Google's tags, merged by scripts/fetch-emoji-keywords.mjs).
 * Plain JS with no editor imports so the self-check runs under bare `node`.
 */

// Same tabs, same order as the iPhone keyboard.
export const EMOJI_TABS = [
    { id: 'people', label: 'Smileys & People' },
    { id: 'nature', label: 'Animals & Nature' },
    { id: 'food', label: 'Food & Drink' },
    { id: 'activity', label: 'Activity' },
    { id: 'travel', label: 'Travel & Places' },
    { id: 'objects', label: 'Objects' },
    { id: 'symbols', label: 'Symbols' },
    { id: 'flags', label: 'Flags' },
];

const fold = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const bare = (s) => s.replace(/\uFE0F/g, '');

export const EMOJI_CATALOG = rows.map(([char, name, keywords, tab, plain, rank, skins], order) => ({
    char,
    name,
    tab: EMOJI_TABS[tab].id,
    // false = too new for the system emoji font; only offered as animated art.
    plain: plain === 1,
    skins: skins ?? null,
    order,
    // 0..40 bonus from how often people use it, so "heart" leads with ❤️
    // rather than 💟 and "smile" with 😀 rather than 😼.
    // Emoji Google hasn't animated have no rank; they get a middling 10.
    popular: rank < 0 ? 10 : 40 * (1 - rank / 900),
    nameWords: words(name),
    nameText: words(name).join(' '),
    keywords: keywords ? keywords.split(' ') : [],
}));

const BY_BARE = new Map();
for (const e of EMOJI_CATALOG) {
    BY_BARE.set(bare(e.char), { entry: e, char: e.char });
    e.skins?.forEach((s) => BY_BARE.set(bare(s), { entry: e, char: s }));
}

/** Catalog entry for an emoji (any U+FE0F spelling or skin tone), or null. */
export function findEmoji(char) {
    return (char && BY_BARE.get(bare(char.trim()))?.entry) || null;
}

/**
 * The picker's spelling of an emoji, or null if the string isn't one. Used to
 * clean up AI output ("❤" without U+FE0F draws as a flat black heart; "fire"
 * or "🔥🔥" aren't a single emoji at all).
 */
export function normalizeEmoji(str) {
    return (str && BY_BARE.get(bare(str.trim()))?.char) || null;
}

/** How well one typed word matches an emoji; 0 = not at all. */
function tokenScore(e, t) {
    let best = 0;
    for (const w of e.nameWords) {
        if (w === t) return 100;
        if (w.startsWith(t)) best = Math.max(best, 50);
    }
    for (const k of e.keywords) {
        if (k === t) return 90;
        if (k.startsWith(t)) best = Math.max(best, 30);
    }
    // Plurals: "cats" finds 🐈 as well as "cat" does.
    const stem = singular(t);
    if (stem !== t && (e.nameWords.includes(stem) || e.keywords.includes(stem))) best = Math.max(best, 85);
    return best;
}

const singular = (t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, t.endsWith('es') && !t.endsWith('ses') ? -2 : -1) : t);

/**
 * Emoji matching a search, best first -- the way a phone keyboard does it:
 * each typed word has to START a word of the emoji's name or keywords (so
 * "cat" finds 🐈 and 😺, never "education"), name hits beat keyword hits,
 * and an exact name ("cat", "red heart") comes first. Pasting an emoji finds
 * that emoji. `include` narrows the pool (e.g. only ones with animated art).
 */
export function searchEmoji(query, include = () => true) {
    const q = (query ?? '').trim();
    if (!q) return [];
    const direct = findEmoji(q);
    if (direct) return include(direct) ? [direct] : [];
    const tokens = words(q);
    if (tokens.length === 0) return [];
    const phrase = tokens.join(' ');
    const singularPhrase = tokens.map(singular).join(' ');

    const hits = [];
    for (const e of EMOJI_CATALOG) {
        if (!include(e)) continue;
        let score = 0;
        for (const t of tokens) {
            const s = tokenScore(e, t);
            if (s === 0) { score = 0; break; }
            score += s;
        }
        if (score === 0) continue;
        if (e.nameText === phrase || e.nameText === singularPhrase) score += 200;
        // Shorter names are the more direct answer ("cat" over "cat with wry smile").
        score -= e.nameWords.length * 2;
        score += e.popular;
        hits.push({ e, score });
    }
    hits.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
    return hits.map((h) => h.e);
}
