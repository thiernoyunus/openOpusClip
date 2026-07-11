import React, { useRef, useState } from 'react';
import { Clapperboard, Search, Trash2, Loader2, Plus, KeyRound, Sparkles, Upload, Image as ImageIcon } from 'lucide-react';
import { getApiUrl } from '../../config';

const MAX_OVERLAY = 10;

// Extensions the /asset endpoint would classify as audio (mirrors app.py's
// _ASSET_KIND_BY_EXT). Checked client-side BEFORE upload so a correctly-typed
// audio file dropped on the wrong panel never reaches the server — the
// post-upload kind check below is defense-in-depth for anything this misses
// (e.g. an extensionless drag-and-drop), not the primary guard.
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg'];

// Position/size presets (normalized 0-1 canvas coords) offered per overlay.
const POSITION_PRESETS = [
    { id: 'full', label: 'Full', x: 0.5, y: 0.5, w: 1, h: 1 },
    { id: 'top', label: 'Top half', x: 0.5, y: 0.25, w: 1, h: 0.5 },
    { id: 'pip', label: 'PiP corner', x: 0.78, y: 0.18, w: 0.4, h: 0.3 },
];

// Pick a reasonable HD portrait video file from a Pexels video result.
const pickPexelsFile = (video) =>
    video.video_files.find((f) => f.quality === 'hd' && f.height >= f.width) ||
    video.video_files.find((f) => f.height >= f.width) ||
    video.video_files[0];

// Probe a video URL's natural duration (seconds) via a detached <video>.
// Resolves 0 on failure so the caller can fall back to a fixed default.
function probeVideoDuration(url) {
    return new Promise((resolve) => {
        const el = document.createElement('video');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
        el.onerror = () => resolve(0);
        el.src = url;
    });
}

async function readErrorMessage(res, fallback) {
    try {
        const data = await res.json();
        if (data?.detail) {
            return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        }
    } catch {
        /* ignore */
    }
    return fallback;
}

let _ovSeq = 0;
const newOverlayId = () => `ov-${Date.now().toString(36)}-${(_ovSeq++).toString(36)}`;

/**
 * Right-rail B-Roll tab (B4): upload your own b-roll video or images first,
 * placed on the overlays[] track. Pexels stock search stays below upload.
 */
function BrollPanel({ framing, dispatch, jobId, clipIndex, getCurrentSourceFrame, captions = [] }) {
    const overlays = framing.overlays || [];
    const srcFps = framing.source.fps;
    const srcDuration = framing.source.durationFrames;
    const fileRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState(null);
    const [key, setKey] = useState(() => localStorage.getItem('pexels_key') || '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState(null);

    const atCap = overlays.length >= MAX_OVERLAY;

    const saveKey = (v) => {
        setKey(v);
        localStorage.setItem('pexels_key', v);
    };

    // Capture startFrame at call time so async uploads don't race the playhead.
    const addOverlay = (kind, url, startFrame, endFrame) => {
        const start = Math.max(0, Math.min(startFrame, Math.max(0, srcDuration - 1)));
        const end = Math.max(start + 1, Math.min(endFrame, srcDuration));
        dispatch({
            type: 'ADD_OVERLAY',
            item: {
                id: newOverlayId(),
                kind,
                url,
                startFrame: start,
                endFrame: end,
                anchor: 'source',
                x: 0.5, y: 0.5, w: 1, h: 1,
                volume: 0,
                z: 0,
            },
        });
    };

    const onFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!jobId && jobId !== 0) {
            setUploadError('No project open — open a clip in the editor first.');
            if (e?.target) e.target.value = '';
            return;
        }
        if (atCap) {
            setUploadError(`Maximum ${MAX_OVERLAY} b-roll items reached.`);
            if (e?.target) e.target.value = '';
            return;
        }
        // Reject an audio file before it's ever uploaded — the picker's
        // accept="video/*,image/*" isn't enforced by every browser (or a
        // scripted client), and letting it reach the server would store the
        // file on disk with no way to clean it back up once rejected.
        const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        if (AUDIO_EXTENSIONS.includes(ext)) {
            setUploadError('That looks like an audio file — upload it from the Audio panel instead.');
            if (e?.target) e.target.value = '';
            return;
        }
        setUploading(true);
        setUploadError(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await fetch(getApiUrl(`/api/clips/${jobId}/${clipIndex}/asset`), { method: 'POST', body });
            if (!res.ok) {
                throw new Error(await readErrorMessage(res, `Upload failed (${res.status})`));
            }
            const { url, kind } = await res.json();
            // Defense-in-depth: the extension check above catches the common
            // case before upload; this catches anything that check missed
            // (e.g. an extensionless file the server still classified as
            // audio) so overlays[] can never end up with an invalid kind.
            // ponytail: this rare case still orphans the uploaded file on disk
            // (no delete-asset endpoint exists) — add one if it shows up in practice.
            if (kind !== 'video' && kind !== 'image') {
                setUploadError(kind === 'audio'
                    ? 'That file is audio — upload it from the Audio panel instead.'
                    : `Unsupported file type: ${kind || 'unknown'}.`);
                return;
            }
            // Read playhead AFTER the network work so the block lands where you are now.
            const start = getCurrentSourceFrame();
            let endFrame;
            if (kind === 'video') {
                const dur = (await probeVideoDuration(getApiUrl(url))) || 4;
                endFrame = start + Math.round(dur * srcFps);
            } else {
                endFrame = start + Math.round(4 * srcFps); // images: default 4s on screen
            }
            addOverlay(kind, url, start, endFrame);
        } catch (err) {
            setUploadError(err.message || 'Upload failed');
        } finally {
            setUploading(false);
            if (e?.target) e.target.value = '';
        }
    };

    const searchPexels = async (q, perPage = 12) => {
        const res = await fetch(
            `https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=${perPage}`,
            { headers: { Authorization: key } }
        );
        if (!res.ok) throw new Error(`Pexels error (${res.status})`);
        const data = await res.json();
        return data.videos || [];
    };

    const search = async () => {
        if (!key || !query.trim()) return;
        setLoading(true);
        setError(null);
        try {
            setResults(await searchPexels(query));
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const insert = (video) => {
        if (atCap) return;
        if (!video.video_files || video.video_files.length === 0) {
            setError('No video files found for this selection.');
            return;
        }
        const file = pickPexelsFile(video);
        const start = getCurrentSourceFrame();
        addOverlay('video', file.link, start, start + Math.round(4 * srcFps));
    };

    const autoAdd = async () => {
        if (captions.length === 0 || !key || atCap) return;
        const geminiKey = localStorage.getItem('gemini_key');
        if (!geminiKey) {
            setAiError('Set your Gemini API key in Settings');
            return;
        }
        setAiLoading(true);
        setAiError(null);
        try {
            const res = await fetch(getApiUrl('/api/broll/suggest'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': geminiKey },
                body: JSON.stringify({ words: captions.map((w) => ({ text: w.text, startMs: w.startMs })) }),
            });
            if (!res.ok) throw new Error(await readErrorMessage(res, `Suggestion failed (${res.status})`));
            const { suggestions = [] } = await res.json();
            if (suggestions.length === 0) {
                setAiError('No b-roll suggestions for this clip');
                return;
            }

            const captionsOrigin = framing.captionsOriginFrame ?? 0;
            let added = overlays.length;
            let inserted = 0;

            const MIN_BROLL_FRAMES = 10;
            for (const s of suggestions) {
                if (added >= MAX_OVERLAY) break;
                const startFrame = captionsOrigin + Math.round((s.startMs / 1000) * srcFps);
                const endFrame = Math.min(startFrame + Math.round((s.durationMs / 1000) * srcFps), srcDuration);
                if (startFrame < 0 || startFrame >= srcDuration || endFrame - startFrame < MIN_BROLL_FRAMES) {
                    continue;
                }
                let videos;
                try {
                    videos = await searchPexels(s.keyword, 5);
                } catch {
                    continue;
                }
                if (!videos.length) continue;
                const file = pickPexelsFile(videos[0]);
                if (!file) continue;
                dispatch({
                    type: 'ADD_OVERLAY',
                    item: {
                        id: newOverlayId(),
                        kind: 'video',
                        url: file.link,
                        startFrame,
                        endFrame,
                        anchor: 'source',
                        x: 0.5, y: 0.5, w: 1, h: 1,
                        volume: 0,
                        z: 0,
                    },
                });
                added += 1;
                inserted += 1;
            }

            if (inserted === 0) setAiError('No matching stock clips found');
        } catch (e) {
            setAiError(e.message);
        } finally {
            setAiLoading(false);
        }
    };

    const fmt = (f) => `${(f / srcFps).toFixed(1)}s`;
    const presetActive = (o, p) =>
        Math.abs(o.x - p.x) < 0.01 && Math.abs(o.y - p.y) < 0.01 &&
        Math.abs(o.w - p.w) < 0.01 && Math.abs(o.h - p.h) < 0.01;

    return (
        <div className="p-3">
            <h3 className="text-[11px] font-semibold text-fg uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Clapperboard size={12} /> B-Roll
            </h3>

            <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading || atCap}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-edge bg-surface2/60 text-fg text-xs font-medium hover:bg-white/5 disabled:opacity-50 shadow-sm"
            >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {uploading ? 'Uploading…' : 'Upload b-roll'}
            </button>
            <p className="text-[10px] text-muted mt-2">
                Your own video or image, added at the playhead.{atCap && ' Maximum reached.'}
            </p>
            {uploadError && <p className="text-[11px] text-red-400 mt-2">{uploadError}</p>}

            {overlays.length > 0 && (
                <div className="mt-3 space-y-2">
                    {overlays.map((o) => (
                        <div key={o.id} className="rounded-xl border border-edge bg-surface2/40 p-2.5 space-y-2">
                            <div className="flex items-center gap-2 text-[11px] text-fg">
                                {o.kind === 'image' ? <ImageIcon size={12} /> : <Clapperboard size={12} />}
                                <span className="flex-1 truncate text-muted">{fmt(o.startFrame)} → {fmt(o.endFrame)}</span>
                                <button type="button" onClick={() => dispatch({ type: 'REMOVE_OVERLAY', id: o.id })} className="text-muted hover:text-red-400 p-0.5" aria-label="Remove b-roll">
                                    <Trash2 size={12} />
                                </button>
                            </div>
                            <div className="flex gap-1">
                                {POSITION_PRESETS.map((p) => (
                                    <button
                                        type="button"
                                        key={p.id}
                                        onClick={() => dispatch({ type: 'UPDATE_OVERLAY', id: o.id, patch: { x: p.x, y: p.y, w: p.w, h: p.h } })}
                                        className={`flex-1 rounded-lg px-1.5 py-1 text-[10px] border ${presetActive(o, p) ? 'border-viral/40 bg-viral/10 text-viral' : 'border-edge bg-surface2/50 text-muted hover:bg-white/5'}`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="mt-4 pt-3 border-t border-edge">
                <p className="text-[10px] text-muted uppercase tracking-wide mb-2">Stock video (Pexels)</p>
                {!key ? (
                    <>
                        <div className="flex items-start gap-1.5 text-[11px] text-muted mb-2">
                            <KeyRound size={12} className="mt-0.5 shrink-0" />
                            Optional free Pexels key for stock video. Get one at pexels.com/api.
                        </div>
                        <input
                            type="password"
                            placeholder="Pexels API key"
                            onChange={(e) => saveKey(e.target.value.trim())}
                            className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30"
                        />
                    </>
                ) : (
                    <>
                        <div className="flex gap-1.5 mb-2">
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && search()}
                                placeholder="Search stock video…"
                                className="flex-1 min-w-0 bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30"
                            />
                            <button type="button" onClick={search} className="px-2.5 rounded-lg bg-surface2 border border-edge text-fg hover:bg-white/5">
                                {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                            </button>
                        </div>

                        <button
                            type="button"
                            onClick={autoAdd}
                            disabled={aiLoading || captions.length === 0 || atCap}
                            title={
                                captions.length === 0
                                    ? 'Captions are needed for AI b-roll'
                                    : atCap
                                        ? `Maximum ${MAX_OVERLAY} b-roll clips reached`
                                        : 'Let AI analyze the transcript and place contextual b-roll'
                            }
                            className="w-full mb-2 flex items-center justify-center gap-1.5 rounded-lg bg-surface2 border border-edge text-xs font-medium text-fg py-1.5 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            {aiLoading ? 'Analyzing transcript…' : 'Auto-add AI B-Roll'}
                        </button>

                        {captions.length === 0 && (
                            <p className="text-[11px] text-muted mb-2">Captions are needed for AI b-roll auto-placement.</p>
                        )}
                        {aiError && <p className="text-[11px] text-red-400 mb-2">{aiError}</p>}
                        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

                        <div className="grid grid-cols-2 gap-1.5">
                            {results.map((v) => (
                                <button
                                    type="button"
                                    key={v.id}
                                    onClick={() => insert(v)}
                                    disabled={atCap}
                                    className="relative aspect-[9/16] rounded-md overflow-hidden border border-edge group disabled:opacity-40"
                                >
                                    <img src={v.image} alt="" className="w-full h-full object-cover" />
                                    <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                                        <Plus size={18} className="text-white" />
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>
                )}
            </div>

            <input ref={fileRef} type="file" accept="video/*,image/*" onChange={onFile} className="hidden" />
        </div>
    );
}

export default React.memo(BrollPanel);
