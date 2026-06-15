import React, { useState } from 'react';
import { Type, Bookmark, Check, Sparkles, Pencil, ArrowLeft, Wand2, Eraser, Loader2 } from 'lucide-react';
import { defaultSubtitleConfig, saveDefaultCaptionStyle } from './useEditorState';
import { CAPTION_TEMPLATES, resolveTemplateId, getCaptionTemplate } from '../../remotion/lib/captionTemplates';
import { SUBTITLE_FONTS } from '../../remotion/lib/fonts';
import { getApiUrl } from '../../config';

const POSITIONS = ['top', 'middle', 'bottom'];
const HIGHLIGHTS = ['#FFDD00', '#3dd68c', '#FF5C5C', '#5CA8FF', '#00E5FF', '#FFD700', '#FFFFFF'];
const TEXT_PRESETS = ['#FFFFFF', '#000000', '#FFDD00', '#FF4444', '#00FF88', '#00BBFF', '#FF69B4'];
const FONT_OPTIONS = Object.keys(SUBTITLE_FONTS);
const WEIGHTS = [
    { v: '', l: 'Default' },
    { v: 300, l: 'Light' },
    { v: 400, l: 'Regular' },
    { v: 500, l: 'Medium' },
    { v: 600, l: 'Semibold' },
    { v: 700, l: 'Bold' },
    { v: 800, l: 'Extrabold' },
    { v: 900, l: 'Black' },
];
const SHADOW_OPTIONS = [
    { value: 'none', label: 'None' },
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
];

const EFFECT_TEMPLATES = CAPTION_TEMPLATES.filter((t) => t.category === 'effects');
const CLASSIC_TEMPLATES = CAPTION_TEMPLATES.filter((t) => t.category === 'classic');

/** `<input type="color">` needs a #rrggbb value; fall back when missing/named. */
const toHex = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#000000');
const eqColor = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

/** Preview chip for a template, rendered with its own font/colors. */
function TemplateButton({ tpl, active, onClick, onCustomize }) {
    const ds = tpl.defaultStyle || {};
    return (
        <button
            onClick={onClick}
            className={`relative px-2 py-2 rounded-lg border transition-colors ${
                active ? 'bg-white/10 border-white/30' : 'border-edge bg-surface2/50 hover:bg-white/5'
            }`}
        >
            {active && onCustomize && (
                <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onCustomize(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onCustomize(); } }}
                    title="Customize this style"
                    className="absolute top-1 right-1 w-5 h-5 rounded-md bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
                >
                    <Pencil size={11} />
                </span>
            )}
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

/** Swatch presets + a custom color picker, all writing one color field. */
function ColorField({ label, value, presets, onChange }) {
    return (
        <div>
            <span className="block text-[11px] text-muted mb-1.5">{label}</span>
            <div className="flex flex-wrap items-center gap-1.5">
                {presets.map((c) => (
                    <button
                        key={c}
                        onClick={() => onChange(c)}
                        style={{ backgroundColor: c }}
                        className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                            eqColor(value, c) ? 'border-white' : 'border-transparent'
                        }`}
                        aria-label={`${label} ${c}`}
                    />
                ))}
                <label
                    className="relative w-7 h-7 rounded-full border-2 border-dashed border-edge cursor-pointer flex items-center justify-center hover:border-white/50 overflow-hidden"
                    title="Custom color"
                >
                    <span className="text-[12px] text-muted leading-none">+</span>
                    <input
                        type="color"
                        value={toHex(value)}
                        onChange={(e) => onChange(e.target.value)}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                </label>
            </div>
        </div>
    );
}

/** Yes/No (or custom-labelled) two-state toggle. */
function Toggle({ value, onChange, yes = 'Yes', no = 'No' }) {
    return (
        <div className="grid grid-cols-2 gap-1.5">
            {[[true, yes], [false, no]].map(([v, l]) => (
                <button
                    key={l}
                    onClick={() => onChange(v)}
                    className={`px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                        value === v
                            ? 'bg-white/10 border-white/25 text-fg'
                            : 'bg-surface2/50 border-edge text-muted hover:bg-white/5'
                    }`}
                >
                    {l}
                </button>
            ))}
        </div>
    );
}

/** Equal-width segmented buttons. */
function Seg({ options, value, onChange }) {
    return (
        <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
            {options.map((o) => (
                <button
                    key={o.value}
                    onClick={() => onChange(o.value)}
                    className={`px-2 py-1.5 rounded-lg border text-[11px] capitalize transition-colors ${
                        value === o.value
                            ? 'bg-white/10 border-white/25 text-fg'
                            : 'bg-surface2/50 border-edge text-muted hover:bg-white/5'
                    }`}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

/**
 * Right-rail Captions tab. Grid mode lets you enable/disable captions and pick a
 * template (classic animations or animated effect styles). The pencil on the active
 * style — or the "Customize" button — opens an inline customize sub-panel exposing
 * the full SubtitleStyle (font/weight/case/size/colors/stroke/shadow/background),
 * Submagic-style. All edits flow through SET_SUBTITLES so the live preview updates
 * instantly and they persist with Save / are baked into the Export.
 */
function CaptionsPanel({ framing, captions, dispatch }) {
    const subs = framing.subtitles || null;
    const [savedDefault, setSavedDefault] = useState(false);
    const [customizing, setCustomizing] = useState(false);
    const [enhancing, setEnhancing] = useState(false);
    const [enhanceError, setEnhanceError] = useState(null);

    const setStyle = (patch) =>
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: { ...subs, style: { ...subs.style, ...patch } },
        });

    // Choosing a preset clears any free-drag x/y so presets and drag stay
    // mutually exclusive (preset wins when chosen; dragging on the canvas sets
    // a custom position that overrides the preset).
    const setPosition = (pos) => {
        const next = { ...subs, position: pos };
        delete next.x;
        delete next.y;
        dispatch({ type: 'SET_SUBTITLES', subtitles: next });
    };

    const customPlaced = subs && typeof subs.x === 'number' && typeof subs.y === 'number';

    const applyTemplate = (tpl) =>
        dispatch({
            type: 'SET_SUBTITLES',
            subtitles: { ...subs, style: { ...subs.style, ...tpl.defaultStyle } },
        });

    // AI pass: ask the backend for contextual emojis + keyword highlights and
    // merge them into the active subtitle captions by index. If captions aren't
    // enabled yet we enable them first (same default config as the toggle/
    // EditorView.handleEditWord path) so the AI result has somewhere to land.
    const enhanceWithAI = async () => {
        const base = subs || defaultSubtitleConfig(captions);
        const words = base.captions;
        if (!words || words.length === 0) {
            setEnhanceError('No caption words to enhance.');
            return;
        }
        const apiKey = localStorage.getItem('gemini_key');
        if (!apiKey) {
            setEnhanceError('Set your Gemini API key in Settings to use AI enhancements.');
            return;
        }
        setEnhancing(true);
        setEnhanceError(null);
        try {
            const res = await fetch(getApiUrl('/api/captions/enhance'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Gemini-Key': apiKey },
                body: JSON.stringify({ words: words.map((w) => w.text) }),
            });
            if (!res.ok) {
                const txt = await res.text();
                let detail = txt;
                try { detail = JSON.parse(txt).detail || txt; } catch { /* keep raw */ }
                throw new Error(detail || `Request failed (${res.status})`);
            }
            const data = await res.json();
            const emojis = data.emojis || {};
            const highlights = new Set((data.highlights || []).map(Number));
            const merged = words.map((w, i) => {
                const next = { ...w };
                const emoji = emojis[String(i)] ?? emojis[i];
                if (emoji) next.emoji = emoji;
                if (highlights.has(i)) next.highlight = true;
                return next;
            });
            dispatch({ type: 'SET_SUBTITLES', subtitles: { ...base, captions: merged } });
        } catch (e) {
            setEnhanceError(e.message || 'AI enhancement failed. Try again.');
        } finally {
            setEnhancing(false);
        }
    };

    // Strip every AI/manual emoji + highlight so the user can undo the AI pass
    // without relying on Ctrl+Z.
    const clearEnhancements = () => {
        if (!subs) return;
        const cleaned = subs.captions.map((w) => {
            const { emoji, highlight, ...rest } = w; // eslint-disable-line no-unused-vars
            return rest;
        });
        dispatch({ type: 'SET_SUBTITLES', subtitles: { ...subs, captions: cleaned } });
        setEnhanceError(null);
    };

    const hasEnhancements =
        !!subs && subs.captions.some((w) => w.emoji || w.highlight);

    const currentId = subs ? resolveTemplateId(subs.style) : null;
    const currentTpl = subs ? getCaptionTemplate(currentId) : null;
    const fontLocked = !!(currentTpl && currentTpl.font);

    const saveDefault = () => {
        saveDefaultCaptionStyle(subs.position, subs.style);
        setSavedDefault(true);
        setTimeout(() => setSavedDefault(false), 2000);
    };

    const SaveDefaultButton = (
        <button
            onClick={saveDefault}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-edge bg-surface2/50 text-fg text-[11px] font-medium hover:bg-white/5 transition-colors"
        >
            {savedDefault ? <Check size={13} className="text-viral" /> : <Bookmark size={13} />}
            {savedDefault ? 'Saved as default' : 'Set as default style'}
        </button>
    );

    // --- Customize sub-panel --------------------------------------------------
    if (subs && customizing) {
        const st = subs.style;
        const effUppercase = st.uppercase ?? currentTpl.uppercase ?? false;
        const effShadow = st.shadow ?? 'none';
        const bgOn = (st.bgOpacity ?? 0) > 0;
        return (
            <div className="p-4">
                <div className="flex items-center gap-2 mb-4">
                    <button
                        onClick={() => setCustomizing(false)}
                        className="w-7 h-7 rounded-lg border border-edge bg-surface2/50 flex items-center justify-center text-muted hover:bg-white/5 transition-colors"
                        title="Back to styles"
                    >
                        <ArrowLeft size={14} />
                    </button>
                    <h3 className="text-xs font-semibold text-fg truncate">Customize {currentTpl.label}</h3>
                </div>

                <div className="space-y-4">
                    {/* Font + weight */}
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <span className="block text-[11px] text-muted mb-1.5">Font</span>
                            <select
                                value={st.fontFamily}
                                disabled={fontLocked}
                                onChange={(e) => setStyle({ fontFamily: e.target.value })}
                                className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30 [color-scheme:dark] disabled:opacity-50"
                            >
                                {FONT_OPTIONS.map((f) => (
                                    <option key={f} value={f}>{f}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <span className="block text-[11px] text-muted mb-1.5">Weight</span>
                            <select
                                value={st.fontWeight ?? ''}
                                onChange={(e) => setStyle({ fontWeight: e.target.value ? Number(e.target.value) : undefined })}
                                className="w-full bg-surface2 border border-edge rounded-lg px-2 py-1.5 text-xs text-fg focus:outline-none focus:border-white/30 [color-scheme:dark]"
                            >
                                {WEIGHTS.map((w) => (
                                    <option key={w.l} value={w.v}>{w.l}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    {fontLocked && (
                        <p className="text-[10px] text-zinc-500 -mt-2">This effect uses its own font ({currentTpl.font}).</p>
                    )}

                    {/* Uppercase */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Uppercase</span>
                        <Toggle value={effUppercase} onChange={(v) => setStyle({ uppercase: v })} />
                    </div>

                    {/* Size */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">
                            Size <span className="text-zinc-500 tabular-nums">({st.fontSize})</span>
                        </span>
                        <input
                            type="range"
                            min={32}
                            max={96}
                            value={st.fontSize}
                            onChange={(e) => setStyle({ fontSize: Number(e.target.value) })}
                            className="w-full accent-white"
                        />
                    </div>

                    {/* Colors */}
                    <ColorField label="Text color" value={st.fontColor} presets={TEXT_PRESETS} onChange={(c) => setStyle({ fontColor: c })} />
                    <ColorField label="Highlight (active word)" value={st.highlightColor} presets={HIGHLIGHTS} onChange={(c) => setStyle({ highlightColor: c })} />

                    {/* Stroke / outline */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">
                            Outline <span className="text-zinc-500 tabular-nums">({st.borderWidth ?? 0}px)</span>
                        </span>
                        <div className="flex items-center gap-3">
                            <label className="relative w-8 h-8 rounded-lg border border-edge cursor-pointer overflow-hidden shrink-0" title="Outline color">
                                <div className="w-full h-full" style={{ backgroundColor: st.borderColor || '#000000' }} />
                                <input type="color" value={toHex(st.borderColor)} onChange={(e) => setStyle({ borderColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                            </label>
                            <input
                                type="range"
                                min={0}
                                max={10}
                                value={st.borderWidth ?? 0}
                                onChange={(e) => setStyle({ borderWidth: Number(e.target.value) })}
                                className="flex-1 accent-white"
                            />
                        </div>
                    </div>

                    {/* Drop shadow */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Drop shadow</span>
                        <Seg options={SHADOW_OPTIONS} value={effShadow} onChange={(v) => setStyle({ shadow: v })} />
                        {effShadow !== 'none' && (
                            <div className="mt-2">
                                <ColorField label="Shadow color" value={st.shadowColor ?? '#000000'} presets={TEXT_PRESETS} onChange={(c) => setStyle({ shadowColor: c })} />
                            </div>
                        )}
                    </div>

                    {/* Background box */}
                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[11px] text-muted">Background box</span>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={bgOn}
                                    onChange={(e) => setStyle({ bgOpacity: e.target.checked ? 0.5 : 0 })}
                                    className="sr-only peer"
                                />
                                <div className="w-9 h-5 bg-surface2 border border-edge rounded-full peer peer-checked:bg-viral/70 after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-4" />
                            </label>
                        </div>
                        {bgOn && (
                            <div className="flex items-center gap-3">
                                <label className="relative w-8 h-8 rounded-lg border border-edge cursor-pointer overflow-hidden shrink-0" title="Background color">
                                    <div className="w-full h-full" style={{ backgroundColor: st.bgColor || '#000000' }} />
                                    <input type="color" value={toHex(st.bgColor)} onChange={(e) => setStyle({ bgColor: e.target.value })} className="absolute inset-0 opacity-0 cursor-pointer" />
                                </label>
                                <input
                                    type="range"
                                    min={10}
                                    max={100}
                                    value={Math.round((st.bgOpacity ?? 0) * 100)}
                                    onChange={(e) => setStyle({ bgOpacity: Number(e.target.value) / 100 })}
                                    className="flex-1 accent-white"
                                />
                                <span className="text-[10px] text-zinc-500 tabular-nums w-8 text-right">{Math.round((st.bgOpacity ?? 0) * 100)}%</span>
                            </div>
                        )}
                    </div>

                    {/* Position */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Position</span>
                        <Seg
                            options={POSITIONS.map((p) => ({ value: p, label: p }))}
                            value={customPlaced ? null : subs.position}
                            onChange={setPosition}
                        />
                        <p className="text-[10px] text-zinc-500 mt-1.5">
                            {customPlaced
                                ? 'Custom position set — pick a preset to reset.'
                                : 'Or drag the caption on the canvas to position it.'}
                        </p>
                    </div>

                    {SaveDefaultButton}
                </div>
            </div>
        );
    }

    // --- Grid mode ------------------------------------------------------------
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
                                <TemplateButton
                                    key={t.id}
                                    tpl={t}
                                    active={currentId === t.id}
                                    onClick={() => applyTemplate(t)}
                                    onCustomize={() => setCustomizing(true)}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Classic templates */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Classic</span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {CLASSIC_TEMPLATES.map((t) => (
                                <TemplateButton
                                    key={t.id}
                                    tpl={t}
                                    active={currentId === t.id}
                                    onClick={() => applyTemplate(t)}
                                    onCustomize={() => setCustomizing(true)}
                                />
                            ))}
                        </div>
                    </div>

                    {/* Customize entry */}
                    <button
                        onClick={() => setCustomizing(true)}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-white/20 bg-white/5 text-fg text-[11px] font-medium hover:bg-white/10 transition-colors"
                    >
                        <Pencil size={13} />
                        Customize {currentTpl?.label}
                    </button>

                    {/* AI emoji & keyword highlights */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">AI enhance</span>
                        <button
                            onClick={enhanceWithAI}
                            disabled={enhancing}
                            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-viral/40 bg-viral/15 text-fg text-[11px] font-medium hover:bg-viral/25 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {enhancing ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                            {enhancing ? 'Enhancing…' : 'AI Emoji & Keywords'}
                        </button>
                        {hasEnhancements && !enhancing && (
                            <button
                                onClick={clearEnhancements}
                                className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-edge bg-surface2/50 text-muted text-[11px] hover:bg-white/5 transition-colors"
                            >
                                <Eraser size={12} />
                                Clear emojis/highlights
                            </button>
                        )}
                        {enhanceError && (
                            <p className="text-[10px] text-red-400 mt-1.5">{enhanceError}</p>
                        )}
                        <p className="text-[10px] text-zinc-500 mt-1.5">
                            Auto-inserts fitting emojis and highlights key words.
                        </p>
                    </div>

                    {/* Quick position */}
                    <div>
                        <span className="block text-[11px] text-muted mb-1.5">Position</span>
                        <Seg
                            options={POSITIONS.map((p) => ({ value: p, label: p }))}
                            value={customPlaced ? null : subs.position}
                            onChange={setPosition}
                        />
                        <p className="text-[10px] text-zinc-500 mt-1.5">
                            {customPlaced
                                ? 'Custom position set — pick a preset to reset.'
                                : 'Or drag the caption on the canvas to position it.'}
                        </p>
                    </div>

                    {/* Quick size */}
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
                </div>
            )}
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(CaptionsPanel);
