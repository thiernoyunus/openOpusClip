import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Clock, FileText, Scissors, Smile, Wand2, X } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { wordSourceToOutput, sourceToOutputAll } from '@remotion-src/lib/edl';
import { detectFillerCuts, detectPauseCuts, visibleTranscriptPauses } from './speechCleanup';
import { filterEmojiCategories } from './emojiData';

const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four' };

/**
 * A single transcript word. Memoized on its primitive props so that, during
 * playback, only the 1-2 words whose active/selection state actually changed
 * re-render — the other hundreds of words are skipped entirely. The parent
 * keeps the click/edit handlers stable (useCallback) and passes index+word
 * back through them, so this component's props stay referentially stable.
 */
const Word = React.memo(function Word({ index, word, isActive, suppressHighlight, isCut, inSel, onWordClick, onEdit }) {
    const displayText = word.emoji ? `${word.text} ${word.emoji}` : word.text;
    const colorClass = word.highlight ? 'text-[#04f827]' : 'text-white';
    return (
        <span
            data-transcript-word={index}
            data-active-word={isActive ? '' : undefined}
            onClick={(e) => onWordClick(index, word, e)}
            onDoubleClick={() => {
                if (isCut) return;
                onEdit(index, word);
            }}
            title="Click to seek. Double-click to edit text or add emoji."
            className={`cursor-pointer text-sm leading-7 rounded px-0.5 transition-colors ${
                isCut
                    ? 'line-through text-zinc-600 hover:text-zinc-400'
                    : inSel
                      ? 'bg-lime-300 text-black'
                      : isActive && !suppressHighlight
                        ? 'bg-lime-300/35 text-fg'
                        : `${colorClass} hover:bg-white/10`
            }`}
        >
            {displayText}{' '}
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
export default function TranscriptPanel({ captions, framing, playerRef, onEditWord, dispatch }) {
    const [currentMs, setCurrentMs] = useState(0);
    const [editingIndex, setEditingIndex] = useState(null);
    const [draft, setDraft] = useState('');
    const [sel, setSel] = useState(null); // {anchor, focus} word indices
    const [selectedPause, setSelectedPause] = useState(null);
    const [emojiOpen, setEmojiOpen] = useState(false);
    const [emojiQuery, setEmojiQuery] = useState('');
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

    const segmentStarts = useMemo(() => {
        if (!framing) return [];
        // Clip starts on the same origin-anchored ms axis as word.startMs so the
        // interleaved dividers land between the right words. Sorted by source
        // start (the transcript reads in source order — after a clip REORDER the
        // dividers reflect source position, not playback order; known limitation).
        return framing.clips
            .map((c) => ({
                ms: ((c.sourceStart - captionsOrigin) / srcFps) * 1000,
                layout: c.layout,
                id: c.id,
            }))
            .sort((a, b) => a.ms - b.ms);
    }, [framing, captionsOrigin, srcFps]);

    const rows = useMemo(() => {
        const out = [];
        let nextSeg = 0;
        const pauseByWord = new Map(pauses.map((pause) => [pause.index, pause]));
        captions.forEach((word, index) => {
            while (
                nextSeg < segmentStarts.length &&
                segmentStarts[nextSeg].ms <= word.startMs
            ) {
                out.push({ type: 'divider', ...segmentStarts[nextSeg] });
                nextSeg += 1;
            }
            out.push({ type: 'word', word, index });
            const pause = pauseByWord.get(index);
            if (pause) out.push({ type: 'pause', ...pause });
        });
        return out;
    }, [captions, pauses, segmentStarts]);

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
        setEmojiOpen(false);
    }, [editingIndex, draft, onEditWord]);

    const emojiCategories = useMemo(() => filterEmojiCategories(emojiQuery), [emojiQuery]);

    const insertEmoji = useCallback((emoji) => {
        if (editingIndex !== null) {
            const text = draft.trim();
            if (text) onEditWord(editingIndex, { text, emoji });
        }
        setEditingIndex(null);
        setSel(null);
        setEmojiOpen(false);
        setEmojiQuery('');
        emojiInteractingRef.current = false;
    }, [draft, editingIndex, onEditWord]);

    // Stable identity so memoized <Word> children don't re-render on every
    // frame just because the parent re-rendered. Reads sel via the functional
    // updater so it needn't be a dependency.
    const onWordClick = useCallback(
        (index, word, e) => {
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
        setEditingIndex(index);
        setDraft(word.text);
        setEmojiOpen(false);
        setEmojiQuery('');
    }, []);

    const selRange = sel
        ? { lo: Math.min(sel.anchor, sel.focus), hi: Math.max(sel.anchor, sel.focus) }
        : null;

    const handleCut = () => {
        if (!selRange) return;
        const startFrame = wordToSource(captions[selRange.lo]).start;
        const endFrame = wordToSource(captions[selRange.hi]).end;
        dispatch({ type: 'CUT_SOURCE_RANGE', ranges: [{ startFrame, endFrame }] });
        setSel(null);
    };

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
        <div className="w-[420px] shrink-0 border-r border-edge bg-[#050506] flex flex-col min-h-0">
            <div className="px-4 pt-3 pb-2 shrink-0 relative">
                <div className="flex items-center gap-1.5 text-xs text-muted">
                    <FileText size={12} /> Transcript
                    <button
                        onClick={() => setCleanupOpen((v) => !v)}
                        disabled={captions.length === 0}
                        title="Auto-remove filler words and pauses"
                        className={`ml-auto flex items-center gap-1 px-2 py-1 rounded bg-surface2 border border-edge text-[11px] transition-colors ${
                            captions.length === 0
                                ? 'opacity-40 cursor-not-allowed'
                                : cleanupOpen
                                  ? 'text-fg border-white/30'
                                  : 'text-muted hover:text-fg hover:bg-white/5'
                        }`}
                    >
                        <Wand2 size={12} /> Speech cleanup
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
                <div className="mt-1 flex items-center gap-2 text-[10px] text-zinc-600">
                    <span>click word to seek · double-click to edit/add emoji</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><Clock size={10} /> click pauses to cut</span>
                </div>
            </div>
            <div
                ref={containerRef}
                className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-5 leading-7"
                // plaintext: let the bidi algorithm reorder runs (Arabic RTL, Latin
                // LTR) per the first strong char of each block, without isolating
                // each word. textAlign:start makes Arabic lines hug the right edge.
                style={{ unicodeBidi: 'plaintext', textAlign: 'start' }}
            >
                {captions.length === 0 ? (
                    <p className="text-xs text-muted mt-2">No transcript available for this clip.</p>
                ) : (
                    rows.map((row) =>
                        row.type === 'divider' ? (
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
                        ) : editingIndex === row.index ? (
                            <React.Fragment key={`w-${row.index}`}>
                                <input
                                    data-transcript-editor=""
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
                                inSel={!!(selRange && row.index >= selRange.lo && row.index <= selRange.hi)}
                                onWordClick={onWordClick}
                                onEdit={onEdit}
                            />
                        )
                    )
                )}
            </div>

            {/* Action bar: Cut the selected words */}
            {selCount > 0 && (
                <div className="shrink-0 border-t border-edge p-2.5 flex items-center gap-2">
                    <button
                        onClick={handleCut}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300 hover:bg-red-500/25 transition-colors"
                    >
                        <Scissors size={13} /> Cut {selCount} word{selCount > 1 ? 's' : ''}
                    </button>
                    <button
                        onClick={() => setSel(null)}
                        className="text-[11px] text-muted hover:text-fg px-2 py-1"
                    >
                        Cancel
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
                <div
                    data-emoji-picker=""
                    className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center px-4"
                    onMouseDown={() => {
                        commitEdit();
                    }}
                >
                    <div
                        className="w-[430px] max-w-[calc(100vw-32px)] max-h-[70vh] rounded-lg border border-[#2b2d33] bg-[#0b0b0d] shadow-2xl p-3"
                        onMouseDown={(e) => {
                            emojiInteractingRef.current = true;
                            e.stopPropagation();
                        }}
                    >
                        <div className="flex items-center gap-2 mb-3">
                            <input
                                data-emoji-search=""
                                autoFocus
                                value={emojiQuery}
                                onChange={(e) => setEmojiQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') commitEdit();
                                }}
                                placeholder="Search"
                                className="h-10 flex-1 rounded-md border border-[#2d2f36] bg-[#18191d] px-3 text-sm text-fg placeholder:text-zinc-500 focus:outline-none focus:border-white/30"
                            />
                            <button
                                type="button"
                                onClick={() => {
                                    commitEdit();
                                }}
                                className="size-9 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 flex items-center justify-center"
                                title="Close"
                            >
                                <X size={16} />
                            </button>
                        </div>
                        <div className="overflow-y-auto custom-scrollbar pr-1 max-h-[46vh] space-y-3">
                            {emojiCategories.map((category) => (
                                <section key={category.label} data-emoji-category={category.label}>
                                    <div className="sticky top-0 z-10 inline-flex rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-950 shadow">
                                        {category.label}
                                    </div>
                                    <div className="mt-2 grid grid-cols-9 gap-1.5">
                                        {category.emojis.map((emoji, index) => (
                                            <button
                                                key={`${category.label}-${emoji}-${index}`}
                                                type="button"
                                                data-emoji-choice={emoji}
                                                onMouseDown={(e) => {
                                                    emojiInteractingRef.current = true;
                                                    e.preventDefault();
                                                }}
                                                onClick={() => insertEmoji(emoji)}
                                                className="size-10 rounded-md text-2xl leading-none flex items-center justify-center hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300/60"
                                            >
                                                {emoji}
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
