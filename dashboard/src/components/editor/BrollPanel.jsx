import React, { useState } from 'react';
import { Clapperboard, Search, Trash2, Loader2, Plus, KeyRound, Sparkles } from 'lucide-react';
import { getApiUrl } from '../../config';

const MAX_BROLL = 3;

// Pick a reasonable HD portrait video file from a Pexels video result.
// Shared by manual insert and AI auto-insert so the picking logic lives once.
const pickPexelsFile = (video) =>
    video.video_files.find((f) => f.quality === 'hd' && f.height >= f.width) ||
    video.video_files.find((f) => f.height >= f.width) ||
    video.video_files[0];

/**
 * Right-rail B-Roll tab: search Pexels for portrait stock video and insert a
 * 4s clip at the playhead (max 3). The Pexels key lives in localStorage; the
 * search runs client-side. Inserts store SOURCE-frame spans (EDL-mapped).
 *
 * Also offers "Auto-add AI B-Roll": Gemini analyzes the caption transcript and
 * suggests contextual keywords + timing, which are turned into Pexels clips and
 * inserted automatically (Opus-parity feature, built on the manual flow).
 */
function BrollPanel({ framing, dispatch, getCurrentSourceFrame, captions = [] }) {
    const broll = framing.broll || [];
    const srcFps = framing.source.fps;
    const [key, setKey] = useState(() => localStorage.getItem('pexels_key') || '');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState(null);

    const saveKey = (v) => {
        setKey(v);
        localStorage.setItem('pexels_key', v);
    };

    // Fetch portrait stock videos for a keyword from Pexels (shared shape).
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
        if (broll.length >= MAX_BROLL) return;
        const file = pickPexelsFile(video);
        const start = getCurrentSourceFrame();
        const end = Math.min(
            start + Math.round(4 * srcFps),
            framing.clipOutFrame ?? framing.source.durationFrames
        );
        dispatch({ type: 'ADD_BROLL', item: { id: `broll-${video.id}-${start}`, url: file.link, startFrame: start, endFrame: end } });
    };

    // AI auto-placement: ask Gemini for contextual b-roll (keyword + timing),
    // then turn each suggestion into a Pexels clip and insert it at its moment.
    const autoAdd = async () => {
        if (captions.length === 0 || !key || broll.length >= MAX_BROLL) return;
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
            if (!res.ok) throw new Error(`Suggestion failed (${res.status})`);
            const { suggestions = [] } = await res.json();
            if (suggestions.length === 0) {
                setAiError('No b-roll suggestions for this clip');
                return;
            }

            const clipIn = framing.clipInFrame ?? 0;
            const clipOut = framing.clipOutFrame ?? framing.source.durationFrames;
            let added = broll.length;
            let inserted = 0;

            for (const s of suggestions) {
                if (added >= MAX_BROLL) break;
                let videos;
                try {
                    videos = await searchPexels(s.keyword, 5);
                } catch {
                    continue; // skip a keyword that fails to search; keep going
                }
                if (!videos.length) continue;
                const file = pickPexelsFile(videos[0]);
                if (!file) continue;
                const startFrame = clipIn + Math.round((s.startMs / 1000) * srcFps);
                const endFrame = Math.min(startFrame + Math.round((s.durationMs / 1000) * srcFps), clipOut);
                dispatch({
                    type: 'ADD_BROLL',
                    item: {
                        id: `broll-ai-${videos[0].id}-${startFrame}-${added}`,
                        url: file.link,
                        startFrame,
                        endFrame,
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

            <button
                onClick={autoAdd}
                disabled={aiLoading || captions.length === 0 || broll.length >= MAX_BROLL}
                title={
                    captions.length === 0
                        ? 'Captions are needed for AI b-roll'
                        : broll.length >= MAX_BROLL
                            ? `Maximum ${MAX_BROLL} b-roll clips reached`
                            : 'Let AI analyze the transcript and place contextual b-roll'
                }
                className="w-full mb-3 flex items-center justify-center gap-1.5 rounded-lg bg-surface2 border border-edge text-xs font-medium text-fg py-1.5 hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
                {aiLoading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {aiLoading ? 'Analyzing transcript…' : 'Auto-add AI B-Roll'}
            </button>

            {captions.length === 0 && (
                <p className="text-[11px] text-muted mb-2">Captions are needed for AI b-roll auto-placement.</p>
            )}
            {aiError && <p className="text-[11px] text-red-400 mb-2">{aiError}</p>}
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
