import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, AlertCircle, LayoutGrid, Captions } from 'lucide-react';
import { getApiUrl } from '../../config';
import useEditorState, { defaultSubtitleConfig } from './useEditorState';
import EditorTopBar from './EditorTopBar';
import EditorCanvas, { EDITOR_FPS } from './EditorCanvas';
import EditorTimeline from './EditorTimeline';
import LayoutPanel from './LayoutPanel';
import TranscriptPanel from './TranscriptPanel';
import CaptionsPanel from './CaptionsPanel';

/**
 * Full-screen clip editor (docs/video-editor-plan.md Phases 3-6).
 * Loads the clip's framing.json, transcript, and 16:9 source; previews the
 * reframe + captions live in a Remotion Player; per-segment layout editing,
 * caption styling, transcript-based seeking and word editing.
 */
export default function EditorView({ clip, index, jobId, onClose, onExported }) {
    const [state, dispatch] = useEditorState();
    const [loadError, setLoadError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [captions, setCaptions] = useState([]);
    const [activeTab, setActiveTab] = useState('layout'); // layout | captions
    const playerRef = useRef(null);

    const framingUrl = clip.framing_url ? getApiUrl(clip.framing_url) : null;
    const sourceUrl = clip.source_url ? getApiUrl(clip.source_url) : null;

    useEffect(() => {
        if (!framingUrl) {
            setLoadError('This clip has no framing data. Reprocess the video to enable editing.');
            return;
        }
        let cancelled = false;
        fetch(framingUrl)
            .then((res) => {
                if (!res.ok) throw new Error(`Failed to load framing data (${res.status})`);
                return res.json();
            })
            .then((framing) => {
                if (cancelled) return;
                if (!framing || !framing.segments || !framing.source) {
                    throw new Error('Framing data is malformed.');
                }
                dispatch({ type: 'LOAD', framing });
            })
            .catch((e) => {
                if (!cancelled) setLoadError(e.message);
            });
        return () => {
            cancelled = true;
        };
    }, [framingUrl, dispatch]);

    // Word-level transcript for the transcript panel and captions
    useEffect(() => {
        if (jobId == null || index == null) return;
        let cancelled = false;
        fetch(getApiUrl(`/api/clip/${jobId}/${index}/transcript`))
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!cancelled && data?.captions) setCaptions(data.captions);
            })
            .catch(() => {}); // transcript is optional — editor works without it
        return () => {
            cancelled = true;
        };
    }, [jobId, index]);

    const handleEditWord = useCallback(
        (wordIndex, text) => {
            setCaptions((prev) => prev.map((w, i) => (i === wordIndex ? { ...w, text } : w)));
            if (state.framing?.subtitles) {
                dispatch({ type: 'EDIT_CAPTION_WORD', index: wordIndex, text });
            } else if (state.framing) {
                // Editing a caption implies wanting captions: enable with the edit applied
                const edited = captions.map((w, i) => (i === wordIndex ? { ...w, text } : w));
                dispatch({ type: 'SET_SUBTITLES', subtitles: defaultSubtitleConfig(edited) });
            }
        },
        [state.framing, captions, dispatch]
    );

    const handleBack = useCallback(() => {
        if (state.dirty && !window.confirm('You have unsaved changes. Leave the editor anyway?')) {
            return;
        }
        onClose();
    }, [state.dirty, onClose]);

    const showError = useCallback((message) => {
        setActionError(message);
        setTimeout(() => setActionError(null), 6000);
    }, []);

    const saveFraming = useCallback(async () => {
        const res = await fetch(getApiUrl(`/api/clips/${jobId}/${index}/framing`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state.framing),
        });
        if (!res.ok) {
            const text = await res.text();
            let detail = text;
            try {
                detail = JSON.parse(text).detail || text;
            } catch { /* plain text */ }
            throw new Error(`Save failed: ${detail}`);
        }
        dispatch({ type: 'MARK_SAVED' });
    }, [jobId, index, state.framing, dispatch]);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await saveFraming();
        } catch (e) {
            showError(e.message);
        } finally {
            setSaving(false);
        }
    }, [saveFraming, showError]);

    const handleExport = useCallback(async () => {
        setExporting(true);
        setExportProgress(0);
        try {
            // Persist the framing first so export and saved state never diverge
            if (state.dirty) await saveFraming();

            const durationInFrames = Math.max(
                1,
                Math.round((state.framing.source.durationFrames / state.framing.source.fps) * EDITOR_FPS)
            );
            const res = await fetch(getApiUrl('/render'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId,
                    clipIndex: index,
                    props: {
                        videoUrl: clip.video_url || '',
                        sourceVideoUrl: clip.source_url,
                        framing: state.framing,
                        durationInFrames,
                        fps: EDITOR_FPS,
                        width: 1080,
                        height: 1920,
                        subtitles: state.framing.subtitles ?? null,
                        hook: null,
                        effects: null,
                    },
                }),
            });
            if (!res.ok) throw new Error(`Render service error (${res.status}). Is the renderer running?`);
            const { renderId } = await res.json();

            // Poll until the render finishes
            let outputUrl = null;
            for (;;) {
                await new Promise((r) => setTimeout(r, 1500));
                const statusRes = await fetch(getApiUrl(`/render/${renderId}`));
                if (!statusRes.ok) throw new Error('Lost contact with the render service.');
                const status = await statusRes.json();
                setExportProgress(status.progress ?? 0);
                if (status.status === 'done') {
                    outputUrl = status.outputUrl;
                    break;
                }
                if (status.status === 'error') {
                    throw new Error(status.error || 'Render failed.');
                }
            }

            // Promote the rendered file to be the clip's video
            const filename = outputUrl.split('/').pop();
            const applyRes = await fetch(getApiUrl('/api/clips/apply-render'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, clip_index: index, filename }),
            });
            if (!applyRes.ok) throw new Error('Render finished but could not be applied to the clip.');
            const applied = await applyRes.json();
            onExported?.(applied.new_video_url);
        } catch (e) {
            showError(e.message);
        } finally {
            setExporting(false);
        }
    }, [state.dirty, state.framing, saveFraming, jobId, index, clip, onExported, showError]);

    // Keyboard shortcuts: Esc close · Space play/pause · ←/→ seek 1s ·
    // Cmd/Ctrl+Z undo · Shift+Cmd/Ctrl+Z redo · Cmd/Ctrl+S save
    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const mod = e.metaKey || e.ctrlKey;

            if (e.key === 'Escape') {
                handleBack();
            } else if (e.key === ' ' && !mod) {
                e.preventDefault();
                const p = playerRef.current;
                if (p) p.isPlaying() ? p.pause() : p.play();
            } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod) {
                e.preventDefault();
                const p = playerRef.current;
                if (p) {
                    const delta = (e.key === 'ArrowLeft' ? -1 : 1) * EDITOR_FPS;
                    p.pause();
                    p.seekTo(Math.max(0, p.getCurrentFrame() + delta));
                }
            } else if (mod && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                dispatch({ type: e.shiftKey ? 'REDO' : 'UNDO' });
            } else if (mod && e.key.toLowerCase() === 's') {
                e.preventDefault();
                handleSave();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handleBack, handleSave, dispatch]);

    const framing = state.framing;
    const durationInFrames = framing
        ? Math.max(1, Math.round((framing.source.durationFrames / framing.source.fps) * EDITOR_FPS))
        : 1;

    const title =
        clip.video_title_for_youtube_short || `Clip ${typeof index === 'number' ? index + 1 : ''}`;

    return (
        <div className="fixed inset-0 z-[120] bg-background flex flex-col animate-[fadeIn_0.15s_ease-out]">
            <EditorTopBar
                title={title}
                dirty={state.dirty}
                saving={saving}
                exporting={exporting}
                exportProgress={exportProgress}
                canUndo={state.past.length > 0}
                canRedo={state.future.length > 0}
                onUndo={() => dispatch({ type: 'UNDO' })}
                onRedo={() => dispatch({ type: 'REDO' })}
                onBack={handleBack}
                onSave={framing ? handleSave : undefined}
                onExport={framing ? handleExport : undefined}
            />

            {actionError && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 px-4 py-2.5 bg-red-500/15 border border-red-500/30 text-red-300 text-xs rounded-lg flex items-center gap-2 max-w-lg">
                    <AlertCircle size={13} className="shrink-0" /> {actionError}
                </div>
            )}

            {loadError ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted p-8 text-center">
                    <AlertCircle size={28} className="text-red-400" />
                    <p className="text-sm max-w-md">{loadError}</p>
                </div>
            ) : !framing ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted">
                    <Loader2 size={28} className="animate-spin" />
                    <p className="text-sm">Loading editor…</p>
                </div>
            ) : (
                <>
                    <div className="flex-1 flex min-h-0">
                        {/* Transcript column */}
                        <TranscriptPanel
                            captions={captions}
                            framing={framing}
                            playerRef={playerRef}
                            onEditWord={handleEditWord}
                        />

                        {/* Canvas */}
                        <div className="flex-1 min-w-0 bg-canvas flex items-center justify-center p-6">
                            <EditorCanvas
                                ref={playerRef}
                                sourceUrl={sourceUrl}
                                framing={framing}
                                subtitles={framing.subtitles || null}
                                durationInFrames={durationInFrames}
                            />
                        </div>

                        {/* Tool rail with tabs */}
                        <div className="w-[250px] shrink-0 border-l border-edge bg-surface flex flex-col min-h-0">
                            <div className="flex border-b border-edge shrink-0">
                                {[
                                    { id: 'layout', label: 'Layout', icon: LayoutGrid },
                                    { id: 'captions', label: 'Captions', icon: Captions },
                                ].map((tab) => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium transition-colors ${
                                            activeTab === tab.id
                                                ? 'text-fg border-b-2 border-fg -mb-px'
                                                : 'text-muted hover:text-fg'
                                        }`}
                                    >
                                        <tab.icon size={13} /> {tab.label}
                                    </button>
                                ))}
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {activeTab === 'layout' ? (
                                    <LayoutPanel
                                        framing={framing}
                                        selectedIds={state.selectedIds}
                                        dispatch={dispatch}
                                        sourceUrl={sourceUrl}
                                    />
                                ) : (
                                    <CaptionsPanel
                                        framing={framing}
                                        captions={captions}
                                        dispatch={dispatch}
                                    />
                                )}
                            </div>
                        </div>
                    </div>

                    <EditorTimeline
                        framing={framing}
                        playerRef={playerRef}
                        selectedIds={state.selectedIds}
                        onSelect={(id, multi) => dispatch({ type: 'SELECT', id, multi })}
                    />
                </>
            )}
        </div>
    );
}
