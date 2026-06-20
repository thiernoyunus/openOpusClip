import React from 'react';

/**
 * Thin vertical icon-only rail (far-right edge of the editor). Each tool is an
 * icon button with a left green indicator bar when active; labels surface via
 * the native `title` tooltip. Replaces the old horizontal `grid-cols-6` strip.
 *
 * Pure-presentational: `tabs` + `activeId` + `onSelect` flow straight through
 * from EditorView, so the activeTab state and panel switching are unchanged.
 */
function EditorToolRail({ tabs, activeId, onSelect }) {
    return (
        <div className="w-[72px] shrink-0 border-l border-edge bg-background flex flex-col items-stretch py-3 gap-1">
            {tabs.map((tab) => {
                const active = activeId === tab.id;
                const Icon = tab.icon;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onSelect(tab.id)}
                        aria-label={tab.label}
                        aria-pressed={active}
                        className={`mx-2 h-[58px] rounded-md flex flex-col items-center justify-center gap-1 text-[10px] leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-viral/50 ${
                            active ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg hover:bg-white/5'
                        }`}
                    >
                        <Icon size={18} strokeWidth={active ? 2.25 : 1.75} />
                        <span className="max-w-full px-0.5 text-center break-words">
                            {tab.label}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

// Memoized: with a stable onSelect (useCallback in EditorView) the rail skips
// re-rendering when unrelated editor state changes.
export default React.memo(EditorToolRail);
