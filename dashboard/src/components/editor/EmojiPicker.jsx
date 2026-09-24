import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Car, Clock, Flag, Heart, Lightbulb, PawPrint, Pizza, Smile, Trash2, Trophy, X } from 'lucide-react';
import { animatedSlug, stillUrl, webpUrl } from '@remotion-src/lib/animatedEmoji';
import { EMOJI_CATALOG, EMOJI_TABS, searchEmoji } from './emojiCatalog';

const TAB_ICONS = {
    recent: Clock,
    people: Smile,
    nature: PawPrint,
    food: Pizza,
    activity: Trophy,
    travel: Car,
    objects: Lightbulb,
    symbols: Heart,
    flags: Flag,
};
const TONE_HANDS = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];
const COLS = 9;
const ROW_PX = 46; // 40px cell + 6px gap
const HEADER_PX = 30;
const RECENT_MAX = 18;

// Per-viewer conveniences only (mode, skin tone, recents). Storage can be
// missing or throw in a private window; the picker works without it.
function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}
function save(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* storage unavailable */
    }
}

const hasArt = (e) => animatedSlug(e.char) !== null;
const isPlain = (e) => e.plain;

/** The emoji to show/insert for the chosen skin tone (when that tone exists in this mode). */
function toned(entry, tone, animated) {
    if (!tone || !entry.skins) return entry.char;
    const char = entry.skins[tone - 1];
    return !animated || animatedSlug(char) ? char : entry.char;
}

/**
 * One grid cell. Animated cells show Google's still artwork and only load and
 * play the moving WebP while hovered: decoding ~800 animations at once is what
 * made the old grid stutter and pop in while scrolling.
 */
const EmojiCell = memo(function EmojiCell({ char, name, animated, onPick }) {
    const slug = animated ? animatedSlug(char) : null;
    const [hover, setHover] = useState(false);
    const [moving, setMoving] = useState(false);
    const [stillLoaded, setStillLoaded] = useState(false);
    const [stillFailed, setStillFailed] = useState(false);
    const start = () => setHover(true);
    const stop = () => {
        setHover(false);
        setMoving(false);
    };
    return (
        <button
            type="button"
            data-emoji-choice={char}
            data-emoji-animated={animated ? '' : undefined}
            title={animated ? `${name} (animated)` : name}
            aria-label={name}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={start}
            onMouseLeave={stop}
            onFocus={start}
            onBlur={stop}
            onClick={() => onPick(char, animated)}
            className="relative h-10 rounded-md flex items-center justify-center hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300/60"
        >
            {slug && !stillFailed ? (
                <>
                    {/* The plain character holds the cell until the artwork
                        arrives, so a slow network never shows empty squares. */}
                    {!stillLoaded && <span className="absolute text-2xl leading-none opacity-60">{char}</span>}
                    <img
                        src={stillUrl(slug)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        width={32}
                        height={32}
                        onLoad={() => setStillLoaded(true)}
                        onError={() => setStillFailed(true)}
                        className={`relative size-8 ${moving || !stillLoaded ? 'invisible' : ''}`}
                    />
                    {hover && (
                        <img
                            src={webpUrl(slug)}
                            alt=""
                            decoding="async"
                            draggable={false}
                            width={32}
                            height={32}
                            onLoad={() => setMoving(true)}
                            className={`absolute size-8 ${moving ? '' : 'opacity-0'}`}
                        />
                    )}
                </>
            ) : (
                <span className="text-2xl leading-none">{char}</span>
            )}
        </button>
    );
});

function Section({ id, label, items, animated, onPick }) {
    const rows = Math.ceil(items.length / COLS);
    return (
        <section
            data-emoji-category={label}
            data-section={id}
            // Off-screen sections skip layout and paint entirely; the size hint
            // keeps the scrollbar and tab jumps accurate before they render.
            style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${HEADER_PX + rows * ROW_PX}px` }}
        >
            <div className="sticky top-0 z-10 bg-[#0b0b0d] py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                {label}
            </div>
            <div className="grid grid-cols-9 gap-1.5 pb-1.5">
                {items.map(({ char, name }) => (
                    <EmojiCell key={char} char={char} name={name} animated={animated} onPick={onPick} />
                ))}
            </div>
        </section>
    );
}

/**
 * Transcript emoji picker. Animated and Regular are two views of the same
 * catalog, each browsable by iPhone-style tabs and searchable by name and
 * keyword. When the word already has an emoji it's shown up top with Remove.
 */
function EmojiPicker({ current, onPick, onRemove, onClose, onInteract }) {
    const [mode, setMode] = useState(() => (load('emojiPicker.mode', 'animated') === 'regular' ? 'regular' : 'animated'));
    const [tone, setTone] = useState(() => {
        const t = load('emojiPicker.tone', 0);
        return Number.isInteger(t) && t >= 0 && t <= 5 ? t : 0;
    });
    const [recent, setRecent] = useState(() => {
        const r = load('emojiPicker.recent', []);
        return Array.isArray(r) ? r.filter((x) => x && typeof x.char === 'string') : [];
    });
    const [query, setQuery] = useState('');
    const [toneOpen, setToneOpen] = useState(false);
    const [activeTab, setActiveTab] = useState(null);
    const scrollRef = useRef(null);

    const animated = mode === 'animated';
    const include = animated ? hasArt : isPlain;

    const pickMode = (m) => {
        setMode(m);
        save('emojiPicker.mode', m);
        scrollRef.current?.scrollTo({ top: 0 });
    };
    const pickTone = (t) => {
        setTone(t);
        setToneOpen(false);
        save('emojiPicker.tone', t);
    };

    const pick = useCallback((char, isAnimated) => {
        const next = [{ char, animated: isAnimated }, ...recent.filter((r) => !(r.char === char && r.animated === isAnimated))].slice(0, 40);
        save('emojiPicker.recent', next);
        setRecent(next);
        onPick(char, isAnimated);
    }, [recent, onPick]);

    const sections = useMemo(() => {
        const out = [];
        const recents = recent
            .filter((r) => r.animated === animated && (!animated || animatedSlug(r.char)))
            .slice(0, RECENT_MAX)
            .map((r) => ({ char: r.char, name: 'Recently used' }));
        if (recents.length) out.push({ id: 'recent', label: 'Recently used', items: recents });
        for (const tab of EMOJI_TABS) {
            const items = EMOJI_CATALOG
                .filter((e) => e.tab === tab.id && include(e))
                .map((e) => ({ char: toned(e, tone, animated), name: e.name }));
            if (items.length) out.push({ ...tab, items });
        }
        return out;
    }, [recent, animated, include, tone]);

    const results = useMemo(
        () => searchEmoji(query, include).map((e) => ({ char: toned(e, tone, animated), name: e.name })),
        [query, include, tone, animated],
    );
    // Nothing in this view? Say whether the other view has it rather than a dead end.
    const otherCount = useMemo(
        () => (query.trim() && results.length === 0 ? searchEmoji(query, animated ? isPlain : hasArt).length : 0),
        [query, results.length, animated],
    );
    const searching = query.trim().length > 0;

    // Keep the tab bar in step with the section scrolled into view.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || searching) return undefined;
        let raf = 0;
        const update = () => {
            raf = 0;
            let id = null;
            for (const node of el.querySelectorAll('[data-section]')) {
                if (id === null || node.offsetTop <= el.scrollTop + 4) id = node.dataset.section;
            }
            setActiveTab(id);
        };
        const onScroll = () => {
            if (!raf) raf = requestAnimationFrame(update);
        };
        update();
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            el.removeEventListener('scroll', onScroll);
            cancelAnimationFrame(raf);
        };
    }, [sections, searching]);

    const jumpTo = (id) => {
        setQuery('');
        // After a search clears, the sections re-mount; wait a frame for them.
        requestAnimationFrame(() => {
            const node = scrollRef.current?.querySelector(`[data-section="${id}"]`);
            if (node) scrollRef.current.scrollTo({ top: node.offsetTop });
        });
    };

    const currentSlug = current?.emojiAnimated ? animatedSlug(current.emoji) : null;

    // Portaled to <body>: inside the editor layout a transformed ancestor
    // turned `fixed` into "fixed to that panel", so the backdrop only dimmed
    // part of the screen and the dialog sat off-center.
    return createPortal(
        <div
            data-emoji-picker=""
            className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center px-4"
            onMouseDown={onClose}
        >
            <div
                className="w-[440px] max-w-[calc(100vw-32px)] flex flex-col rounded-lg border border-[#2b2d33] bg-[#0b0b0d] shadow-2xl p-3"
                onMouseDown={(e) => {
                    onInteract?.();
                    e.stopPropagation();
                }}
            >
                <div className="flex items-center gap-2">
                    <input
                        data-emoji-search=""
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') onClose();
                            if (e.key === 'Enter' && results[0]) pick(results[0].char, animated);
                        }}
                        placeholder={animated ? 'Search animated emoji' : 'Search emoji'}
                        className="h-9 min-w-0 flex-1 rounded-md border border-[#2d2f36] bg-[#18191d] px-3 text-sm text-fg placeholder:text-zinc-500 focus:outline-none focus:border-white/30"
                    />
                    <div className="flex shrink-0 rounded-md border border-[#2d2f36] bg-[#18191d] p-0.5 text-[11px] font-medium">
                        {['animated', 'regular'].map((m) => (
                            <button
                                key={m}
                                type="button"
                                data-emoji-mode={m}
                                onClick={() => pickMode(m)}
                                className={`px-2 py-1 rounded ${mode === m ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-white'}`}
                            >
                                {m === 'animated' ? 'Animated' : 'Regular'}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="size-8 shrink-0 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                {current?.emoji && onRemove && (
                    <div className="mt-2 flex items-center gap-2 rounded-md border border-[#2d2f36] bg-[#141518] px-2.5 py-1.5">
                        <span className="text-[11px] text-zinc-400">On this word</span>
                        {currentSlug ? (
                            <img src={webpUrl(currentSlug)} alt={current.emoji} width={24} height={24} className="size-6" />
                        ) : (
                            <span className="text-xl leading-none">{current.emoji}</span>
                        )}
                        <button
                            type="button"
                            data-emoji-remove=""
                            onClick={onRemove}
                            className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-red-300 hover:bg-red-500/20"
                        >
                            <Trash2 size={12} /> Remove emoji
                        </button>
                    </div>
                )}

                <div className="relative mt-2 flex items-center gap-0.5 border-b border-[#1f2126] pb-1.5">
                    {sections.map((s) => {
                        const Icon = TAB_ICONS[s.id];
                        const on = !searching && activeTab === s.id;
                        return (
                            <button
                                key={s.id}
                                type="button"
                                data-emoji-tab={s.id}
                                title={s.label}
                                onClick={() => jumpTo(s.id)}
                                className={`size-8 rounded-md flex items-center justify-center ${on ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-white hover:bg-white/10'}`}
                            >
                                <Icon size={16} />
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        title="Skin tone"
                        onClick={() => setToneOpen((o) => !o)}
                        className="ml-auto size-8 rounded-md text-lg leading-none flex items-center justify-center hover:bg-white/10"
                    >
                        {TONE_HANDS[tone]}
                    </button>
                    {toneOpen && (
                        <div className="absolute right-0 top-full z-30 mt-1 flex gap-0.5 rounded-md border border-[#2d2f36] bg-[#18191d] p-1 shadow-xl">
                            {TONE_HANDS.map((hand, t) => (
                                <button
                                    key={hand}
                                    type="button"
                                    onClick={() => pickTone(t)}
                                    className={`size-8 rounded text-lg leading-none flex items-center justify-center ${t === tone ? 'bg-white/15' : 'hover:bg-white/10'}`}
                                >
                                    {hand}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Fixed height so the dialog doesn't jump around as results change. */}
                <div ref={scrollRef} className="relative mt-1 h-[min(46vh,420px)] overflow-y-auto custom-scrollbar pr-1">
                    {searching ? (
                        results.length > 0 ? (
                            <Section id="results" label="Results" items={results} animated={animated} onPick={pick} />
                        ) : (
                            <div className="py-8 text-center text-[12px] text-muted">
                                <p>No {animated ? 'animated ' : ''}emoji match “{query.trim()}”.</p>
                                {otherCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => pickMode(animated ? 'regular' : 'animated')}
                                        className="mt-2 text-lime-300 hover:underline"
                                    >
                                        See {otherCount} in {animated ? 'Regular' : 'Animated'}
                                    </button>
                                )}
                            </div>
                        )
                    ) : (
                        sections.map((s) => (
                            <Section
                                key={`${mode}-${s.id}`}
                                id={s.id}
                                label={s.label}
                                items={s.items}
                                animated={animated}
                                onPick={pick}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}

export default memo(EmojiPicker);
