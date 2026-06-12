import React from 'react';
import { Type } from 'lucide-react';
import { defaultSubtitleConfig, CAPTION_PRESETS } from './useEditorState';

const POSITIONS = ['top', 'middle', 'bottom'];
const ANIMATIONS = ['none', 'word-highlight', 'pop', 'karaoke'];
const HIGHLIGHTS = ['#FFDD00', '#3dd68c', '#FF5C5C', '#5CA8FF', '#FFFFFF'];

/**
 * Right-rail Captions tab: enable/disable burned captions, pick a style
 * preset, and adjust position / size / animation / highlight color. The
 * config lives at framing.subtitles so it persists with Save and is burned
 * into the Export.
 */
export default function CaptionsPanel({ framing, captions, dispatch }) {
    const subs = framing.subtitles || null;

    const setStyle = (patch) =>
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: { ...subs, style: { ...subs.style, ...patch } },
        });

    return (
        <div className="p-4">
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold text-fg uppercase tracking-wide">Captions</h3>
                <label className="relative inline-flex items-center cursor-pointer">
                    <input
                        type="checkbox"
                        checked={!!subs}
                        disabled={captions.length === 0}
                        onChange={(e) =>
                            dispatch({
                                type: 'SET_SUBTITLES',
                                subtitles: e.target.checked ? defaultSubtitleConfig(captions) : null,
                            })
                        }
                        className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-surface2 border border-edge rounded-full peer peer-checked:bg-viral/70 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-4" />
                </label>
            </div>

            {captions.length === 0 ? (
                <p className="text-xs text-muted">No transcript available, so captions can't be generated for this clip.</p>
            ) : !subs ? (
                <p className="text-xs text-muted flex items-start gap-1.5">
                    <Type size={13} className="mt-0.5 shrink-0" />
                    Turn captions on to burn word-level subtitles into the clip.
                </p>
            ) : (
                <div className="space-y-4">
                    {/* Presets */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Style preset</span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {CAPTION_PRESETS.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => setStyle(p.style)}
                                    className="px-2 py-2 rounded-lg border border-edge bg-surface2/50 hover:bg-white/5 transition-colors"
                                >
                                    <span
                                        className="block text-[13px] font-bold"
                                        style={{
                                            color: p.style.fontColor,
                                            WebkitTextStroke: p.style.borderWidth ? `1px ${p.style.borderColor}` : undefined,
                                            backgroundColor: p.style.bgOpacity ? p.style.bgColor : 'transparent',
                                        }}
                                    >
                                        Abc
                                    </span>
                                    <span className="block text-[10px] text-muted mt-1">{p.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Position */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Position</span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {POSITIONS.map((pos) => (
                                <button
                                    key={pos}
                                    onClick={() =>
                                        dispatch({ type: 'SET_SUBTITLES', subtitles: { ...subs, position: pos } })
                                    }
                                    className={`px-2 py-1.5 rounded-lg border text-[11px] capitalize transition-colors ${
                                        subs.position === pos
                                            ? 'bg-white/10 border-white/25 text-fg'
                                            : 'bg-surface2/50 border-edge text-muted hover:bg-white/5'
                                    }`}
                                >
                                    {pos}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Size */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">
                            Size <span className="text-zinc-500 tabular-nums">({subs.style.fontSize})</span>
                        </span>
                        <input
                            type="range"
                            min={32}
                            max={84}
                            value={subs.style.fontSize}
                            onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}
                            className="w-full accent-white"
                        />
                    </div>

                    {/* Animation */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Animation</span>
                        <select
                            value={subs.style.animation}
                            onChange={(e) => setStyle({ animation: e.target.value })}
                            className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30 [color-scheme:dark]"
                        >
                            {ANIMATIONS.map((a) => (
                                <option key={a} value={a}>{a}</option>
                            ))}
                        </select>
                    </div>

                    {/* Highlight color */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Highlight</span>
                        <div className="flex gap-1.5">
                            {HIGHLIGHTS.map((c) => (
                                <button
                                    key={c}
                                    onClick={() => setStyle({ highlightColor: c })}
                                    style={{ backgroundColor: c }}
                                    className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                                        subs.style.highlightColor === c ? 'border-white' : 'border-transparent'
                                    }`}
                                    aria-label={`Highlight ${c}`}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
