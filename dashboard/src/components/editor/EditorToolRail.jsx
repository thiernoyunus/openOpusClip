import React from 'react';

/**
 * OpusClip-style far-right tool rail: quiet icons + short labels, active pill.
 */
function EditorToolRail({ tabs, activeId, onSelect }) {
    return (
        <div className="w-[68px] shrink-0 border-l border-white/[0.06] bg-[#0c0c0e] flex flex-col items-stretch py-2 gap-0.5">
            <p className="px-2 pt-1 pb-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-600 text-center">
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
                        className={`mx-1.5 h-[54px] rounded-xl flex flex-col items-center justify-center gap-1 text-[9px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/20 ${
                            active
                                ? 'bg-white/[0.08] text-white'
                                : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]'
                        }`}
                    >
                        <Icon size={18} strokeWidth={active ? 2.2 : 1.7} />
                        <span className="max-w-full px-0.5 text-center break-words">
                            {tab.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

export default React.memo(EditorToolRail);
