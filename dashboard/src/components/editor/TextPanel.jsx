import React from 'react';
import { Type, Plus, Trash2, Clock } from 'lucide-react';

const SIZES = ['S', 'M', 'L'];
const COLORS = ['#FFFFFF', '#FFDD00', '#3dd68c', '#FF5C5C', '#000000'];

/**
 * Right-rail Text tab: up to 5 free-positioned text overlays. Times are stored
 * in SOURCE frames (anchored to content through cuts); position is normalized
 * 0-1 and adjusted with the X/Y sliders (the canvas shows the result live).
 */
function TextPanel({ framing, dispatch, getCurrentSourceFrame }) {
    const overlays = framing.textOverlays || [];
    const srcFps = framing.source.fps;

    const addOverlay = () => {
        const start = getCurrentSourceFrame();
        const end = Math.min(start + Math.round(3 * srcFps), framing.clipOutFrame ?? framing.source.durationFrames);
        dispatch({
            type: 'ADD_TEXT_OVERLAY',
            overlay: {
                id: `txt-${start}-${overlays.length}`,
                text: 'Your text',
                startFrame: start,
                endFrame: end,
                x: 0.5,
                y: 0.2,
                size: 'M',
                color: '#FFFFFF',
                bg: true,
            },
        });
    };

    const update = (id, patch) => dispatch({ type: 'UPDATE_TEXT_OVERLAY', id, patch });
    const fmt = (f) => `${((f - (framing.clipInFrame ?? 0)) / srcFps).toFixed(1)}s`;

    return (
        <div className="p-4">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-fg uppercase tracking-wide flex items-center gap-1.5">
                    <Type size={13} /> Text
                </h3>
                <button
                    onClick={addOverlay}
                    disabled={overlays.length >= 5}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface2 border border-edge text-[11px] text-fg hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    <Plus size={12} /> Add
                </button>
            </div>

            {overlays.length === 0 ? (
                <p className="text-xs text-muted">Add a text overlay at the playhead position (max 5).</p>
            ) : (
                <div className="space-y-4">
                    {overlays.map((o) => (
                        <div key={o.id} className="rounded-lg border border-edge bg-surface2/40 p-2.5 space-y-2">
                            <div className="flex items-center gap-1.5">
                                <input
                                    value={o.text}
                                    onChange={(e) => update(o.id, { text: e.target.value })}
                                    className="flex-1 min-w-0 bg-surface2 border border-edge rounded px-2 py-1 text-xs text-fg focus:outline-none focus:border-white/30"
                                />
                                <button
                                    onClick={() => dispatch({ type: 'REMOVE_TEXT_OVERLAY', id: o.id })}
                                    className="text-muted hover:text-red-400 p-1"
                                    aria-label="Delete text overlay"
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>

                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted w-8">Size</span>
                                <div className="flex gap-1">
                                    {SIZES.map((s) => (
                                        <button
                                            key={s}
                                            onClick={() => update(o.id, { size: s })}
                                            className={`w-6 h-6 rounded text-[11px] border ${
                                                o.size === s ? 'bg-white/15 border-white/30 text-fg' : 'border-edge text-muted hover:bg-white/5'
                                            }`}
                                        >
                                            {s}
                                        </button>
                                    ))}
                                </div>
                                <div className="flex gap-1 ml-auto">
                                    {COLORS.map((c) => (
                                        <button
                                            key={c}
                                            onClick={() => update(o.id, { color: c })}
                                            style={{ backgroundColor: c }}
                                            className={`w-5 h-5 rounded-full border ${o.color === c ? 'border-white' : 'border-edge'}`}
                                            aria-label={`Color ${c}`}
                                        />
                                    ))}
                                </div>
                            </div>

                            <label className="flex items-center gap-2 text-[10px] text-muted">
                                <input type="checkbox" checked={o.bg} onChange={(e) => update(o.id, { bg: e.target.checked })} />
                                Background pill
                            </label>

                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted w-8">X</span>
                                <input type="range" min={0} max={1} step={0.01} value={o.x}
                                    onChange={(e) => update(o.id, { x: Number(e.target.value) })} className="flex-1 accent-white" />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted w-8">Y</span>
                                <input type="range" min={0} max={1} step={0.01} value={o.y}
                                    onChange={(e) => update(o.id, { y: Number(e.target.value) })} className="flex-1 accent-white" />
                            </div>

                            <div className="flex items-center gap-2 text-[10px] text-muted">
                                <Clock size={11} />
                                <span>{fmt(o.startFrame)} → {fmt(o.endFrame)}</span>
                                <button
                                    onClick={() => update(o.id, { startFrame: getCurrentSourceFrame() })}
                                    className="ml-auto px-1.5 py-0.5 rounded bg-surface2 border border-edge hover:bg-white/5"
                                >
                                    Set start
                                </button>
                                <button
                                    onClick={() => update(o.id, { endFrame: getCurrentSourceFrame() })}
                                    className="px-1.5 py-0.5 rounded bg-surface2 border border-edge hover:bg-white/5"
                                >
                                    Set end
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(TextPanel);
