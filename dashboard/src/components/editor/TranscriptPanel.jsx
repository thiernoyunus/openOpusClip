import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { FileText, Scissors, RotateCcw } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';
import { sourceToOutput } from '../../remotion/lib/edl';

const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four' };

/**
 * Opus-style transcript column with text-based editing: word-level captions,
 * click a word to seek, the word under the playhead highlights during
 * playback, double-click to edit text, select a range and Cut to remove that
 * content from the clip (adds an EDL cut). Words inside a cut render struck
 * through; click one to select its cut and Restore it.
 */
export default function TranscriptPanel({ captions, framing, playerRef, onEditWord, dispatch }) {
    const [currentMs, setCurrentMs] = useState(0);
    const [editingIndex, setEditingIndex] = useState(null);
    const [draft, setDraft] = useState('');
    const [sel, setSel] = useState(null); // {anchor, focus} word indices
    const [selectedCut, setSelectedCut] = useState(null); // cut index
    const containerRef = useRef(null);

    const srcFps = framing.source.fps;
    const clipIn = framing.clipInFrame ?? 0;
    const cuts = framing.cuts ?? [];

    // Word -> source frames (captions are ms relative to the clip start)
    const wordToSource = useCallback(
        (word) => ({
            start: clipIn + Math.round((word.startMs / 1000) * srcFps),
            end: clipIn + Math.round((word.endMs / 1000) * srcFps),
        }),
        [clipIn, srcFps]
    );

    // Which cut (if any) a word falls inside, by its midpoint
    const cutIndexForWord = useCallback(
        (word) => {
            const { start, end } = wordToSource(word);
            const mid = (start + end) / 2;
            return cuts.findIndex((c) => mid >= c.startFrame && mid < c.endFrame);
        },
        [cuts, wordToSource]
    );

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        const onFrame = (e) => setCurrentMs((e.detail.frame / EDITOR_FPS) * 1000);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    const segmentStarts = useMemo(() => {
        if (!framing) return [];
        return framing.segments.map((s) => ({
            ms: ((s.startFrame - clipIn) / srcFps) * 1000,
            layout: s.layout,
            id: s.id,
        }));
    }, [framing, clipIn, srcFps]);

    const rows = useMemo(() => {
        const out = [];
        let nextSeg = 0;
        captions.forEach((word, index) => {
            while (
                nextSeg < segmentStarts.length &&
                segmentStarts[nextSeg].ms <= word.startMs
            ) {
                out.push({ type: 'divider', ...segmentStarts[nextSeg] });
                nextSeg += 1;
            }
            out.push({ type: 'word', word, index });
        });
        return out;
    }, [captions, segmentStarts]);

    const activeIndex = useMemo(() => {
        // currentMs is on the OUTPUT timeline; compare against each word's
        // output position so highlighting stays correct through cuts
        for (let i = captions.length - 1; i >= 0; i--) {
            const { start, end } = wordToSource(captions[i]);
            const outStart = sourceToOutput(framing, start, EDITOR_FPS, true);
            if (outStart === null) continue; // word is cut
            const outStartMs = (outStart / EDITOR_FPS) * 1000;
            const outEnd = sourceToOutput(framing, end, EDITOR_FPS) ?? outStart;
            const outEndMs = (outEnd / EDITOR_FPS) * 1000;
            if (currentMs >= outStartMs) {
                return currentMs <= outEndMs + 150 ? i : -1;
            }
        }
        return -1;
    }, [captions, currentMs, framing, wordToSource]);

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
            const { start } = wordToSource(word);
            p.seekTo(sourceToOutput(framing, start, EDITOR_FPS) ?? 0);
        },
        [playerRef, framing, wordToSource]
    );

    const commitEdit = useCallback(() => {
        if (editingIndex !== null && draft.trim()) {
            onEditWord(editingIndex, draft.trim());
        }
        setEditingIndex(null);
    }, [editingIndex, draft, onEditWord]);

    const onWordClick = (index, word, e) => {
        const cutIdx = cutIndexForWord(word);
        if (cutIdx !== -1) {
            // clicking cut content selects its cut so it can be restored
            setSelectedCut(cutIdx);
            setSel(null);
            return;
        }
        setSelectedCut(null);
        if (e.shiftKey && sel) {
            setSel({ anchor: sel.anchor, focus: index });
        } else {
            setSel({ anchor: index, focus: index });
            seekToWord(word);
        }
    };

    const selRange = sel
        ? { lo: Math.min(sel.anchor, sel.focus), hi: Math.max(sel.anchor, sel.focus) }
        : null;

    const handleCut = () => {
        if (!selRange) return;
        const startFrame = wordToSource(captions[selRange.lo]).start;
        const endFrame = wordToSource(captions[selRange.hi]).end;
        dispatch({ type: 'ADD_CUT', startFrame, endFrame });
        setSel(null);
    };

    const handleRestore = () => {
        if (selectedCut === null) return;
        dispatch({ type: 'REMOVE_CUT', index: selectedCut });
        setSelectedCut(null);
    };

    const selCount = selRange ? selRange.hi - selRange.lo + 1 : 0;

    return (
        <div className="w-[300px] shrink-0 border-r border-edge bg-surface flex flex-col min-h-0">
            <div className="px-4 pt-4 pb-2 flex items-center gap-1.5 text-xs text-muted shrink-0">
                <FileText size={13} /> Transcript
                <span className="ml-auto text-[10px] text-zinc-600">shift-click to select · ✂ to cut</span>
            </div>
            <div ref={containerRef} className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-4 leading-7">
                {captions.length === 0 ? (
                    <p className="text-xs text-muted mt-2">No transcript available for this clip.</p>
                ) : (
                    rows.map((row) =>
                        row.type === 'divider' ? (
                            <div key={`d-${row.id}`} className="flex items-center gap-2 my-2 select-none">
                                <span className="text-[10px] font-medium text-zinc-400 bg-surface2 border border-edge px-1.5 py-0.5 rounded">
                                    {(row.ms / 1000).toFixed(1)}s · {LAYOUT_LABEL[row.layout] || row.layout}
                                </span>
                                <div className="flex-1 h-px bg-edge" />
                            </div>
                        ) : editingIndex === row.index ? (
                            <input
                                key={`w-${row.index}`}
                                autoFocus
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onBlur={commitEdit}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitEdit();
                                    if (e.key === 'Escape') setEditingIndex(null);
                                }}
                                className="inline-block w-20 bg-surface2 border border-white/30 rounded px-1 text-sm text-fg focus:outline-none"
                            />
                        ) : (
                            (() => {
                                const isCut = cutIndexForWord(row.word) !== -1;
                                const inSel = selRange && row.index >= selRange.lo && row.index <= selRange.hi;
                                return (
                                    <span
                                        key={`w-${row.index}`}
                                        data-active-word={row.index === activeIndex ? '' : undefined}
                                        onClick={(e) => onWordClick(row.index, row.word, e)}
                                        onDoubleClick={() => {
                                            if (isCut) return;
                                            setEditingIndex(row.index);
                                            setDraft(row.word.text);
                                        }}
                                        className={`cursor-pointer text-sm rounded px-0.5 transition-colors ${
                                            isCut
                                                ? 'line-through text-zinc-600 hover:text-zinc-400'
                                                : inSel
                                                  ? 'bg-amber-400/30 text-fg'
                                                  : row.index === activeIndex
                                                    ? 'bg-viral/30 text-fg'
                                                    : 'text-zinc-300 hover:bg-white/10'
                                        }`}
                                    >
                                        {row.word.text}{' '}
                                    </span>
                                );
                            })()
                        )
                    )
                )}
            </div>

            {/* Action bar: Cut a selection or Restore a clicked cut */}
            {(selCount > 0 || selectedCut !== null) && (
                <div className="shrink-0 border-t border-edge p-2.5 flex items-center gap-2">
                    {selectedCut !== null ? (
                        <button
                            onClick={handleRestore}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface2 border border-edge text-xs text-fg hover:bg-white/5 transition-colors"
                        >
                            <RotateCcw size={13} /> Restore cut content
                        </button>
                    ) : (
                        <button
                            onClick={handleCut}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-xs text-red-300 hover:bg-red-500/25 transition-colors"
                        >
                            <Scissors size={13} /> Cut {selCount} word{selCount > 1 ? 's' : ''}
                        </button>
                    )}
                    <button
                        onClick={() => {
                            setSel(null);
                            setSelectedCut(null);
                        }}
                        className="text-[11px] text-muted hover:text-fg px-2 py-1"
                    >
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
}
