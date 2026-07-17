import React from 'react';
import { Plus, Sparkles } from 'lucide-react';

// A "+" tile that lives at the end of the clip grid and triggers a
// "generate more clips" run. Same 9:16 footprint as a ResultCard thumb so it
// slots cleanly into the same grid.
export function GhostClipCard({ onClick, disabled = false }) {
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label="Generate more clips"
        className="group relative aspect-[9/16] w-full rounded-xl border-2 border-dashed border-edge bg-surface2/30 text-muted flex flex-col items-center justify-center gap-2.5 transition-colors hover:border-viral/60 hover:bg-viral/[0.06] hover:text-viral disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="flex items-center justify-center w-11 h-11 rounded-full border-2 border-current">
          <Plus size={22} />
        </span>
        <span className="text-xs font-medium px-3 text-center leading-snug">Generate more clips</span>
      </button>
    </div>
  );
}

// A shimmering placeholder tile shown while a more-clips run is in flight.
// `caption` (optional) renders a faint label over the first skeleton.
export function SkeletonClipCard({ caption }) {
  return (
    <div className="flex flex-col">
      <div className="relative aspect-[9/16] w-full rounded-xl overflow-hidden bg-surface2 border border-edge animate-pulse">
        {caption && (
          <div className="absolute inset-x-0 bottom-0 p-3 flex items-center gap-1.5">
            <Sparkles size={12} className="text-muted shrink-0" />
            <span className="text-[11px] text-muted leading-snug">{caption}</span>
          </div>
        )}
      </div>
      <div className="mt-2 h-3 w-3/4 rounded bg-surface2 animate-pulse" />
    </div>
  );
}
