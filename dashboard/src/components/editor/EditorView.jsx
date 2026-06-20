import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, AlertCircle, Captions, Crosshair, Sparkles, Type, Music, Clapperboard, ChevronRight, ChevronDown, Check, Crop, Trash2 } from 'lucide-react';
import { getApiUrl } from '../../config';
import useEditorState, { defaultSubtitleConfig, loadDefaultCaptionStyle, tracksInClip, LAYOUT_PANELS } from './useEditorState';
import { outputDurationFrames, outputToSource, placedClips, sourceToOutputAll } from '@remotion-src/lib/edl';
import EditorTopBar from './EditorTopBar';
import EditorCanvas, { EDITOR_FPS } from './EditorCanvas';
import EditorTimeline from './EditorTimeline';
import EditorToolRail from './EditorToolRail';
import TranscriptPanel from './TranscriptPanel';
import CaptionsPanel from './CaptionsPanel';
import TransitionsPanel from './TransitionsPanel';
import TextPanel from './TextPanel';
import AudioPanel from './AudioPanel';
import BrollPanel from './BrollPanel';
import ManualCropModal from './ManualCropModal';

const LAYOUT_LABEL = {
    fill: 'Fill',
    fit: 'Fit',
    split: 'Split',
    three: 'Three',
    four: 'Four',
    screenshare: 'ScreenShare',
    gameplay: 'Gameplay',
};

const LAYOUT_OPTIONS = ['fill', 'fit', 'split', 'three', 'four', 'screenshare', 'gameplay'];

const ASPECT_OPTIONS = [
    { label: 'Vertical 9:16', width: 1080, height: 1920 },
    { label: 'Square 1:1', width: 1080, height: 1080 },
    { label: 'Landscape 16:9', width: 1920, height: 1080 },
    { label: 'Portrait 4:5', width: 1080, height: 1350 },
];

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
    { id: 'captions', label: 'Captions', icon: Captions },
    { id: 'broll', label: 'B-Roll', icon: Clapperboard },
    { id: 'transitions', label: 'Transitions', icon: Sparkles },
    { id: 'text', label: 'Text', icon: Type },
    { id: 'audio', label: 'Audio', icon: Music },
];

function MiniLayoutIcon({ layout }) {
    const cell = 'bg-zinc-500 rounded-[1px]';
    if (layout === 'fill') return <div className={`w-3 h-4 ${cell}`} />;
    if (layout === 'fit') return <div className="w-4 h-3 border border-zinc-500 rounded-[1px]" />;
    if (layout === 'split') return <div className="w-4 h-4 grid grid-rows-2 gap-px"><div className={cell} /><div className={cell} /></div>;
    if (layout === 'three') return <div className="w-4 h-4 grid grid-rows-3 gap-px"><div className={cell} /><div className={cell} /><div className={cell} /></div>;
    if (layout === 'four') return <div className="w-4 h-4 grid grid-cols-2 gap-px"><div className={cell} /><div className={cell} /><div className={cell} /><div className={cell} /></div>;
    return <div className="w-4 h-4 border border-zinc-500 rounded-[1px]" />;
}

function AspectIcon({ width, height }) {
    const vertical = height > width;
    const square = height === width;
    return (
        <span
            className={`inline-block border border-current rounded-[1px] opacity-80 ${
                square ? 'w-3 h-3' : vertical ? 'w-2 h-4' : 'w-4 h-2'
            }`}
        />
    );
}

function EditorCanvasControls({ framing, selectedIds, trackerOn, onToggleTracker, dispatch, sourceUrl, playerRef }) {
    const [aspectOpen, setAspectOpen] = useState(false);
    const [layoutOpen, setLayoutOpen] = useState(false);
    const [globalOpen, setGlobalOpen] = useState(false);
    const [showCropModal, setShowCropModal] = useState(false);
    const controlsRef = useRef(null);
    const selected = framing.clips.filter((c) => selectedIds.includes(c.id));
    const primary = selected[0] || framing.clips[0];
    const activeLayout = primary?.layout || 'fill';
    const selectedForRules = selected.length ? selected : primary ? [primary] : [];
    const peopleAvailable = selectedForRules.length
        ? Math.min(...selectedForRules.map((c) => tracksInClip(framing, c).length))
        : 0;
    const globalPeopleAvailable = framing.clips.length
        ? Math.min(...framing.clips.map((c) => tracksInClip(framing, c).length))
        : 0;
    const outW = framing.outputWidth ?? 1080;
    const outH = framing.outputHeight ?? 1920;
    const fitMatchesFill = Math.abs((framing.source.width / framing.source.height) - (outW / outH)) < 0.01;
    const currentAspect = ASPECT_OPTIONS.find((a) => a.width === outW && a.height === outH) || ASPECT_OPTIONS[0];
    const canManuallyReframe = selected.length <= 1 && primary;

    const applyLayout = (layout, global = false) => {
        const clipIds = selected.length ? selectedIds : primary ? [primary.id] : [];
        if (!global && !selected.length && primary) dispatch({ type: 'SELECT', id: primary.id, multi: false });
        dispatch({ type: 'SET_LAYOUT', layout, global, clipIds });
        if (!global && primary) {
            const outFrame = placedClips(framing, EDITOR_FPS).find((p) => p.clip.id === primary.id)?.outStart;
            if (outFrame !== undefined) {
                playerRef.current?.pause();
                playerRef.current?.seekTo(outFrame);
            }
        }
        setLayoutOpen(false);
        setGlobalOpen(false);
    };

    useEffect(() => {
        if (!aspectOpen && !layoutOpen) return;
        const onPointerDown = (e) => {
            if (!controlsRef.current?.contains(e.target)) {
                setAspectOpen(false);
                setLayoutOpen(false);
                setGlobalOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        return () => window.removeEventListener('pointerdown', onPointerDown);
    }, [aspectOpen, layoutOpen]);

    const layoutRows = (global = false) => (
        <div className="py-1">
            {LAYOUT_OPTIONS.map((id) => {
                const needed = LAYOUT_PANELS[id] || 1;
                const availablePeople = global ? globalPeopleAvailable : peopleAvailable;
                const targetClips = global ? framing.clips : selectedForRules;
                const disabled = needed > 1 && availablePeople < needed;
                const active = targetClips.length
                    ? targetClips.every((c) => c.layout === id)
                    : activeLayout === id;
                return (
                    <button
                        key={`${global ? 'g' : 'c'}-${id}`}
                        disabled={disabled}
                        onClick={() => applyLayout(id, global)}
                        className={`w-full h-8 px-3 flex items-center gap-2 text-xs text-left transition-colors ${
                            disabled
                                ? 'text-zinc-600 cursor-not-allowed'
                                : 'text-zinc-300 hover:bg-white/5 hover:text-fg'
                        }`}
                    >
                        <MiniLayoutIcon layout={id} />
                        <span className="flex-1">{LAYOUT_LABEL[id] || id}{id === 'fit' && fitMatchesFill ? ' (same as Fill)' : ''}</span>
                        {active && !disabled && <Check size={13} />}
                    </button>
                );
            })}
        </div>
    );

    return (
        <div ref={controlsRef} className="relative z-30 flex items-center justify-center gap-3 text-[11px] text-zinc-300">
            <div className="relative">
                <button
                    onClick={() => { setAspectOpen((v) => !v); setLayoutOpen(false); setGlobalOpen(false); }}
                    className="h-7 px-2 rounded-md hover:bg-white/5 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-viral/50"
                    aria-haspopup="menu"
                    aria-expanded={aspectOpen}
                >
                    <AspectIcon width={outW} height={outH} />
                    {currentAspect.label.match(/\d+:\d+/)?.[0] || '9:16'}
                    <ChevronDown size={12} />
                </button>
                {aspectOpen && (
                    <div className="absolute left-0 top-full mt-1 w-44 rounded-md border border-edge bg-surface2 shadow-xl py-1">
                        {ASPECT_OPTIONS.map((opt) => {
                            const active = opt.width === outW && opt.height === outH;
                            return (
                                <button
                                    key={opt.label}
                                    disabled={!active}
                                    onClick={() => setAspectOpen(false)}
                                    className={`w-full h-8 px-3 flex items-center gap-2 text-xs text-left ${
                                        active ? 'text-zinc-400' : 'text-zinc-500 cursor-not-allowed'
                                    }`}
                                >
                                    <AspectIcon width={opt.width} height={opt.height} />
                                    <span className="flex-1">{opt.label}</span>
                                    {active && <Check size={13} className="text-zinc-300" />}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            <div className="relative">
                <button
                    onClick={() => { setLayoutOpen((v) => !v); setAspectOpen(false); setGlobalOpen(false); }}
                    className="h-7 px-2 rounded-md hover:bg-white/5 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-viral/50"
                    aria-haspopup="menu"
                    aria-expanded={layoutOpen}
                >
                    <MiniLayoutIcon layout={activeLayout} />
                    <span className="text-zinc-500">Layout:</span>
                    <span>{LAYOUT_LABEL[activeLayout] || activeLayout}</span>
                    <ChevronDown size={12} />
                </button>
                {layoutOpen && (
                    <div className="absolute left-0 top-full mt-1 w-52 rounded-md border border-edge bg-surface2 shadow-xl py-1">
                        <div className="relative" onMouseLeave={() => setGlobalOpen(false)}>
                            <button
                                onMouseEnter={() => setGlobalOpen(true)}
                                onFocus={() => setGlobalOpen(true)}
                                className="w-full h-9 px-3 flex items-center gap-2 text-xs text-left text-zinc-300 hover:bg-white/5"
                            >
                                <span className="flex-1">Global layout settings</span>
                                <ChevronRight size={13} />
                            </button>
                            {globalOpen && (
                                <div
                                    className="absolute left-full top-0 ml-1 w-36 rounded-md border border-edge bg-surface2 shadow-xl"
                                >
                                    {layoutRows(true)}
                                </div>
                            )}
                        </div>
                        <div className="px-3 pt-2 pb-1 text-[10px] text-zinc-500">Current layout</div>
                        {layoutRows(false)}
                        {canManuallyReframe && (
                            <div className="mt-1 border-t border-edge p-2">
                                <button
                                    onClick={() => {
                                        if (!selected.length) dispatch({ type: 'SELECT', id: primary.id, multi: false });
                                        setShowCropModal(true);
                                        setLayoutOpen(false);
                                        setGlobalOpen(false);
                                    }}
                                    className="w-full h-8 px-2 rounded-md flex items-center gap-2 text-xs text-zinc-300 hover:bg-white/5 hover:text-fg"
                                >
                                    <Crop size={13} />
                                    {primary.manualCrop ? 'Adjust manual reframe' : 'Set manual reframe'}
                                </button>
                                {primary.manualCrop && (
                                    <button
                                        onClick={() => {
                                            dispatch({ type: 'SET_MANUAL_CROP', clipId: primary.id, crop: null });
                                            setLayoutOpen(false);
                                            setGlobalOpen(false);
                                        }}
                                        className="mt-1 w-full h-8 px-2 rounded-md flex items-center gap-2 text-xs text-muted hover:bg-white/5 hover:text-fg"
                                    >
                                        <Trash2 size={12} />
                                        Remove manual reframe
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <button
                onClick={onToggleTracker}
                title="Click a person on the canvas to track them"
                className={`h-7 px-2 rounded-md flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-viral/50 ${
                    trackerOn ? 'bg-viral/15 text-viral' : 'hover:bg-white/5'
                }`}
            >
                <Crosshair size={13} />
                Tracker: {trackerOn ? 'ON' : 'OFF'}
            </button>
            {showCropModal && primary && (
                <ManualCropModal
                    sourceUrl={sourceUrl}
                    source={framing.source}
                    segment={primary}
                    onApply={(crop) => {
                        dispatch({ type: 'SET_MANUAL_CROP', clipId: primary.id, crop });
                        setShowCropModal(false);
                    }}
                    onClose={() => setShowCropModal(false)}
                />
            )}
        </div>
    );
}

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
    const [captions, setCaptions] = useState(() => clip.transcript_captions || clip.transcriptCaptions || []);
    const [activeTab, setActiveTab] = useState('captions');
    // Right tool panel is collapsed by default (max canvas space); a rail click
    // opens it, clicking the active tool (or the header chevron) collapses it.
    const [panelOpen, setPanelOpen] = useState(false);
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
                if (!framing || !framing.source || !(framing.clips || framing.segments)) {
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
        (wordIndex, edit) => {
            const patch = typeof edit === 'string' ? { text: edit } : edit;
            setCaptions((prev) => prev.map((w, i) => (i === wordIndex ? { ...w, ...patch } : w)));
            if (state.framing?.subtitles) {
                dispatch({ type: 'EDIT_CAPTION_WORD', index: wordIndex, patch });
            } else if (state.framing) {
                // Editing a caption implies wanting captions: enable with the edit applied
                const edited = captions.map((w, i) => (i === wordIndex ? { ...w, ...patch } : w));
                dispatch({ type: 'SET_SUBTITLES', subtitles: defaultSubtitleConfig(edited) });
            }
        },
        [state.framing, captions, dispatch]
    );

    // AI enhance / clear writes emoji+highlight onto the subtitle config; mirror
    // it onto the transcript captions (by index) so the transcript shows what the
    // AI added, exactly like a manual per-word emoji edit does.
    const handleEnhanceCaptions = useCallback((mergedWords) => {
        setCaptions((prev) => prev.map((w, i) => {
            const m = mergedWords[i];
            if (!m) return w;
            const next = { ...w };
            if (m.emoji) next.emoji = m.emoji; else delete next.emoji;
            if (m.highlight) next.highlight = true; else delete next.highlight;
            return next;
        }));
    }, []);

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

    // Rail click: collapse if it's the already-open tool, else open that tool.
    const handleToolSelect = useCallback((id) => {
        if (panelOpen && id === activeTab) {
            setPanelOpen(false);
        } else {
            setActiveTab(id);
            setPanelOpen(true);
        }
    }, [panelOpen, activeTab]);

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
                        width: state.framing.outputWidth ?? 1080,
                        height: state.framing.outputHeight ?? 1920,
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

                        <div className="flex-1 min-w-0 bg-background flex min-h-0">
                            <div data-editor-canvas-column className="flex-1 min-w-0 flex flex-col min-h-0">
                                <div className="h-10 shrink-0 flex items-center justify-center">
                                    <EditorCanvasControls
                                        framing={framing}
                                        selectedIds={state.selectedIds}
                                        trackerOn={trackerOn}
                                        onToggleTracker={() => setTrackerOn((v) => !v)}
                                        dispatch={dispatch}
                                        sourceUrl={sourceUrl}
                                        playerRef={playerRef}
                                    />
                                </div>
                                <div className="relative flex-1 min-h-0 w-full p-4 pt-0">
                                    <div data-editor-preview-shell className="absolute inset-x-4 top-0 bottom-4 flex items-center justify-center">
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
                                </div>
                            </div>

                            {panelOpen && (
                                <div data-editor-tool-panel className="w-[360px] shrink-0 my-3 mr-3 rounded-md border border-edge bg-surface shadow-2xl flex flex-col min-h-0">
                                    <div className="flex items-center justify-between h-10 pl-3 pr-1.5 border-b border-edge shrink-0">
                                        <span className="text-xs font-medium text-fg">
                                            {(TABS.find((t) => t.id === activeTab) || {}).label}
                                        </span>
                                        <button
                                            onClick={() => setPanelOpen(false)}
                                            title="Collapse panel"
                                            aria-label="Collapse panel"
                                            className="p-1 rounded-md text-muted hover:text-fg hover:bg-white/5 transition-colors"
                                        >
                                            <ChevronRight size={15} />
                                        </button>
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {activeTab === 'captions' && (
                                            <CaptionsPanel framing={framing} captions={captions} dispatch={dispatch} onEnhanceCaptions={handleEnhanceCaptions} />
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
                            )}
                        </div>

                        {/* Vertical icon-only rail (far right edge). Clicking the
                            active tool collapses the panel; any other opens it. */}
                        <EditorToolRail
                            tabs={TABS}
                            activeId={panelOpen ? activeTab : null}
                            onSelect={handleToolSelect}
                        />
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
