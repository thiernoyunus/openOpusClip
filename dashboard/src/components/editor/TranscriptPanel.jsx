import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Clock, FileText, Scissors, Smile, Wand2, X, Plus, Loader2, Pencil, EyeOff, Eye } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { wordSourceToOutput, sourceToOutputAll } from '@remotion-src/lib/edl';
import { detectFillerCuts, detectPauseCuts, visibleTranscriptPauses } from './speechCleanup';
import EmojiPicker from './EmojiPicker';
import { retextPhrase, setPhraseEmoji, clearEmojis, spanIndices } from './phraseEdit';

const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four' };

/**
 * A single transcript word. Memoized on its primitive props so that, during
 * playback, only the 1-2 words whose active/selection state actually changed
 * re-render — the other hundreds of words are skipped entirely. The parent
 * keeps the click/edit handlers stable (useCallback) and passes index+word
 * back through them, so this component's props stay referentially stable.
 */
const Word = React.memo(function Word({ index, word, isActive, suppressHighlight, isCut, captionHidden, inSel, showEmoji, inSpan, onWordClick, onEdit, onEmojiClick }) {
    const colorClass = word.highlight ? 'text-[#04f827]' : 'text-white';
    // Words under a phrase emoji get a faint dotted underline so you can see
    // how far the emoji reaches; the emoji itself shows once, after the last.
    const spanClass = inSpan ? ' underline decoration-dotted decoration-amber-300/70 underline-offset-4' : '';
    return (
        <span
            data-transcript-word={index}
            data-active-word={isActive ? '' : undefined}
            onClick={(e) => onWordClick(index, word, e)}
            onDoubleClick={() => {
                if (isCut) return;
                onEdit(index, word);
            }}
            title={
                isCut
                    ? 'Removed from the clip'
                    : captionHidden
                      ? "Caption hidden (still in the video). Click to restore."
                      : 'Click to edit or remove, drag across words to select a phrase. Double-click to edit text.'
            }
            className={`ph-mask cursor-pointer text-sm leading-7 rounded px-0.5 transition-colors ${
                isCut
                    ? 'line-through text-zinc-600 hover:text-zinc-400'
                    : inSel
                      ? 'bg-lime-300 text-black'
                      : captionHidden
                        // caption removed but video kept: dimmed + dashed underline,
                        // distinct from the struck-through "removed from clip" look.
                        ? 'text-zinc-500 italic underline decoration-dashed decoration-zinc-600 underline-offset-4 hover:text-zinc-300'
                        : isActive && !suppressHighlight
                          ? 'bg-lime-300/35 text-fg'
                          : `${colorClass} hover:bg-white/10${spanClass}`
            }`}
        >
            {word.text}
            {showEmoji && (
                <>
                    {' '}
                    {/* Its own target: clicking the emoji opens the picker on
                        this word with Remove at the top, instead of just
                        selecting the word. */}
                    <span
                        data-transcript-emoji=""
                        role="button"
                        tabIndex={isCut ? -1 : 0}
                        title={word.emojiSpan ? 'Change or remove this phrase emoji' : 'Change or remove this emoji'}
                        aria-label={word.emojiSpan ? 'Change or remove this phrase emoji' : 'Change or remove this emoji'}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!isCut) onEmojiClick(index);
                        }}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            e.stopPropagation();
                            if (!isCut) onEmojiClick(index);
                        }}
                        className="rounded hover:bg-white/20 hover:ring-1 hover:ring-white/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300/60"
                    >
                        {word.emoji}
                    </span>
                </>
            )}{' '}
        </span>
    );
});

const PauseChip = React.memo(function PauseChip({ pause, selected, isCut, onPauseClick }) {
    return (
        <button
            type="button"
            dir="ltr"
            data-transcript-pause=""
            data-pause-index={pause.index}
            onClick={() => onPauseClick(pause)}
            title={isCut ? 'Pause already cut' : 'Click to select this pause for cutting'}
            className={`inline-flex items-center align-baseline mx-0.5 rounded px-1 py-px text-xs leading-4 transition-colors ${
                isCut
                    ? 'line-through bg-[#2f2f2f]/60 text-zinc-600'
                    : selected
                      ? 'bg-lime-300 text-black'
                      : 'bg-[#2f2f2f] text-white/50 hover:bg-zinc-700 hover:text-fg'
            }`}
        >
            {pause.label}
        </button>
    );
});

/**
 * Opus-style transcript column with text-based editing: word-level captions,
 * click a word to seek, the word under the playhead highlights during
 * playback, double-click to edit text, select a range and Cut to remove that
 * content (splits the owning clip(s) and drops the middle). Removed words
 * render struck through; use Undo to bring them back.
 */
export default function TranscriptPanel({ captions, framing, playerRef, onEditWord, onSetCaptionHidden, onUpdateCaptions, dispatch, onOpenExtend, extending, clipStartSec }) {
    const [currentMs, setCurrentMs] = useState(0);
    const [editingIndex, setEditingIndex] = useState(null);
    const [draft, setDraft] = useState('');
    const [sel, setSel] = useState(null); // {anchor, focus} word indices
    // popupTick is bumped on scroll/resize so the floating toolbar's screen
    // position recomputes.
    const [popupTick, setPopupTick] = useState(0);
    // Retyping a selected phrase: {indices (display order), draft}.
    const [phraseEdit, setPhraseEdit] = useState(null);
    // Drag-to-select: where the drag started, and whether it has left that
    // word yet (a drag that did must not also count as a click on a word).
    const dragRef = useRef(null);
    const [dragging, setDragging] = useState(false);
    const suppressClickRef = useRef(false);
    const [selectedPause, setSelectedPause] = useState(null);
    const [emojiOpen, setEmojiOpen] = useState(false);
    // Caption indices the picker writes to when it was opened from the
    // toolbar rather than from an in-progress word edit. Several indices = a
    // phrase emoji that stays up while any of those words is on screen.
    const [emojiTargets, setEmojiTargets] = useState(null);
    const [cleanupOpen, setCleanupOpen] = useState(false);
    const [removeFillers, setRemoveFillers] = useState(true);
    const [removePauses, setRemovePauses] = useState(true);
    const containerRef = useRef(null);
    const emojiInteractingRef = useRef(false);
    // Mirror of `sel` so the stable onWordClick handler can read the latest
    // selection without taking `sel` as a dependency (which would change its
    // identity every selection and defeat <Word> memoization).
    const selRef = useRef(null);
    useEffect(() => {
        selRef.current = sel;
    }, [sel]);
    // Same trick for captions, so the emoji click handler stays stable.
    const captionsRef = useRef(captions);
    useEffect(() => {
        captionsRef.current = captions;
    }, [captions]);

    const srcFps = framing.source.fps;
    // Caption ms are anchored at the ORIGINAL clip start (captionsOriginFrame)
    // so head trims don't shift word↔frame mapping, dividers, or cuts.
    const captionsOrigin = framing.captionsOriginFrame ?? 0;

    // Word -> source frames (captions are ms relative to the original clip start)
    const wordToSource = useCallback(
        (word) => ({
            start: captionsOrigin + Math.round((word.startMs / 1000) * srcFps),
            end: captionsOrigin + Math.round((word.endMs / 1000) * srcFps),
        }),
        [captionsOrigin, srcFps]
    );

    const pauseToSource = useCallback(
        (pause) => ({
            start: captionsOrigin + Math.round((pause.startMs / 1000) * srcFps),
            end: captionsOrigin + Math.round((pause.endMs / 1000) * srcFps),
        }),
        [captionsOrigin, srcFps]
    );
    const pauses = useMemo(() => visibleTranscriptPauses(captions), [captions]);

    // Whether each word is removed: its source midpoint maps to NO output frame
    // (it isn't covered by any clip). Precomputed once per [captions, clips].
    const isCutByWord = useMemo(() => {
        return captions.map((word) => {
            const { start, end } = wordToSource(word);
            const mid = Math.round((start + end) / 2);
            return sourceToOutputAll(framing, mid, EDITOR_FPS).length === 0;
        });
    }, [captions, framing, wordToSource]);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        const onFrame = (e) => setCurrentMs((e.detail.frame / EDITOR_FPS) * 1000);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    // Per-clip info in PLAYBACK order (framing.clips array order == play order).
    // origSec / origEndSec = where this clip's content lives in the ORIGINAL
    // video. Extend-inserted clips carry originalOffsetSec — a frame-position-
    // INDEPENDENT constant (origSec = offset + sourceStart/fps) — so it stays
    // correct even after the clip is later trimmed/split/cut and sourceStart
    // moves; pipeline clips derive origSec from the clip's start second plus
    // offset from the caption origin.
    const clipInfo = useMemo(() => {
        if (!framing) return [];
        return framing.clips.map((c) => {
            const origSec = c.originalOffsetSec != null
                ? c.originalOffsetSec + c.sourceStart / srcFps
                : clipStartSec != null
                  ? clipStartSec + (c.sourceStart - captionsOrigin) / srcFps
                  : null;
            return {
                ms: ((c.sourceStart - captionsOrigin) / srcFps) * 1000,
                layout: c.layout,
                id: c.id,
                origSec,
                origEndSec: origSec != null ? origSec + (c.sourceEnd - c.sourceStart) / srcFps : null,
            };
        });
    }, [framing, captionsOrigin, srcFps, clipStartSec]);

    // Which clip each word belongs to, walked in SOURCE order (like the old
    // single-pass scan) so cut/removed words still interleave with their kept
    // neighbors correctly. This only decides GROUPING, not display order —
    // `rows` below walks the groups in `clipInfo`'s PLAYBACK order, so a
    // reordered or Extend-inserted clip shows where it now plays, not where
    // it was originally cut from (previously this was source order — the
    // panel could show your latest addition at the bottom instead of the top).
    const bucketsById = useMemo(() => {
        const map = new Map(clipInfo.map((c) => [c.id, []]));
        const bySource = [...clipInfo].sort((a, b) => a.ms - b.ms);
        let nextSeg = 0;
        let currentId = bySource[0]?.id ?? null;
        captions.forEach((word, index) => {
            while (nextSeg < bySource.length && bySource[nextSeg].ms <= word.startMs) {
                currentId = bySource[nextSeg].id;
                nextSeg += 1;
            }
            if (currentId != null) map.get(currentId)?.push(index);
        });
        return map;
    }, [captions, clipInfo]);

    const rows = useMemo(() => {
        const out = [];
        let pos = 0; // ordinal among word-rows, in DISPLAY (playback) order
        const pauseByWord = new Map(pauses.map((pause) => [pause.index, pause]));
        clipInfo.forEach((info) => {
            out.push({ type: 'divider', ...info });
            (bucketsById.get(info.id) || []).forEach((index) => {
                // clipId + pos let selection/cut work in DISPLAY order (see
                // selRange/handleCut below) instead of assuming caption array
                // index is monotonic in display order, which it no longer is
                // once a clip has been reordered or Extend-inserted elsewhere.
                out.push({ type: 'word', word: captions[index], index, clipId: info.id, pos: pos++ });
                const pause = pauseByWord.get(index);
                if (pause) out.push({ type: 'pause', ...pause });
            });
            // Opus-style "+" bar after every clip: opens the extend picker
            // anchored at this clip's end in the original video, inserting the
            // added section right here (between this clip and the next one).
            if (onOpenExtend) {
                out.push({ type: 'extend', key: `x-${info.id}`, afterClipId: info.id, sec: info.origEndSec });
            }
        });
        return out;
    }, [captions, pauses, clipInfo, bucketsById, onOpenExtend]);

    // Flat, display-ordered list of just the word rows — lets selection/cut
    // translate a display-position range back to {caption index, clipId}
    // triples (see handleCut) instead of treating the caption array's index
    // order as if it matched what's on screen.
    const wordRows = useMemo(() => rows.filter((r) => r.type === 'word'), [rows]);
    const posByIndex = useMemo(() => {
        const m = new Map();
        wordRows.forEach((r) => m.set(r.index, r.pos));
        return m;
    }, [wordRows]);

    // Each non-cut word's position on the OUTPUT timeline (ms), precomputed
    // once so the per-frame active-word lookup is a binary search instead of an
    // O(n) scan. Each word maps through its owning clip occurrence (so a word
    // ending on a clip boundary maps cleanly), then the list is sorted by output
    // start — staying monotonic for the binary search even after a clip reorder.
    // Each entry carries its original caption index; removed words are omitted.
    const kept = useMemo(() => {
        const keptList = [];
        captions.forEach((word, index) => {
            const { start, end } = wordToSource(word);
            const r = wordSourceToOutput(framing, start, end, EDITOR_FPS);
            if (!r) return; // word removed
            keptList.push({
                index,
                startMs: (r.outStart / EDITOR_FPS) * 1000,
                endMs: (r.outEnd / EDITOR_FPS) * 1000,
            });
        });
        keptList.sort((a, b) => a.startMs - b.startMs);
        return keptList;
    }, [captions, framing, wordToSource]);

    const cutPauseKeys = useMemo(() => {
        const keys = new Set();
        pauses.forEach((pause) => {
            const { start, end } = pauseToSource(pause);
            const mid = Math.round((start + end) / 2);
            if (sourceToOutputAll(framing, mid, EDITOR_FPS).length === 0) {
                keys.add(pause.index);
            }
        });
        return keys;
    }, [pauses, framing, pauseToSource]);

    const activeIndex = useMemo(() => {
        // currentMs is on the OUTPUT timeline. Binary-search the kept (non-cut)
        // words — whose output start times are monotonic — for the last one
        // that has started, then apply the same +150ms grace window the linear
        // scan used. Mirrors the old "last word with currentMs >= outStart,
        // skipping cuts" logic, now O(log n) per frame.
        let lo = 0;
        let hi = kept.length - 1;
        let candidate = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (kept[m].startMs <= currentMs) {
                candidate = m;
                lo = m + 1;
            } else {
                hi = m - 1;
            }
        }
        if (candidate === -1) return -1;
        const w = kept[candidate];
        return currentMs <= w.endMs + 150 ? w.index : -1;
    }, [kept, currentMs]);

    useEffect(() => {
        containerRef.current
            ?.querySelector('[data-active-word]')
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    const seekToWord = useCallback(
        (word) => {
            const p = playerRef.current;
            if (!p) return;
            p.pause();
            const { start, end } = wordToSource(word);
            const r = wordSourceToOutput(framing, start, end, EDITOR_FPS);
            p.seekTo(r ? r.outStart : 0);
        },
        [playerRef, framing, wordToSource]
    );

    const commitEdit = useCallback(() => {
        if (editingIndex !== null && draft.trim()) {
            onEditWord(editingIndex, { text: draft.trim() });
        }
        emojiInteractingRef.current = false;
        setEditingIndex(null);
        setEmojiTargets(null);
        setEmojiOpen(false);
    }, [editingIndex, draft, onEditWord]);

    const insertEmoji = useCallback((emoji, animated) => {
        // Picked by hand, so a later AI re-run leaves it alone (emojiAuto off).
        // A single word's own emoji also takes it out of any phrase emoji.
        const patch = { emoji, emojiAnimated: animated === true, emojiAuto: undefined, emojiSpan: undefined };
        if (editingIndex !== null) {
            // Mid-edit: keep whatever text is in the box alongside the emoji.
            const text = draft.trim();
            if (text) onEditWord(editingIndex, { ...patch, text });
        } else if (emojiTargets?.length > 1) {
            // A phrase: one emoji that stays up while the phrase is spoken.
            onUpdateCaptions((c) => setPhraseEmoji(c, emojiTargets, emoji, animated));
        } else if (emojiTargets?.length === 1) {
            // Opened straight from a selected word — no Edit step needed.
            onEditWord(emojiTargets[0], patch);
        }
        setEditingIndex(null);
        setEmojiTargets(null);
        setSel(null);
        setEmojiOpen(false);
        emojiInteractingRef.current = false;
    }, [draft, editingIndex, emojiTargets, onEditWord, onUpdateCaptions]);

    // Clear the emoji off the picker's word(s), and off the rest of any phrase
    // they belong to (keeping an in-progress text edit).
    const removeEmoji = useCallback(() => {
        if (editingIndex !== null) {
            const text = draft.trim();
            onUpdateCaptions((c) => {
                const next = clearEmojis(c, [editingIndex]);
                if (text) next[editingIndex] = { ...next[editingIndex], text };
                return next;
            });
        } else if (emojiTargets?.length) {
            onUpdateCaptions((c) => clearEmojis(c, emojiTargets));
        }
        setEditingIndex(null);
        setEmojiTargets(null);
        setSel(null);
        setEmojiOpen(false);
        emojiInteractingRef.current = false;
    }, [draft, editingIndex, emojiTargets, onUpdateCaptions]);

    /**
     * Open the picker for selected word(s), skipping edit mode. One word that
     * belongs to a phrase emoji targets the whole phrase, so picking changes
     * the phrase's emoji rather than splitting that word off.
     */
    const openEmojiFor = useCallback((indices) => {
        setEmojiTargets(indices.length === 1 ? spanIndices(captionsRef.current, indices[0]) : indices);
        setEditingIndex(null);
        setEmojiOpen(true);
        emojiInteractingRef.current = true;
    }, []);

    // Clicking the emoji itself in the transcript: select its word (or its
    // whole phrase) and open the picker on it, where Remove sits at the top.
    const onEmojiClick = useCallback((index) => {
        const span = spanIndices(captionsRef.current, index);
        setSelectedPause(null);
        setSel({ anchor: span[0], focus: span[span.length - 1] });
        openEmojiFor(span);
    }, [openEmojiFor]);

    const markEmojiInteracting = useCallback(() => {
        emojiInteractingRef.current = true;
    }, []);

    // Stable identity so memoized <Word> children don't re-render on every
    // frame just because the parent re-rendered. Reads sel via the functional
    // updater so it needn't be a dependency.
    const onWordClick = useCallback(
        (index, word, e) => {
            // The click that ends a drag-select: the drag already set the range.
            if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
            }
            if (isCutByWord[index]) {
                // removed content: nothing to seek/select (use Undo to restore)
                setSel(null);
                return;
            }
            const cur = selRef.current;
            setSelectedPause(null);
            if (e.shiftKey && cur) {
                setSel({ anchor: cur.anchor, focus: index });
            } else {
                setSel({ anchor: index, focus: index });
                seekToWord(word);
            }
        },
        [isCutByWord, seekToWord]
    );

    // Stable double-click -> edit handler for memoized <Word> children.
    const onEdit = useCallback((index, word) => {
        setSel(null);
        setSelectedPause(null);
        setPhraseEdit(null);
        setEditingIndex(index);
        setDraft(word.text);
        setEmojiOpen(false);
    }, []);

    // sel.anchor/focus are caption ARRAY indices (stable identity for a word);
    // the selection itself is a range in DISPLAY position space (posByIndex),
    // since displayed order no longer matches array-index order once a clip
    // has been reordered or Extend-inserted elsewhere (see rows/wordRows above).
    // Memoized so its identity is stable across renders where the selection
    // hasn't changed — otherwise selCaptionIndices (which depends on it) would
    // recompute every render.
    const selRange = useMemo(() => {
        if (!sel) return null;
        const a = posByIndex.get(sel.anchor);
        const f = posByIndex.get(sel.focus);
        if (a == null || f == null) return null;
        return { lo: Math.min(a, f), hi: Math.max(a, f) };
    }, [sel, posByIndex]);

    const handleCut = () => {
        if (!selRange) return;
        // The selection is a contiguous run in DISPLAY order, but that can
        // span more than one clip (e.g. shift-selecting across a boundary
        // where the clips aren't source-adjacent). Cluster consecutive
        // selected words by which clip they belong to and cut one source
        // range per cluster, in a single undo step — cutting the whole span
        // as ONE range would be wrong (and could delete unrelated footage)
        // whenever the clips it crosses aren't next to each other in source.
        const ranges = [];
        let curClipId = null;
        let curStart = 0;
        let curEnd = 0;
        wordRows.slice(selRange.lo, selRange.hi + 1).forEach(({ word, clipId }) => {
            const { start, end } = wordToSource(word);
            if (clipId === curClipId) {
                curEnd = end;
            } else {
                if (curClipId != null) ranges.push({ startFrame: curStart, endFrame: curEnd });
                curClipId = clipId;
                curStart = start;
                curEnd = end;
            }
        });
        if (curClipId != null) ranges.push({ startFrame: curStart, endFrame: curEnd });
        if (ranges.length > 0) dispatch({ type: 'CUT_SOURCE_RANGE', ranges });
        setSel(null);
    };

    // Caption ARRAY indices covered by the current selection (display order).
    const selCaptionIndices = useMemo(
        () => (selRange ? wordRows.slice(selRange.lo, selRange.hi + 1).map((r) => r.index) : []),
        [selRange, wordRows]
    );
    // When every selected word already has its caption hidden, the toolbar
    // offers "Restore caption" instead of "Remove caption".
    const allHidden = selCaptionIndices.length > 0
        && selCaptionIndices.every((i) => captions[i]?.captionHidden);
    // Selected words still in the video: what Edit and Emoji act on.
    const selKeptIndices = useMemo(
        () => selCaptionIndices.filter((i) => !isCutByWord[i]),
        [selCaptionIndices, isCutByWord]
    );
    // Emojis on the selected words (toolbar offers Remove when there are any).
    const selectedEmojis = [...new Set(selKeptIndices.map((i) => captions[i]?.emoji).filter(Boolean))];
    // The word the open picker writes to, so it can show that word's emoji.
    const pickerIndex = editingIndex ?? emojiTargets?.[0] ?? null;
    const pickerWord = pickerIndex != null ? captions[pickerIndex] : null;

    // Phrase emojis show once in the transcript, after the phrase's last word
    // still in the video (display order).
    const spanTail = useMemo(() => {
        const tail = new Map();
        wordRows.forEach((r) => {
            const span = r.word.emoji && r.word.emojiSpan;
            if (!span) return;
            if (!tail.has(span) || !isCutByWord[r.index]) tail.set(span, r.index);
        });
        return tail;
    }, [wordRows, isCutByWord]);

    const handleToggleCaption = () => {
        if (selCaptionIndices.length === 0) return;
        onSetCaptionHidden?.(selCaptionIndices, !allHidden);
        setSel(null);
    };

    const dismissToolbar = useCallback(() => {
        setSel(null);
    }, []);

    // Retype a whole selected phrase in one box.
    const startPhraseEdit = () => {
        if (selKeptIndices.length === 0) return;
        setPhraseEdit({
            indices: selKeptIndices,
            draft: selKeptIndices.map((i) => captions[i].text).join(' '),
        });
        setSel(null);
        setSelectedPause(null);
        setEditingIndex(null);
        setEmojiOpen(false);
    };

    const commitPhraseEdit = useCallback(() => {
        if (!phraseEdit) return;
        const { indices, draft: text } = phraseEdit;
        const before = indices.map((i) => captions[i]?.text).join(' ');
        if (text.trim() && text.trim().split(/\s+/).join(' ') !== before) {
            onUpdateCaptions((c) => retextPhrase(c, indices, text));
        }
        setPhraseEdit(null);
    }, [phraseEdit, captions, onUpdateCaptions]);

    // Drag across words to select a phrase. Delegated on the list so the
    // memoized <Word>s need no extra props. Shift-click still extends too.
    const onListMouseDown = useCallback((e) => {
        suppressClickRef.current = false;
        if (e.button !== 0 || e.shiftKey || e.target.closest('[data-transcript-emoji]')) return;
        const el = e.target.closest('[data-transcript-word]');
        if (!el) return;
        const index = Number(el.dataset.transcriptWord);
        if (isCutByWord[index]) return;
        dragRef.current = { anchor: index, moved: false };
    }, [isCutByWord]);

    const onListMouseOver = useCallback((e) => {
        const drag = dragRef.current;
        if (!drag) return;
        const el = e.target.closest('[data-transcript-word]');
        if (!el) return;
        const index = Number(el.dataset.transcriptWord);
        if (index === drag.anchor && !drag.moved) return;
        if (!drag.moved) {
            drag.moved = true;
            setDragging(true);
            setSelectedPause(null);
        }
        setSel({ anchor: drag.anchor, focus: index });
    }, []);

    useEffect(() => {
        const onUp = () => {
            const drag = dragRef.current;
            dragRef.current = null;
            if (!drag?.moved) return;
            suppressClickRef.current = true;
            setDragging(false);
            // Park the playhead at the start of the phrase so Play shows it.
            const cur = selRef.current;
            const lo = cur ? Math.min(posByIndex.get(cur.anchor) ?? 0, posByIndex.get(cur.focus) ?? 0) : null;
            const first = lo != null ? wordRows[lo] : null;
            if (first) seekToWord(first.word);
        };
        window.addEventListener('mouseup', onUp);
        return () => window.removeEventListener('mouseup', onUp);
    }, [posByIndex, wordRows, seekToWord]);

    // Toolbar position: recompute the anchor word's on-screen rect whenever the
    // selection, the transcript scroll, or the window size changes (popupTick).
    // Kept in state (not derived in render) so we read the DOM ref in an effect.
    // Depends on `sel` (stable state), NOT the derived selRange (new object each
    // render, which would re-run this every render).
    // The toolbar sits over the first selected word (display order).
    const toolbarIdx = selRange ? wordRows[selRange.lo]?.index ?? null : null;
    const [toolbarPos, setToolbarPos] = useState(null);
    useEffect(() => {
        if (toolbarIdx == null || !sel) { setToolbarPos(null); return; }
        const scroll = containerRef.current;
        const el = scroll?.querySelector(`[data-transcript-word="${toolbarIdx}"]`);
        if (!el || !scroll) { setToolbarPos(null); return; }
        const r = el.getBoundingClientRect();
        const bounds = scroll.getBoundingClientRect();
        // Hide the toolbar if the anchor word scrolled out of the visible list.
        setToolbarPos(r.bottom < bounds.top || r.top > bounds.bottom ? null : { top: r.top, left: r.left });
    }, [toolbarIdx, sel, popupTick]);

    // Bump popupTick on transcript scroll and window resize so the toolbar
    // tracks its anchor word instead of floating in a stale spot.
    useEffect(() => {
        const scroll = containerRef.current;
        if (!scroll) return;
        const bump = () => setPopupTick((t) => t + 1);
        scroll.addEventListener('scroll', bump, { passive: true });
        window.addEventListener('resize', bump);
        return () => {
            scroll.removeEventListener('scroll', bump);
            window.removeEventListener('resize', bump);
        };
    }, []);

    // Escape, or a mousedown anywhere that isn't a transcript word or the
    // toolbar itself, dismisses the toolbar/selection (when not editing a word).
    // The toolbar stops its own mousedown from propagating, so its buttons fire.
    useEffect(() => {
        if (!sel) return;
        const onKey = (e) => { if (e.key === 'Escape') dismissToolbar(); };
        const onDown = (e) => {
            if (e.target.closest?.('[data-transcript-word],[data-transcript-toolbar]')) return;
            dismissToolbar();
        };
        window.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => {
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onDown);
        };
    }, [sel, dismissToolbar]);

    const seekToPause = useCallback(
        (pause) => {
            const p = playerRef.current;
            if (!p) return;
            p.pause();
            const { start, end } = pauseToSource(pause);
            const mid = Math.round((start + end) / 2);
            const hits = sourceToOutputAll(framing, mid, EDITOR_FPS);
            if (hits[0] !== undefined) p.seekTo(hits[0]);
        },
        [playerRef, framing, pauseToSource]
    );

    const onPauseClick = useCallback(
        (pause) => {
            setSel(null);
            setSelectedPause(pause);
            if (!cutPauseKeys.has(pause.index)) seekToPause(pause);
        },
        [cutPauseKeys, seekToPause]
    );

    const handleCutPause = () => {
        if (!selectedPause) return;
        const { start, end } = pauseToSource(selectedPause);
        dispatch({ type: 'CUT_SOURCE_RANGE', ranges: [{ startFrame: start, endFrame: end }] });
        setSelectedPause(null);
    };

    const applyCleanup = useCallback(() => {
        const ranges = [
            ...(removeFillers ? detectFillerCuts(captions, framing) : []),
            ...(removePauses ? detectPauseCuts(captions, framing) : []),
        ];
        if (ranges.length > 0) dispatch({ type: 'CUT_SOURCE_RANGE', ranges });
        setCleanupOpen(false);
    }, [removeFillers, removePauses, captions, framing, dispatch]);

    const selCount = selRange ? selRange.hi - selRange.lo + 1 : 0;

    return (
        <div className="w-[380px] shrink-0 border-r border-white/[0.05] bg-[#0b0b0d] flex flex-col min-h-0">
            <div className="px-4 pt-3.5 pb-2 shrink-0 relative">
                {/* OpusClip: Speech cleanup pill on top; "Extend a clip" sits on
                    its own row right above the transcript (see below). */}
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setCleanupOpen((v) => !v)}
                        disabled={captions.length === 0}
                        title="Auto-remove filler words and pauses"
                        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium border transition-colors ${
                            captions.length === 0
                                ? 'opacity-40 cursor-not-allowed border-emerald-500/15 text-emerald-700/60 bg-emerald-500/5'
                                : cleanupOpen
                                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200'
                                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400/90 hover:bg-emerald-500/15 hover:text-emerald-300'
                        }`}
                    >
                        <Wand2 size={13} /> Speech cleanup
                    </button>
                </div>
                {cleanupOpen && (
                    <div className="absolute right-4 top-full mt-1 z-30 w-56 bg-surface2 border border-edge rounded-lg shadow-lg p-3 text-xs">
                        <p className="text-[11px] text-muted mb-2">Auto-detect and remove:</p>
                        <label className="flex items-center gap-2 mb-1.5 cursor-pointer text-zinc-300">
                            <input
                                type="checkbox"
                                checked={removeFillers}
                                onChange={(e) => setRemoveFillers(e.target.checked)}
                                className="accent-viral"
                            />
                            Remove filler words
                        </label>
                        <label className="flex items-center gap-2 mb-3 cursor-pointer text-zinc-300">
                            <input
                                type="checkbox"
                                checked={removePauses}
                                onChange={(e) => setRemovePauses(e.target.checked)}
                                className="accent-viral"
                            />
                            Remove pauses
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={applyCleanup}
                                disabled={!removeFillers && !removePauses}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-viral/15 border border-viral/40 text-viral hover:bg-viral/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <Wand2 size={12} /> Apply
                            </button>
                            <button
                                onClick={() => setCleanupOpen(false)}
                                className="text-[11px] text-muted hover:text-fg px-2 py-1"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
            {/* Opus placement: "Extend a clip" directly above the transcript.
                Clicking it extends the BEGINNING of the short — the picker opens
                at the clip's start in the original and the section is prepended. */}
            {onOpenExtend && (
                <div className="px-4 pb-1.5 shrink-0">
                    {extending ? (
                        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-[#3dd68c]/12 border border-[#3dd68c]/30 text-[12px] text-[#3dd68c] animate-pulse">
                            <Loader2 size={12} className="animate-spin" /> Adding…
                        </span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => onOpenExtend({ prepend: true, sec: clipInfo[0]?.origSec ?? null })}
                            title="Add a section of the original video before the start of this short"
                            className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-white/10 bg-white/[0.03] text-[12px] text-zinc-300 hover:text-[#3dd68c] hover:border-[#3dd68c]/30 hover:bg-[#3dd68c]/10 transition-colors"
                        >
                            <Plus size={13} /> Extend a clip
                        </button>
                    )}
                </div>
            )}
            <div
                ref={containerRef}
                onMouseDown={onListMouseDown}
                onMouseOver={onListMouseOver}
                // select-none: dragging across words selects a phrase in our
                // own highlight, not the browser's text selection.
                className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-6 leading-8 select-none"
                // plaintext: let the bidi algorithm reorder runs (Arabic RTL, Latin
                // LTR) per the first strong char of each block, without isolating
                // each word. textAlign:start makes Arabic lines hug the right edge.
                style={{ unicodeBidi: 'plaintext', textAlign: 'start' }}
            >
                {captions.length === 0 ? (
                    <p className="text-xs text-muted mt-2">No transcript available for this clip.</p>
                ) : (
                    rows.map((row) =>
                        row.type === 'extend' ? (
                            <button
                                key={row.key}
                                type="button"
                                disabled={extending}
                                onClick={() => onOpenExtend({ afterClipId: row.afterClipId, sec: row.sec })}
                                title="Add a section of the original video here"
                                className="w-full h-7 my-1.5 rounded-full bg-white/[0.04] hover:bg-[#3dd68c]/10 border border-transparent hover:border-[#3dd68c]/30 text-zinc-500 hover:text-[#3dd68c] flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <Plus size={13} />
                            </button>
                        ) : row.type === 'divider' ? (
                            <div key={`d-${row.id}`} className="flex items-center gap-2 my-2 select-none">
                                <span className="text-[10px] font-medium text-zinc-400 bg-surface2 border border-edge px-1.5 py-0.5 rounded">
                                    Clip {(row.ms / 1000).toFixed(1)}s · {LAYOUT_LABEL[row.layout] || row.layout}
                                </span>
                                <div className="flex-1 h-px bg-edge" />
                            </div>
                        ) : row.type === 'pause' ? (
                            <PauseChip
                                key={`p-${row.index}`}
                                pause={row}
                                selected={selectedPause?.index === row.index}
                                isCut={cutPauseKeys.has(row.index)}
                                onPauseClick={onPauseClick}
                            />
                        ) : phraseEdit?.indices.includes(row.index) ? (
                            // The phrase's first word holds the edit box; its
                            // other words are folded into it.
                            row.index === phraseEdit.indices[0] ? (
                                <span key={`w-${row.index}`} className="block my-1">
                                    <textarea
                                        data-transcript-editor=""
                                        data-posthog-sensitive="true"
                                        dir="auto"
                                        autoFocus
                                        onFocus={(e) => e.target.select()}
                                        value={phraseEdit.draft}
                                        rows={Math.min(6, Math.max(2, Math.ceil(phraseEdit.draft.length / 38)))}
                                        onChange={(e) => {
                                            const value = e.target.value;
                                            setPhraseEdit((pe) => (pe ? { ...pe, draft: value } : pe));
                                        }}
                                        onBlur={commitPhraseEdit}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                commitPhraseEdit();
                                            }
                                            if (e.key === 'Escape') setPhraseEdit(null);
                                        }}
                                        className="block w-full resize-none bg-surface2 border border-white/30 rounded px-2 py-1 text-sm leading-6 text-fg focus:outline-none select-text"
                                    />
                                    <span className="block text-[10px] leading-4 text-muted mt-0.5">Enter to save, Esc to cancel</span>
                                </span>
                            ) : null
                        ) : editingIndex === row.index ? (
                            <React.Fragment key={`w-${row.index}`}>
                                <input
                                    data-transcript-editor=""
                                    data-posthog-sensitive="true"
                                    dir="auto"
                                    autoFocus
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onBlur={() => {
                                        if (emojiInteractingRef.current) return;
                                        commitEdit();
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') commitEdit();
                                        if (e.key === 'Escape') {
                                            setEditingIndex(null);
                                            setEmojiOpen(false);
                                        }
                                    }}
                                    className="inline-block bg-surface2 border border-white/30 rounded px-1 text-sm leading-7 text-fg focus:outline-none"
                                    // ch-based width is approximate for Arabic; min/max keeps it usable.
                                    style={{ minWidth: '5ch', maxWidth: '22ch', width: `${Math.min(18, Math.max(5, [...draft].length + 2))}ch` }}
                                />
                                <button
                                    type="button"
                                    data-emoji-picker-trigger=""
                                    onMouseDown={(e) => {
                                        emojiInteractingRef.current = true;
                                        e.preventDefault();
                                    }}
                                    onClick={() => setEmojiOpen(true)}
                                    title="Add emoji"
                                    className="inline-flex items-center justify-center align-baseline ml-1 size-6 rounded-md border border-white/15 bg-[#1c1c1f] text-zinc-300 hover:text-white hover:bg-white/10"
                                >
                                    <Smile size={14} />
                                </button>
                            </React.Fragment>
                        ) : (
                            <Word
                                key={`w-${row.index}`}
                                index={row.index}
                                word={row.word}
                                isActive={row.index === activeIndex}
                                suppressHighlight={!!selectedPause}
                                isCut={isCutByWord[row.index]}
                                captionHidden={!!row.word.captionHidden}
                                inSel={!!(selRange && row.pos >= selRange.lo && row.pos <= selRange.hi)}
                                showEmoji={!!row.word.emoji && (!row.word.emojiSpan || spanTail.get(row.word.emojiSpan) === row.index)}
                                inSpan={!!(row.word.emoji && row.word.emojiSpan)}
                                onWordClick={onWordClick}
                                onEdit={onEdit}
                                onEmojiClick={onEmojiClick}
                            />
                        )
                    )
                )}
            </div>

            {/* Floating Opus-style toolbar: appears above the selected word(s).
                Edit (one word, or the whole phrase in one box), Emoji (a phrase
                gets one emoji for its whole duration), Remove/Restore caption,
                Remove caption+video. */}
            {selCount > 0 && toolbarPos && editingIndex === null && !dragging && (
                <div
                    data-transcript-toolbar=""
                    className="fixed z-[130] flex items-center gap-0.5 -translate-y-full -translate-x-0 rounded-lg border border-edge bg-[#17171b] shadow-2xl p-1"
                    style={{ top: toolbarPos.top - 8, left: toolbarPos.left }}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    {selKeptIndices.length > 0 && (
                        <button
                            onClick={() =>
                                selKeptIndices.length === 1
                                    ? onEdit(selKeptIndices[0], captions[selKeptIndices[0]])
                                    : startPhraseEdit()
                            }
                            title={selKeptIndices.length === 1 ? 'Edit this word' : 'Edit the text of the selected words'}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-200 hover:bg-white/10 transition-colors"
                        >
                            <Pencil size={13} /> Edit
                        </button>
                    )}
                    {/* Emoji sits right next to Edit so adding one is a single
                        click on the word, not click-word then Edit then emoji. */}
                    {selKeptIndices.length > 0 && (
                        <button
                            data-toolbar-emoji=""
                            onClick={() => openEmojiFor(selKeptIndices)}
                            title={
                                selKeptIndices.length > 1
                                    ? 'Add one emoji that stays up while these words are spoken'
                                    : selectedEmojis.length ? 'Change this word\'s emoji' : 'Add an emoji to this word'
                            }
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-200 hover:bg-white/10 transition-colors"
                        >
                            <Smile size={13} /> Emoji
                        </button>
                    )}
                    {selectedEmojis.length > 0 && (
                        <button
                            data-toolbar-remove-emoji=""
                            onClick={() => {
                                onUpdateCaptions((c) => clearEmojis(c, selKeptIndices));
                                dismissToolbar();
                            }}
                            title="Take the emoji off these words"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-200 hover:bg-white/10 transition-colors"
                        >
                            <X size={13} /> Remove {selectedEmojis.length === 1 ? selectedEmojis[0] : 'emojis'}
                        </button>
                    )}
                    <button
                        onClick={handleToggleCaption}
                        title={allHidden ? 'Show this caption again' : 'Hide the caption but keep the video'}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-200 hover:bg-white/10 transition-colors"
                    >
                        {allHidden ? <><Eye size={13} /> Restore caption</> : <><EyeOff size={13} /> Remove caption</>}
                    </button>
                    <button
                        onClick={handleCut}
                        title="Remove these words from the video and the caption"
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-red-300 hover:bg-red-500/20 transition-colors"
                    >
                        <Scissors size={13} /> Remove caption &amp; video
                    </button>
                </div>
            )}

            {selectedPause && (
                <div className="shrink-0 border-t border-edge p-2.5 flex items-center gap-2 bg-[#050506]">
                    <button
                        onClick={handleCutPause}
                        disabled={cutPauseKeys.has(selectedPause.index)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300 hover:bg-red-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Scissors size={13} /> Cut {selectedPause.label} pause
                    </button>
                    <button
                        onClick={() => setSelectedPause(null)}
                        className="text-[11px] text-muted hover:text-fg px-2 py-1"
                    >
                        Cancel
                    </button>
                </div>
            )}

            {emojiOpen && (
                <EmojiPicker
                    current={pickerWord}
                    onPick={insertEmoji}
                    onRemove={removeEmoji}
                    onClose={commitEdit}
                    onInteract={markEmojiInteracting}
                />
            )}
        </div>
    );
}
