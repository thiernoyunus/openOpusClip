import React from 'react';
import { Sparkles } from 'lucide-react';

const TOGGLES = [
    { key: 'fadeIn', label: 'Fade in', desc: 'Ease in from black at the start' },
    { key: 'fadeOut', label: 'Fade out', desc: 'Ease out to black at the end' },
    { key: 'cutCrossfade', label: 'Smooth cuts', desc: 'Soft transition at each cut' },
];

const CUT_STYLES = [
    { key: 'dip', label: 'Dip to black', desc: 'Brief fade through black' },
    { key: 'zoom', label: 'Zoom', desc: 'Quick zoom punch' },
];

/** Right-rail Transitions tab: clip-level fade in/out + smooth cut dips. */
function TransitionsPanel({ framing, dispatch }) {
    const t = framing.transitions || { fadeIn: false, fadeOut: false, cutCrossfade: false };
    return (
        <div className="p-3">
            <h3 className="text-[11px] font-semibold text-fg uppercase tracking-wide mb-1 flex items-center gap-1.5">
                <Sparkles size={12} /> Transitions
            </h3>
            <p className="text-[11px] text-muted mb-3">Applied across the whole clip.</p>
            <div className="space-y-1.5">
                {TOGGLES.map((tog) => (
                    <button
                        key={tog.key}
                        onClick={() => dispatch({ type: 'SET_TRANSITIONS', patch: { [tog.key]: !t[tog.key] } })}
                        className={`w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${
                            t[tog.key] ? 'bg-viral/15 border-viral/50' : 'bg-surface2/50 border-edge hover:bg-white/5'
                        }`}
                    >
                        <span className="min-w-0">
                            <span className="block text-xs font-medium text-fg">{tog.label}</span>
                            <span className="block text-[10px] text-muted">{tog.desc}</span>
                        </span>
                        <span
                            className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${
                                t[tog.key] ? 'bg-viral/70' : 'bg-surface2 border border-edge'
                            }`}
                        >
                            <span
                                className={`absolute top-[3px] left-[3px] bg-white rounded-full h-3.5 w-3.5 transition-transform ${
                                    t[tog.key] ? 'translate-x-4' : ''
                                }`}
                            />
                        </span>
                    </button>
                ))}
            </div>

            {/* Cut style picker — only when smooth cuts are enabled. */}
            {t.cutCrossfade && (
                <div className="mt-3">
                    <span className="block text-[10px] font-medium text-muted uppercase tracking-wide mb-1.5">
                        Cut style
                    </span>
                    <div className="grid grid-cols-2 gap-1.5">
                        {CUT_STYLES.map((cs) => {
                            const active = (t.cutStyle || 'dip') === cs.key;
                            return (
                                <button
                                    key={cs.key}
                                    onClick={() => dispatch({ type: 'SET_TRANSITIONS', patch: { cutStyle: cs.key } })}
                                    className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                                        active ? 'bg-viral/15 border-viral/50' : 'bg-surface2/50 border-edge hover:bg-white/5'
                                    }`}
                                >
                                    <span className="block text-xs font-medium text-fg">{cs.label}</span>
                                    <span className="block text-[10px] text-muted">{cs.desc}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// Memoized: re-renders only when its own props change, not on every editor
// dispatch or tab switch (props from EditorView are stable).
export default React.memo(TransitionsPanel);
