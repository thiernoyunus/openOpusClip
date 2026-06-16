import React, { useRef, useState } from 'react';
import { Music, Upload, Trash2, Loader2 } from 'lucide-react';
import { getApiUrl } from '../../config';

/**
 * Right-rail Audio tab: upload a background music track (stored in the job
 * dir), set its volume and how much the original clip audio is ducked. Config
 * lives at framing.music and is mixed in by the composition + export.
 */
function AudioPanel({ framing, jobId, clipIndex, dispatch }) {
    const music = framing.music || null;
    const fileRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState(null);

    const onFile = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setUploading(true);
        setError(null);
        try {
            const body = new FormData();
            body.append('file', file);
            const res = await fetch(getApiUrl(`/api/clips/${jobId}/${clipIndex}/audio`), { method: 'POST', body });
            if (!res.ok) throw new Error(`Upload failed (${res.status})`);
            const { url } = await res.json();
            dispatch({ type: 'SET_MUSIC', music: { url, volume: 0.15, originalVolume: 1 } });
        } catch (err) {
            setError(err.message);
        } finally {
            setUploading(false);
            // Reset the input so re-uploading the same file after removing it
            // still fires onChange.
            if (e?.target) e.target.value = '';
        }
    };

    const setVol = (patch) => dispatch({ type: 'SET_MUSIC', music: { ...music, ...patch } });

    return (
        <div className="p-4">
            <h3 className="text-xs font-semibold text-fg uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Music size={13} /> Audio
            </h3>

            {!music ? (
                <>
                    <button
                        onClick={() => fileRef.current?.click()}
                        disabled={uploading}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-edge bg-surface2/50 text-fg text-xs font-medium hover:bg-white/5 disabled:opacity-50"
                    >
                        {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                        {uploading ? 'Uploading…' : 'Upload music'}
                    </button>
                    <p className="text-[10px] text-muted mt-2">mp3, m4a, wav, or ogg.</p>
                </>
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs text-fg">
                        <Music size={13} className="text-viral" />
                        <span className="truncate flex-1">{music.url.split('/').pop()}</span>
                        <button
                            onClick={() => dispatch({ type: 'SET_MUSIC', music: null })}
                            className="text-muted hover:text-red-400 p-1"
                            aria-label="Remove music"
                        >
                            <Trash2 size={13} />
                        </button>
                    </div>
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">
                            Music volume <span className="text-zinc-500 tabular-nums">({Math.round(music.volume * 100)}%)</span>
                        </span>
                        <input type="range" min={0} max={1} step={0.01} value={music.volume}
                            onChange={(e) => setVol({ volume: Number(e.target.value) })} className="w-full accent-white" />
                    </div>
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">
                            Original audio <span className="text-zinc-500 tabular-nums">({Math.round(music.originalVolume * 100)}%)</span>
                        </span>
                        <input type="range" min={0} max={1} step={0.01} value={music.originalVolume}
                            onChange={(e) => setVol({ originalVolume: Number(e.target.value) })} className="w-full accent-white" />
                    </div>
                </div>
            )}

            {error && <p className="text-[11px] text-red-400 mt-2">{error}</p>}
            <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} className="hidden" />
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(AudioPanel);
