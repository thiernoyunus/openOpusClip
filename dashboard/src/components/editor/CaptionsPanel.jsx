import React, { useState } from 'react';
import { Type, Bookmark, Check, Sparkles } from 'lucide-react';
import { defaultSubtitleConfig, saveDefaultCaptionStyle } from './useEditorState';
import { CAPTION_TEMPLATES, resolveTemplateId, getCaptionTemplate } from '../../remotion/lib/captionTemplates';
import { SUBTITLE_FONTS } from '../../remotion/lib/fonts';

const POSITIONS = ['top', 'middle', 'bottom'];
const HIGHLIGHTS = ['#FFDD00', '#3dd68c', '#FF5C5C', '#5CA8FF', '#00E5FF', '#FFD700', '#FFFFFF'];
const FONT_OPTIONS = Object.keys(SUBTITLE_FONTS);

const EFFECT_TEMPLATES = CAPTION_TEMPLATES.filter((t) => t.category === 'effects');
const CLASSIC_TEMPLATES = CAPTION_TEMPLATES.filter((t) => t.category === 'classic');

/** Preview chip for a template, rendered with its own font/colors. */
function TemplateButton({ tpl, active, onClick }) {
    const ds = tpl.defaultStyle || {};
    return (
        <button
            onClick={onClick}
            className={`px-2 py-2 rounded-lg border transition-colors ${
                active ? 'bg-white/10 border-white/30' : 'border-edge bg-surface2/50 hover:bg-white/5'
            }`}
        >
            <span
                className="block text-[14px] leading-none"
                style={{
                    fontFamily: SUBTITLE_FONTS[ds.fontFamily] ?? ds.fontFamily ?? 'inherit',
                    color: ds.fontColor || '#FFFFFF',
                    fontWeight: 800,
                    textTransform: tpl.uppercase ? 'uppercase' : 'none',
                    textShadow: ds.borderWidth ? `0 0 1px ${ds.borderColor || '#000'}` : 'none',
                }}
            >
                Abc
            </span>
            <span className="block text-[10px] text-muted mt-1 truncate">{tpl.label}</span>
        </button>
    );
}

/**
 * Right-rail Captions tab: enable/disable captions, pick a template (classic
 * animations or animated effect styles ported from HyperFrames), and adjust
 * font / position / size / highlight. Config lives at framing.subtitles so it
 * persists with Save and is baked into the Export.
 */
export default function CaptionsPanel({ framing, captions, dispatch }) {
    const subs = framing.subtitles || null;
    const [savedDefault, setSavedDefault] = useState(false);

    const setStyle = (patch) =>
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: { ...subs, style: { ...subs.style, ...patch } },
        });

    const applyTemplate = (tpl) =>
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: { ...subs, style: { ...subs.style, ...tpl.defaultStyle } },
        });

    const currentId = subs ? resolveTemplateId(subs.style) : null;
    const currentTpl = subs ? getCaptionTemplate(currentId) : null;
    const fontLocked = !!(currentTpl && currentTpl.font);

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
                    {/* Effect templates */}
                    <div>
                        <span className="flex items-center gap-1 text-[11px] text-muted mb-1.5">
                            <Sparkles size={11} /> Effects
                        </span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {EFFECT_TEMPLATES.map((t) => (
                                <TemplateButton key={t.id} tpl={t} active={currentId === t.id} onClick={() => applyTemplate(t)} />
                            ))}
                        </div>
                    </div>

                    {/* Classic templates */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Classic</span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {CLASSIC_TEMPLATES.map((t) => (
                                <TemplateButton key={t.id} tpl={t} active={currentId === t.id} onClick={() => applyTemplate(t)} />
                            ))}
                        </div>
                    </div>

                    {/* Font */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Font</span>
                        <select
                            value={subs.style.fontFamily}
                            disabled={fontLocked}
                            onChange={(e) => setStyle({ fontFamily: e.target.value })}
                            className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30 [color-scheme:dark] disabled:opacity-50"
                        >
                            {FONT_OPTIONS.map((f) => (
                                <option key={f} value={f}>{f}</option>
                            ))}
                        </select>
                        {fontLocked && (
                            <p className="text-[10px] text-zinc-500 mt-1">This effect uses its own font ({currentTpl.font}).</p>
                        )}
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
                            max={96}
                            value={subs.style.fontSize}
                            onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}
                            className="w-full accent-white"
                        />
                    </div>

                    {/* Highlight color */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Highlight</span>
                        <div className="flex flex-wrap gap-1.5">
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

                    {/* Save current style as the default for future clips (E9) */}
                    <button
                        onClick={() => {
                            saveDefaultCaptionStyle(subs.position, subs.style);
                            setSavedDefault(true);
                            setTimeout(() => setSavedDefault(false), 2000);
                        }}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-edge bg-surface2/50 text-fg text-[11px] font-medium hover:bg-white/5 transition-colors"
                    >
                        {savedDefault ? <Check size={13} className="text-viral" /> : <Bookmark size={13} />}
                        {savedDefault ? 'Saved as default' : 'Set as default style'}
                    </button>
                </div>
            )}
        </div>
    );
}
