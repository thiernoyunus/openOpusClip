import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, AlertCircle, LayoutGrid, Captions, Crosshair, Sparkles, Type, Music, Clapperboard } from 'lucide-react';
import { getApiUrl } from '../../config';
import useEditorState, { defaultSubtitleConfig, loadDefaultCaptionStyle } from './useEditorState';
import { outputDurationFrames, outputToSource } from '../../remotion/lib/edl';
import EditorTopBar from './EditorTopBar';
import EditorCanvas, { EDITOR_FPS } from './EditorCanvas';
import EditorTimeline from './EditorTimeline';
import EditorToolRail from './EditorToolRail';
import LayoutPanel from './LayoutPanel';
import TranscriptPanel from './TranscriptPanel';
import CaptionsPanel from './CaptionsPanel';
import TransitionsPanel from './TransitionsPanel';
import TextPanel from './TextPanel';
import AudioPanel from './AudioPanel';
import BrollPanel from './BrollPanel';

/** Save a video URL to the browser's Downloads folder (fetch→blob→<a download>). */
async function downloadVideo(url, filename) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('fetch failed');
        const blobUrl = window.URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(blobUrl);
        document.body.removeChild(a);
    } catch {
        window.open(url, '_blank'); // ponytail: last-resort, opens in a tab
    }
}

const TABS = [
    { id: 'layout', label: 'Layout', icon: LayoutGrid },
    { id: 'captions', label: 'Captions', icon: Captions },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'audio', label: 'Audio', icon: Music },
    { id: 'broll', label: 'B-Roll', icon: Clapperboard },
    { id: 'transitions', label: 'Effects', icon: Sparkles },
];

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
    const [trackerOn, setTrackerOn] = useState(false);
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

    // Auto-enable captions on a clip's first open when the user chose a caption
    // preset at upload (enabled === true). Fires once; SET_SUBTITLES marks the
    // framing captionsInitialized so a deliberate later "off" sticks.
    const autoEnabledRef = useRef(false);
    useEffect(() => {
        if (autoEnabledRef.current) return;
        const f = state.framing;
        if (!f || f.subtitles || f.captionsInitialized) return;
        if (captions.length === 0) return;
        if (loadDefaultCaptionStyle()?.enabled !== true) return;
        autoEnabledRef.current = true;
        dispatch({ type: 'SET_SUBTITLES', subtitles: defaultSubtitleConfig(captions) });
    }, [state.framing, captions, dispatch]);

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

            const durationInFrames = outputDurationFrames(state.framing, EDITOR_FPS);
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
            // Deliver the export to the user's browser Downloads folder (the app
            // also keeps a copy under output/, but the export should "land" where
            // downloads go). Fetch→blob so it saves instead of navigating.
            await downloadVideo(getApiUrl(applied.new_video_url), `clip-${index + 1}.mp4`);
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
    const durationInFrames = framing ? outputDurationFrames(framing, EDITOR_FPS) : 1;

    // Current playhead in SOURCE frames — for inserting text/b-roll at the playhead
    const getCurrentSourceFrame = useCallback(
        () => (framing ? outputToSource(framing, playerRef.current?.getCurrentFrame() ?? 0, EDITOR_FPS) : 0),
        [framing]
    );

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
                            dispatch={dispatch}
                        />

                        {/* Canvas — tracker toggle floats over the top so it
                            doesn't steal vertical space from the preview. */}
                        <div className="flex-1 min-w-0 bg-canvas flex flex-col items-center justify-center min-h-0 p-4 relative">
                            <div className="relative flex-1 min-h-0 w-full">
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <EditorCanvas
                                        ref={playerRef}
                                        sourceUrl={sourceUrl}
                                        framing={framing}
                                        subtitles={framing.subtitles || null}
                                        durationInFrames={durationInFrames}
                                        trackerOn={trackerOn}
                                        dispatch={dispatch}
                                    />
                                </div>
                                <button
                                    onClick={() => setTrackerOn((v) => !v)}
                                    title="Click a person on the canvas to track them"
                                    className={`absolute top-2.5 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-viral ${
                                        trackerOn
                                            ? 'bg-viral/20 border-viral/50 text-viral'
                                            : 'bg-surface2/70 border-edge text-muted hover:text-fg'
                                    }`}
                                >
                                    <Crosshair size={12} />
                                    {trackerOn ? 'Tracker: ON' : 'Tracker'}
                                </button>
                            </div>
                        </div>

                        {/* Tool panel (scroll body only — the tab strip moved
                            into the vertical icon rail on the far right). */}
                        <div className="w-[300px] shrink-0 border-l border-edge bg-surface flex flex-col min-h-0">
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                {activeTab === 'layout' && (
                                    <LayoutPanel
                                        framing={framing}
                                        selectedIds={state.selectedIds}
                                        dispatch={dispatch}
                                        sourceUrl={sourceUrl}
                                    />
                                )}
                                {activeTab === 'captions' && (
                                    <CaptionsPanel framing={framing} captions={captions} dispatch={dispatch} />
                                )}
                                {activeTab === 'text' && (
                                    <TextPanel framing={framing} dispatch={dispatch} getCurrentSourceFrame={getCurrentSourceFrame} />
                                )}
                                {activeTab === 'audio' && (
                                    <AudioPanel framing={framing} jobId={jobId} clipIndex={index} dispatch={dispatch} />
                                )}
                                {activeTab === 'broll' && (
                                    <BrollPanel framing={framing} dispatch={dispatch} getCurrentSourceFrame={getCurrentSourceFrame} captions={captions} />
                                )}
                                {activeTab === 'transitions' && (
                                    <TransitionsPanel framing={framing} dispatch={dispatch} />
                                )}
                            </div>
                        </div>

                        {/* Vertical icon-only rail (far right edge) */}
                        <EditorToolRail tabs={TABS} activeId={activeTab} onSelect={setActiveTab} />
                    </div>

                    <EditorTimeline
                        framing={framing}
                        playerRef={playerRef}
                        selectedIds={state.selectedIds}
                        onSelect={(id, multi) => dispatch({ type: 'SELECT', id, multi })}
                        dispatch={dispatch}
                        sourceUrl={sourceUrl}
                    />
                </>
            )}
        </div>
    );
}
