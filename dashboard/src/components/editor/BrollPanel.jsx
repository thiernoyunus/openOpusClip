import React, { useState } from 'react';
import { Clapperboard, Search, Trash2, Loader2, Plus, KeyRound } from 'lucide-react';

/**
 * Right-rail B-Roll tab: search Pexels for portrait stock video and insert a
 * 4s clip at the playhead (max 3). The Pexels key lives in localStorage; the
 * search runs client-side. Inserts store SOURCE-frame spans (EDL-mapped).
 */
function BrollPanel({ framing, dispatch, getCurrentSourceFrame }) {
    const broll = framing.broll || [];
    const srcFps = framing.source.fps;
    const [key, setKey] = useState(() => localStorage.getItem('pexels_key') || '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const saveKey = (v) => {
        setKey(v);
        localStorage.setItem('pexels_key', v);
    };

    const search = async () => {
        if (!key || !query.trim()) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(
                `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=12`,
                { headers: { Authorization: key } }
            );
            if (!res.ok) throw new Error(`Pexels error (${res.status})`);
            const data = await res.json();
            setResults(data.videos || []);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const insert = (video) => {
        if (broll.length >= 3) return;
        // pick a reasonable HD portrait file
        const file =
            video.video_files.find((f) => f.quality === 'hd' && f.height >= f.width) ||
            video.video_files.find((f) => f.height >= f.width) ||
            video.video_files[0];
        const start = getCurrentSourceFrame();
        const end = Math.min(
            start + Math.round(4 * srcFps),
            framing.clipOutFrame ?? framing.source.durationFrames
        );
        dispatch({ type: 'ADD_BROLL', item: { id: `broll-${video.id}-${start}`, url: file.link, startFrame: start, endFrame: end } });
    };

    const fmt = (f) => `${((f - (framing.clipInFrame ?? 0)) / srcFps).toFixed(1)}s`;

    if (!key) {
        return (
            <div className="p-4">
                <h3 className="text-xs font-semibold text-fg uppercase tracking-wide mb-3 flex items-center gap-1.5">
                    <Clapperboard size={13} /> B-Roll
                </h3>
                <div className="flex items-start gap-1.5 text-[11px] text-muted mb-3">
                    <KeyRound size={12} className="mt-0.5 shrink-0" />
                    Add a free Pexels API key to search stock video. Get one at pexels.com/api.
                </div>
                <input
                    type="password"
                    placeholder="Pexels API key"
                    onChange={(e) => saveKey(e.target.value.trim())}
                    className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30"
                />
            </div>
        );
    }

    return (
        <div className="p-4">
            <h3 className="text-xs font-semibold text-fg uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Clapperboard size={13} /> B-Roll
            </h3>

            <div className="flex gap-1.5 mb-3">
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && search()}
                    placeholder="Search stock video…"
                    className="flex-1 min-w-0 bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30"
                />
                <button onClick={search} className="px-2.5 rounded-lg bg-surface2 border border-edge text-fg hover:bg-white/5">
                    {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                </button>
            </div>

            {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

            {broll.length > 0 && (
                <div className="mb-3 space-y-1">
                    {broll.map((b) => (
                        <div key={b.id} className="flex items-center gap-2 text-[11px] text-muted bg-surface2/40 border border-edge rounded px-2 py-1">
                            <Clapperboard size={11} />
                            <span className="flex-1 truncate">{fmt(b.startFrame)} → {fmt(b.endFrame)}</span>
                            <button onClick={() => dispatch({ type: 'REMOVE_BROLL', id: b.id })} className="hover:text-red-400">
                                <Trash2 size={12} />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-2 gap-1.5">
                {results.map((v) => (
                    <button
                        key={v.id}
                        onClick={() => insert(v)}
                        disabled={broll.length >= 3}
                        className="relative aspect-[9/16] rounded-md overflow-hidden border border-edge group disabled:opacity-40"
                    >
                        <img src={v.image} alt="" className="w-full h-full object-cover" />
                        <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                            <Plus size={18} className="text-white" />
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(BrollPanel);
