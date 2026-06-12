import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { FileText } from 'lucide-react';
import { EDITOR_FPS } from './EditorCanvas';

const LAYOUT_LABEL = { fill: 'Fill', fit: 'Fit', split: 'Split', three: 'Three', four: 'Four' };

/**
 * Opus-style transcript column: word-level captions, click a word to seek,
 * the word under the playhead highlights during playback, double-click a word
 * to edit its text. Scene dividers show where framing segments change.
 */
export default function TranscriptPanel({ captions, framing, playerRef, onEditWord }) {
    const [currentMs, setCurrentMs] = useState(0);
    const [editingIndex, setEditingIndex] = useState(null);
    const [draft, setDraft] = useState('');
    const containerRef = useRef(null);

    useEffect(() => {
        const p = playerRef.current;
        if (!p) return;
        const onFrame = (e) => setCurrentMs((e.detail.frame / EDITOR_FPS) * 1000);
        p.addEventListener('frameupdate', onFrame);
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [playerRef]);

    // Segment boundaries in ms, for the scene divider rows
    const segmentStarts = useMemo(() => {
        if (!framing) return [];
        return framing.segments.map((s) => ({
            ms: (s.startFrame / framing.source.fps) * 1000,
            layout: s.layout,
            id: s.id,
        }));
    }, [framing]);

    // Interleave words and scene dividers, then group into paragraphs at
    // dividers (matches how Opus breaks the transcript per scene)
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
        for (let i = captions.length - 1; i >= 0; i--) {
            if (currentMs >= captions[i].startMs) {
                return currentMs <= captions[i].endMs + 150 ? i : -1;
            }
        }
        return -1;
    }, [captions, currentMs]);

    // Keep the active word in view while playing
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
            p.seekTo(Math.round((word.startMs / 1000) * EDITOR_FPS));
        },
        [playerRef]
    );

    const commitEdit = useCallback(() => {
        if (editingIndex !== null && draft.trim()) {
            onEditWord(editingIndex, draft.trim());
        }
        setEditingIndex(null);
    }, [editingIndex, draft, onEditWord]);

    return (
        <div className="w-[300px] shrink-0 border-r border-edge bg-surface flex flex-col min-h-0">
            <div className="px-4 pt-4 pb-2 flex items-center gap-1.5 text-xs text-muted shrink-0">
                <FileText size={13} /> Transcript
                <span className="ml-auto text-[10px] text-zinc-600">double-click a word to edit</span>
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
                            <span
                                key={`w-${row.index}`}
                                data-active-word={row.index === activeIndex ? '' : undefined}
                                onClick={() => seekToWord(row.word)}
                                onDoubleClick={() => {
                                    setEditingIndex(row.index);
                                    setDraft(row.word.text);
                                }}
                                className={`cursor-pointer text-sm rounded px-0.5 transition-colors ${
                                    row.index === activeIndex
                                        ? 'bg-viral/30 text-fg'
                                        : 'text-zinc-300 hover:bg-white/10'
                                }`}
                            >
                                {row.word.text}{' '}
                            </span>
                        )
                    )
                )}
            </div>
        </div>
    );
}
