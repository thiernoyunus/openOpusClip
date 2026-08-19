import React from 'react';

/**
 * OpusClip far-right rail: "Media" header + icon stack with tiny labels.
 */
function EditorToolRail({ tabs, activeId, onSelect }) {
    return (
        <aside data-tour="editor-tools" className="w-[64px] shrink-0 border-l border-white/[0.05] bg-[#0b0b0d] flex flex-col items-stretch pt-3 pb-2 gap-0.5">
            <p className="px-1 mb-2 text-[9px] font-medium uppercase tracking-[0.08em] text-zinc-600 text-center">
                Media
            </p>
            {tabs.map((tab) => {
                const active = activeId === tab.id;
                const Icon = tab.icon;
                return (
                    <button
                        type="button"
                        key={tab.id}
                        onClick={() => onSelect(tab.id)}
                        aria-label={tab.label}
                        aria-pressed={active}
                        title={tab.label}
                        className={`mx-1.5 min-h-[56px] py-2 rounded-lg flex flex-col items-center justify-center gap-1.5 text-[9px] leading-none transition-colors ${
                            active
                                ? 'bg-white/[0.08] text-white'
                                : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                        }`}
                    >
                        <Icon size={18} strokeWidth={active ? 2.1 : 1.65} />
                        <span className="max-w-[56px] text-center px-0.5">{tab.label}</span>
                    </button>
                );
            })}
        </aside>
    );
}

export default React.memo(EditorToolRail);
