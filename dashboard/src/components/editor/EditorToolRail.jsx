import React from 'react';

/**
 * Thin vertical icon-only rail (far-right edge of the editor). Each tool is an
 * icon button with a left green indicator bar when active; labels surface via
 * the native `title` tooltip. Replaces the old horizontal `grid-cols-6` strip.
 *
 * Pure-presentational: `tabs` + `activeId` + `onSelect` flow straight through
 * from EditorView, so the activeTab state and panel switching are unchanged.
 */
export default function EditorToolRail({ tabs, activeId, onSelect }) {
    return (
        <div className="w-12 shrink-0 border-l border-edge bg-surface flex flex-col items-stretch py-2 gap-0.5">
            {tabs.map((tab) => {
                const active = activeId === tab.id;
                const Icon = tab.icon;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onSelect(tab.id)}
                        aria-label={tab.label}
                        aria-pressed={active}
                        className={`relative h-11 w-full flex items-center justify-center transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-viral/50 ${
                            active ? 'text-viral' : 'text-muted hover:text-fg hover:bg-white/5'
                        }`}
                    >
                        {/* Active indicator: left edge bar */}
                        <span
                            className={`absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r-full bg-viral transition-opacity ${
                                active ? 'opacity-100' : 'opacity-0'
                            }`}
                        />
                        <Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
                        {/* Floating label that shows on hover/focus, beside the rail */}
                        <span
                            className="pointer-events-none absolute right-full mr-2 whitespace-nowrap rounded-md bg-surface2 border border-edge px-2 py-1 text-[11px] font-medium text-fg opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity z-30"
                        >
                            {tab.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
