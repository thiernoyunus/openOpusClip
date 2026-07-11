import React, { useRef, useState } from 'react';
import { Music, Upload, Trash2, Loader2, Repeat } from 'lucide-react';
import { getApiUrl } from '../../config';
import { outputDurationFrames } from '@remotion-src/lib/edl';
import { EDITOR_FPS } from './EditorCanvas';

const MAX_AUDIO = 10;

// Probe an audio URL's natural duration (seconds) via a detached <audio>.
// Resolves 0 on failure so the caller can fall back to a fixed default.
function probeAudioDuration(url) {
    return new Promise((resolve) => {
        const el = document.createElement('audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
        el.onerror = () => resolve(0);
        el.src = url;
    });
}

let _audioSeq = 0;
const newAudioId = () => `audio-${Date.now().toString(36)}-${(_audioSeq++).toString(36)}`;

/**
 * Right-rail Audio tab (B4): upload your own sound effects / music, each stored
 * as a trimmable audio[] block on the timeline's audio lane. "Loop as music"
 * turns an SFX into a looping music bed. "Original audio" ducks the clip's own
 * sound via framing.sourceVolume. Multiple items (up to 10) are supported.
 */
function AudioPanel({ framing, jobId, clipIndex, dispatch, playerRef }) {
    const audio = framing.audio || [];
    const sourceVolume = framing.sourceVolume ?? 1;
    const fileRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(null);

    const onFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (audio.length >= MAX_AUDIO) {
            setError(`Maximum ${MAX_AUDIO} audio items reached.`);
            if (e?.target) e.target.value = '';
            return;
        }
        setUploading(true);
        setError(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await fetch(getApiUrl(`/api/clips/${jobId}/${clipIndex}/asset`), { method: 'POST', body });
            if (!res.ok) {
                let detail = `Upload failed (${res.status})`;
                try {
                    const data = await res.json();
                    if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : detail;
                } catch { /* ignore */ }
                throw new Error(detail);
            }
            const { url } = await res.json();
            // Probe duration off the served file; fall back to 3s if metadata
            // can't be read (some containers omit it).
            const dur = (await probeAudioDuration(getApiUrl(url))) || 3;
            const totalOut = Math.max(1, outputDurationFrames(framing, EDITOR_FPS));
            const startFrame = Math.max(
                0,
                Math.min(Math.round(playerRef?.current?.getCurrentFrame?.() ?? 0), totalOut - 1)
            );
            const endFrame = Math.min(startFrame + Math.round(dur * EDITOR_FPS), totalOut);
            dispatch({
                type: 'ADD_AUDIO',
                item: {
                    id: newAudioId(),
                    role: 'sfx',
                    url,
                    startFrame,
                    endFrame: Math.max(endFrame, startFrame + 1),
                    trimBefore: 0,
                    volume: 0.8,
                    loop: false,
                    fadeInSec: 0,
                    fadeOutSec: 0,
                },
            });
        } catch (err) {
            setError(err.message);
        } finally {
            setUploading(false);
            // Reset the input so re-uploading the same file still fires onChange.
            if (e?.target) e.target.value = '';
        }
    };

    const patch = (id, p) => dispatch({ type: 'UPDATE_AUDIO', id, patch: p });
    const remove = (id) => dispatch({ type: 'REMOVE_AUDIO', id });
    // "Loop as music" makes an item a looping music bed spanning the WHOLE
    // video — without extending the block, a short track would still stop at
    // its own duration (loop only repeats inside the block's span). Toggling
    // back to SFX keeps the current span; trim the block if you want it shorter.
    const toggleMusic = (item) => {
        if (item.role === 'music') {
            patch(item.id, { role: 'sfx', loop: false });
            return;
        }
        const totalOut = Math.max(1, outputDurationFrames(framing, EDITOR_FPS));
        patch(item.id, { role: 'music', loop: true, startFrame: 0, endFrame: totalOut });
    };

    const nameOf = (item) => {
        try {
            return decodeURIComponent((item.url || '').split('/').pop() || 'Audio');
        } catch {
            return (item.url || '').split('/').pop() || 'Audio';
        }
    };

    return (
        <div className="p-3">
            <h3 className="text-[11px] font-semibold text-fg uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Music size={12} /> Audio
            </h3>

            <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || audio.length >= MAX_AUDIO}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-edge bg-surface2/50 text-fg text-xs font-medium hover:bg-white/5 disabled:opacity-50"
            >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {uploading ? 'Uploading…' : 'Upload audio'}
            </button>
            <p className="text-[10px] text-muted mt-2">
                mp3, m4a, wav, aac, or ogg. Added at the playhead.
                {audio.length >= MAX_AUDIO && ' Maximum reached.'}
            </p>

            {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}

            {audio.length > 0 && (
                <div className="mt-3 space-y-3">
                    {audio.map((item) => (
                        <div key={item.id} className="rounded-lg border border-edge bg-surface2/40 p-2.5 space-y-2.5">
                            <div className="flex items-center gap-2 text-xs text-fg">
                                <Music size={13} className={item.role === 'music' ? 'text-viral' : 'text-zinc-400'} />
                                <span className="truncate flex-1">{nameOf(item)}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wide ${item.role === 'music' ? 'bg-viral/15 text-viral' : 'bg-white/5 text-muted'}`}>
                                    {item.role === 'music' ? 'Music' : 'SFX'}
                                </span>
                                <button
                                    onClick={() => remove(item.id)}
                                    className="text-muted hover:text-red-400 p-1"
                                    aria-label="Remove audio"
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>

                            <div>
                                <span className="block text-[11px] text-muted mb-1">
                                    Volume <span className="text-zinc-500 tabular-nums">({Math.round((item.volume ?? 0.8) * 100)}%)</span>
                                </span>
                                <input
                                    type="range" min={0} max={1} step={0.01} value={item.volume ?? 0.8}
                                    onChange={(e) => patch(item.id, { volume: Number(e.target.value) })}
                                    className="w-full accent-white"
                                />
                            </div>

                            <div className="flex gap-2">
                                <label className="flex-1">
                                    <span className="block text-[11px] text-muted mb-1">Fade in (s)</span>
                                    <input
                                        type="number" min={0} max={5} step={0.1} value={item.fadeInSec ?? 0}
                                        onChange={(e) => patch(item.id, { fadeInSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })}
                                        className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1 text-xs text-fg focus:outline-none focus:border-white/30"
                                    />
                                </label>
                                <label className="flex-1">
                                    <span className="block text-[11px] text-muted mb-1">Fade out (s)</span>
                                    <input
                                        type="number" min={0} max={5} step={0.1} value={item.fadeOutSec ?? 0}
                                        onChange={(e) => patch(item.id, { fadeOutSec: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })}
                                        className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1 text-xs text-fg focus:outline-none focus:border-white/30"
                                    />
                                </label>
                            </div>

                            <button
                                onClick={() => toggleMusic(item)}
                                className={`w-full flex items-center justify-center gap-1.5 rounded-lg border text-[11px] font-medium py-1.5 ${item.role === 'music' ? 'border-viral/40 bg-viral/10 text-viral' : 'border-edge bg-surface2/50 text-fg hover:bg-white/5'}`}
                            >
                                <Repeat size={12} />
                                {item.role === 'music' ? 'Looping as music' : 'Loop as music'}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="mt-4 pt-3 border-t border-edge">
                <span className="block text-[11px] text-muted mb-1.5">
                    Original audio <span className="text-zinc-500 tabular-nums">({Math.round(sourceVolume * 100)}%)</span>
                </span>
                <input
                    type="range" min={0} max={1} step={0.01} value={sourceVolume}
                    onChange={(e) => dispatch({ type: 'SET_SOURCE_VOLUME', volume: Number(e.target.value) })}
                    className="w-full accent-white"
                />
            </div>

            <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} className="hidden" />
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(AudioPanel);
