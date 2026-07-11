import React, { useRef, useState } from 'react';
import {
    Upload, Loader2, Trash2, Search, Plus, KeyRound, Sparkles, Repeat,
    Image as ImageIcon, Clapperboard, Music, ChevronLeft,
} from 'lucide-react';
import { getApiUrl } from '../../config';
import { outputDurationFrames } from '@remotion-src/lib/edl';
import { EDITOR_FPS } from './EditorCanvas';

const MAX_OVERLAY = 10;
const MAX_AUDIO = 10;

// Mirrors app.py's _ASSET_KIND_BY_EXT — used to guess a file's track BEFORE
// upload so a capped track rejects it without the server writing an orphaned
// file to disk (there's no delete-asset endpoint to clean it up).
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.aac', '.ogg'];

// Position/size presets (normalized 0-1 canvas coords) offered per overlay.
const POSITION_PRESETS = [
    { id: 'full', label: 'Full', x: 0.5, y: 0.5, w: 1, h: 1 },
    { id: 'top', label: 'Top half', x: 0.5, y: 0.25, w: 1, h: 0.5 },
    { id: 'pip', label: 'PiP corner', x: 0.78, y: 0.18, w: 0.4, h: 0.3 },
];

const pickPexelsFile = (video) =>
    video.video_files.find((f) => f.quality === 'hd' && f.height >= f.width) ||
    video.video_files.find((f) => f.height >= f.width) ||
    video.video_files[0];

function probeMediaDuration(tag, url) {
    return new Promise((resolve) => {
        const el = document.createElement(tag);
        el.preload = 'metadata';
        // Time out so a stalled/CORS-blocked file (no load or error event) can't
        // hang the promise and leave the panel stuck on "Uploading…".
        const done = (v) => { clearTimeout(timer); resolve(v); };
        const timer = setTimeout(() => done(0), 5000);
        el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : 0);
        el.onerror = () => done(0);
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

// Module-scope so it's a stable component (not re-created each render).
const AssetIcon = ({ kind, ...props }) => {
    const Cmp = kind === 'audio' ? Music : kind === 'image' ? ImageIcon : Clapperboard;
    return <Cmp {...props} />;
};

let _seq = 0;
const newId = (p) => `${p}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

const nameOf = (url) => {
    try {
        return decodeURIComponent((url || '').split('/').pop() || 'Asset');
    } catch {
        return (url || '').split('/').pop() || 'Asset';
    }
};

const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'image', label: 'Images' },
    { id: 'video', label: 'Videos' },
    { id: 'audio', label: 'Audio' },
];

/**
 * Unified Media panel (merges the old B-Roll + Audio tabs). One library lists
 * every uploaded asset — images/video live on framing.overlays[], audio on
 * framing.audio[] — behind All/Images/Videos/Audio filters. Selecting an asset
 * swaps the panel to that asset's own controls (placement for visual overlays,
 * volume/fade/loop for audio). Upload accepts any type: the /asset endpoint
 * classifies it and we route to the matching track. Pexels stock video + AI
 * b-roll and the original-audio mixer live under the library.
 */
function MediaPanel({ framing, dispatch, jobId, clipIndex, getCurrentSourceFrame, captions = [], playerRef }) {
    const overlays = framing.overlays || [];
    const audio = framing.audio || [];
    const srcFps = framing.source.fps;
    const srcDuration = framing.source.durationFrames;
    const sourceVolume = framing.sourceVolume ?? 1;

    const fileRef = useRef(null);
    const [selected, setSelected] = useState(null); // { track: 'overlay'|'audio', id }
    const [filter, setFilter] = useState('all');
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState(null);

    // Pexels stock + AI b-roll (video only)
    const [key, setKey] = useState(() => localStorage.getItem('pexels_key') || '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState(null);

    const overlaysAtCap = overlays.length >= MAX_OVERLAY;
    const audioAtCap = audio.length >= MAX_AUDIO;

    const saveKey = (v) => {
        setKey(v);
        localStorage.setItem('pexels_key', v);
    };

    const addOverlay = (kind, url, startFrame, endFrame) => {
        const start = Math.max(0, Math.min(startFrame, Math.max(0, srcDuration - 1)));
        const end = Math.max(start + 1, Math.min(endFrame, srcDuration));
        const id = newId('ov');
        dispatch({
            type: 'ADD_OVERLAY',
            item: { id, kind, url, startFrame: start, endFrame: end, anchor: 'source', x: 0.5, y: 0.5, w: 1, h: 1, volume: 0, z: 0 },
        });
        return id;
    };

    const addAudio = (url, dur) => {
        const totalOut = Math.max(1, outputDurationFrames(framing, EDITOR_FPS));
        const startFrame = Math.max(0, Math.min(Math.round(playerRef?.current?.getCurrentFrame?.() ?? 0), totalOut - 1));
        const endFrame = Math.min(startFrame + Math.round(dur * EDITOR_FPS), totalOut);
        const id = newId('audio');
        dispatch({
            type: 'ADD_AUDIO',
            item: { id, role: 'sfx', url, startFrame, endFrame: Math.max(endFrame, startFrame + 1), trimBefore: 0, volume: 0.8, loop: false, fadeInSec: 0, fadeOutSec: 0 },
        });
        return id;
    };

    // Single upload for any asset — the server classifies it and we route by kind.
    const uploadFile = async (file) => {
        if (!file) return;
        if (!jobId && jobId !== 0) {
            setUploadError('No project open — open a clip in the editor first.');
            return;
        }
        // Guess the track by extension and reject a full one BEFORE uploading —
        // the /asset endpoint writes accepted files to disk with no cleanup path,
        // so a post-upload cap check would orphan the file. The server-side kind
        // check below stays as defense-in-depth for extensionless/misnamed files.
        const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
        const looksAudio = AUDIO_EXTENSIONS.includes(ext);
        if (looksAudio && audioAtCap) {
            setUploadError(`Maximum ${MAX_AUDIO} audio items reached.`);
            return;
        }
        if (!looksAudio && ext && overlaysAtCap) {
            setUploadError(`Maximum ${MAX_OVERLAY} visual items reached.`);
            return;
        }
        if (audioAtCap && overlaysAtCap) {
            setUploadError('Media limit reached — remove an item first.');
            return;
        }
        setUploading(true);
        setUploadError(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await fetch(getApiUrl(`/api/clips/${jobId}/${clipIndex}/asset`), { method: 'POST', body });
            if (!res.ok) throw new Error(await readErrorMessage(res, `Upload failed (${res.status})`));
            const { url, kind } = await res.json();

            if (kind === 'audio') {
                if (audioAtCap) { setUploadError(`Maximum ${MAX_AUDIO} audio items reached.`); return; }
                const dur = (await probeMediaDuration('audio', getApiUrl(url))) || 3;
                setSelected({ track: 'audio', id: addAudio(url, dur) });
            } else if (kind === 'video' || kind === 'image') {
                if (overlaysAtCap) { setUploadError(`Maximum ${MAX_OVERLAY} visual items reached.`); return; }
                const start = getCurrentSourceFrame();
                const dur = kind === 'video' ? (await probeMediaDuration('video', getApiUrl(url))) || 4 : 4;
                setSelected({ track: 'overlay', id: addOverlay(kind, url, start, start + Math.round(dur * srcFps)) });
            } else {
                setUploadError(`Unsupported file type: ${kind || 'unknown'}.`);
            }
        } catch (err) {
            setUploadError(err.message || 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const onFile = async (e) => {
        await uploadFile(e.target.files?.[0]);
        if (e?.target) e.target.value = '';
    };

    const onDrop = async (e) => {
        // stopPropagation too, so a bubbled drop can't make the browser navigate
        // to / open the dropped file.
        e.preventDefault();
        e.stopPropagation();
        await uploadFile(e.dataTransfer?.files?.[0]);
    };

    // --- Pexels stock video (unchanged behavior from the old B-Roll panel) ---
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
        if (overlaysAtCap) return;
        if (!video.video_files || video.video_files.length === 0) {
            setError('No video files found for this selection.');
            return;
        }
        const file = pickPexelsFile(video);
        const start = getCurrentSourceFrame();
        addOverlay('video', file.link, start, start + Math.round(4 * srcFps));
    };

    const autoAdd = async () => {
        if (captions.length === 0 || !key || overlaysAtCap) return;
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
            if (suggestions.length === 0) { setAiError('No b-roll suggestions for this clip'); return; }

            const captionsOrigin = framing.captionsOriginFrame ?? 0;
            let added = overlays.length;
            let inserted = 0;
            const MIN_BROLL_FRAMES = 10;
            for (const s of suggestions) {
                if (added >= MAX_OVERLAY) break;
                const startFrame = captionsOrigin + Math.round((s.startMs / 1000) * srcFps);
                const endFrame = Math.min(startFrame + Math.round((s.durationMs / 1000) * srcFps), srcDuration);
                if (startFrame < 0 || startFrame >= srcDuration || endFrame - startFrame < MIN_BROLL_FRAMES) continue;
                let videos;
                try {
                    videos = await searchPexels(s.keyword, 5);
                } catch {
                    continue;
                }
                if (!videos.length) continue;
                const file = pickPexelsFile(videos[0]);
                if (!file) continue;
                addOverlay('video', file.link, startFrame, endFrame);
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

    // Unified, filterable asset list. overlays carry kind video|image; audio is
    // its own track — normalize both into one shape for the grid.
    const assets = [
        ...overlays.map((o) => ({ track: 'overlay', id: o.id, kind: o.kind, name: nameOf(o.url), sub: `${fmt(o.startFrame)} → ${fmt(o.endFrame)}`, item: o })),
        ...audio.map((a) => ({ track: 'audio', id: a.id, kind: 'audio', name: nameOf(a.url), sub: a.role === 'music' ? 'Music' : 'SFX', item: a })),
    ];
    const visible = filter === 'all' ? assets : assets.filter((a) => a.kind === filter);

    // --- Inspector: the selected asset's own controls (swap-panel) ---
    const selectedAsset = selected && assets.find((a) => a.track === selected.track && a.id === selected.id);
    if (selected && !selectedAsset) {
        // The asset was removed elsewhere — fall back to the library.
        setSelected(null);
    }

    if (selectedAsset) {
        const { item, track, kind } = selectedAsset;
        const back = () => setSelected(null);
        const remove = () => {
            dispatch(track === 'audio' ? { type: 'REMOVE_AUDIO', id: item.id } : { type: 'REMOVE_OVERLAY', id: item.id });
            setSelected(null);
        };
        return (
            <div className="p-3">
                <button type="button" onClick={back} className="flex items-center gap-1 text-[11px] text-muted hover:text-fg mb-3">
                    <ChevronLeft size={13} /> Media library
                </button>
                <div className="flex items-center gap-2 mb-3">
                    <AssetIcon kind={kind} size={14} className="text-viral" />
                    <span className="flex-1 truncate text-xs text-fg">{selectedAsset.name}</span>
                    <button type="button" onClick={remove} className="text-muted hover:text-red-400 p-1" aria-label="Remove asset">
                        <Trash2 size={13} />
                    </button>
                </div>

                {track === 'overlay' ? (
                    <div className="space-y-3">
                        <div>
                            <span className="block text-[11px] text-muted mb-1.5">Placement</span>
                            <div className="flex gap-1">
                                {POSITION_PRESETS.map((p) => (
                                    <button
                                        type="button"
                                        key={p.id}
                                        onClick={() => dispatch({ type: 'UPDATE_OVERLAY', id: item.id, patch: { x: p.x, y: p.y, w: p.w, h: p.h } })}
                                        className={`flex-1 rounded-lg px-1.5 py-1.5 text-[10px] border ${presetActive(item, p) ? 'border-viral/40 bg-viral/10 text-viral' : 'border-edge bg-surface2/50 text-muted hover:bg-white/5'}`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <p className="text-[11px] text-muted">On screen {fmt(item.startFrame)} → {fmt(item.endFrame)}. Drag its block on the timeline to move or trim it.</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div>
                            <span className="block text-[11px] text-muted mb-1">
                                Volume <span className="text-zinc-500 tabular-nums">({Math.round((item.volume ?? 0.8) * 100)}%)</span>
                            </span>
                            <input type="range" min={0} max={1} step={0.01} value={item.volume ?? 0.8}
                                onChange={(e) => dispatch({ type: 'UPDATE_AUDIO', id: item.id, patch: { volume: Number(e.target.value) } })}
                                className="w-full accent-white" />
                        </div>
                        <div className="flex gap-2">
                            <label className="flex-1">
                                <span className="block text-[11px] text-muted mb-1">Fade in (s)</span>
                                <input type="number" min={0} max={5} step={0.1} value={item.fadeInSec ?? 0}
                                    onChange={(e) => dispatch({ type: 'UPDATE_AUDIO', id: item.id, patch: { fadeInSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } })}
                                    className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1 text-xs text-fg focus:outline-none focus:border-white/30" />
                            </label>
                            <label className="flex-1">
                                <span className="block text-[11px] text-muted mb-1">Fade out (s)</span>
                                <input type="number" min={0} max={5} step={0.1} value={item.fadeOutSec ?? 0}
                                    onChange={(e) => dispatch({ type: 'UPDATE_AUDIO', id: item.id, patch: { fadeOutSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)) } })}
                                    className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1 text-xs text-fg focus:outline-none focus:border-white/30" />
                            </label>
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                if (item.role === 'music') {
                                    dispatch({ type: 'UPDATE_AUDIO', id: item.id, patch: { role: 'sfx', loop: false } });
                                } else {
                                    const totalOut = Math.max(1, outputDurationFrames(framing, EDITOR_FPS));
                                    dispatch({ type: 'UPDATE_AUDIO', id: item.id, patch: { role: 'music', loop: true, startFrame: 0, endFrame: totalOut } });
                                }
                            }}
                            className={`w-full flex items-center justify-center gap-1.5 rounded-lg border text-[11px] font-medium py-1.5 ${item.role === 'music' ? 'border-viral/40 bg-viral/10 text-viral' : 'border-edge bg-surface2/50 text-fg hover:bg-white/5'}`}
                        >
                            <Repeat size={12} />
                            {item.role === 'music' ? 'Looping as music' : 'Loop as music'}
                        </button>
                    </div>
                )}
            </div>
        );
    }

    // --- Library view ---
    return (
        <div className="p-3">
            <div
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); // Space would otherwise scroll the panel
                        fileRef.current?.click();
                    }
                }}
                className="w-full flex flex-col items-center justify-center gap-1.5 px-3 py-5 rounded-xl border border-dashed border-edge bg-surface2/40 text-muted hover:bg-white/5 cursor-pointer"
            >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                <span className="text-xs font-medium text-fg">{uploading ? 'Uploading…' : 'Drag files here or click to upload'}</span>
                <span className="text-[10px]">Image, video, or audio — added at the playhead</span>
            </div>
            {uploadError && <p className="text-[11px] text-red-400 mt-2">{uploadError}</p>}

            {/* Filter tabs */}
            <div className="mt-3 flex gap-1">
                {FILTERS.map((f) => (
                    <button
                        type="button"
                        key={f.id}
                        onClick={() => setFilter(f.id)}
                        className={`flex-1 rounded-lg px-1.5 py-1 text-[10px] border ${filter === f.id ? 'border-white/25 bg-white/10 text-fg' : 'border-edge bg-surface2/40 text-muted hover:bg-white/5'}`}
                    >
                        {f.label}
                    </button>
                ))}
            </div>

            {/* Asset grid */}
            {visible.length === 0 ? (
                <p className="text-[11px] text-muted mt-3 text-center py-4">
                    {assets.length === 0 ? 'No media yet — upload above to get started.' : 'Nothing in this filter.'}
                </p>
            ) : (
                <div className="mt-3 grid grid-cols-2 gap-2">
                    {visible.map((a) => (
                        <button
                            type="button"
                            key={`${a.track}-${a.id}`}
                            onClick={() => setSelected({ track: a.track, id: a.id })}
                            className="text-left rounded-xl border border-edge bg-surface2/40 p-2 hover:bg-white/5 hover:border-white/20"
                        >
                            <div className="aspect-video rounded-lg bg-black/40 flex items-center justify-center mb-1.5">
                                <AssetIcon kind={a.kind} size={18} className="text-zinc-400" />
                            </div>
                            <p className="text-[11px] text-fg truncate">{a.name}</p>
                            <p className="text-[9px] text-muted">{a.sub}</p>
                        </button>
                    ))}
                </div>
            )}

            {/* Original audio mixer (global) */}
            <div className="mt-4 pt-3 border-t border-edge">
                <span className="block text-[11px] text-muted mb-1.5">
                    Original audio <span className="text-zinc-500 tabular-nums">({Math.round(sourceVolume * 100)}%)</span>
                </span>
                <input type="range" min={0} max={1} step={0.01} value={sourceVolume}
                    onChange={(e) => dispatch({ type: 'SET_SOURCE_VOLUME', volume: Number(e.target.value) })}
                    className="w-full accent-white" />
            </div>

            {/* Stock video (Pexels) + AI b-roll */}
            <div className="mt-4 pt-3 border-t border-edge">
                <p className="text-[10px] text-muted uppercase tracking-wide mb-2">Stock video (Pexels)</p>
                {!key ? (
                    <>
                        <div className="flex items-start gap-1.5 text-[11px] text-muted mb-2">
                            <KeyRound size={12} className="mt-0.5 shrink-0" />
                            Optional free Pexels key for stock video. Get one at pexels.com/api.
                        </div>
                        <input type="password" placeholder="Pexels API key" onChange={(e) => saveKey(e.target.value.trim())}
                            className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30" />
                    </>
                ) : (
                    <>
                        <div className="flex gap-1.5 mb-2">
                            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()}
                                placeholder="Search stock video…"
                                className="flex-1 min-w-0 bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30" />
                            <button type="button" onClick={search} className="px-2.5 rounded-lg bg-surface2 border border-edge text-fg hover:bg-white/5">
                                {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                            </button>
                        </div>
                        <button type="button" onClick={autoAdd} disabled={aiLoading || captions.length === 0 || overlaysAtCap}
                            title={captions.length === 0 ? 'Captions are needed for AI b-roll' : overlaysAtCap ? `Maximum ${MAX_OVERLAY} visual clips reached` : 'Let AI analyze the transcript and place contextual b-roll'}
                            className="w-full mb-2 flex items-center justify-center gap-1.5 rounded-lg bg-surface2 border border-edge text-xs font-medium text-fg py-1.5 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed">
                            {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                            {aiLoading ? 'Analyzing transcript…' : 'Auto-add AI B-Roll'}
                        </button>
                        {captions.length === 0 && <p className="text-[11px] text-muted mb-2">Captions are needed for AI b-roll auto-placement.</p>}
                        {aiError && <p className="text-[11px] text-red-400 mb-2">{aiError}</p>}
                        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
                        <div className="grid grid-cols-2 gap-1.5">
                            {results.map((v) => (
                                <button type="button" key={v.id} onClick={() => insert(v)} disabled={overlaysAtCap}
                                    className="relative aspect-[9/16] rounded-md overflow-hidden border border-edge group disabled:opacity-40">
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

            <input ref={fileRef} type="file" accept="video/*,image/*,audio/*" onChange={onFile} className="hidden" />
        </div>
    );
}

export default React.memo(MediaPanel);
