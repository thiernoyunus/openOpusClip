import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// Colorize a log line the way Opus does: highlight quoted strings, dim routine
// lines, green for success/progress, red for errors.
function logColor(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('failed') || l.includes('exception')) return 'text-red-400';
  if (l.includes('success') || l.includes('finished') || l.includes('done') || l.includes('completed') || l.includes('%')) return 'text-viral';
  if (l.startsWith('fetching') || l.includes('starting') || l.includes('job started')) return 'text-fg';
  return 'text-muted';
}

export default function ProcessingModal({ open, onClose, title: _title, logs = [], status, phase, duration, onViewClips }) {
  const endRef = useRef(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs, open]);

  if (!open) return null;

  const done = status === 'complete';
  const failed = status === 'error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-surface border border-edge rounded-xl w-full max-w-xl shadow-2xl animate-[fadeIn_0.2s_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-medium text-fg">
              {done ? 'Your clips are ready' : failed ? 'Processing failed' : 'Your video is processing'}
            </h2>
            <p className="text-xs text-muted mt-1 truncate">
              {done
                ? `Open the project to review and edit your clips${duration ? ` — finished in ${duration}` : ''}.`
                : failed
                  ? 'Something went wrong — see the log below.'
                  : `You'll get a notification once it's done${duration ? ` — running ${duration}` : ''}.`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-fg transition-colors shrink-0 ml-3">
            <X size={18} />
          </button>
        </div>

        <div className="px-5">
          <div className="bg-canvas border border-edge rounded-lg p-4 font-mono text-xs leading-relaxed max-h-[300px] overflow-y-auto custom-scrollbar">
            {logs.length === 0 ? (
              <div className="text-muted">Starting up…</div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className={logColor(line)}>{line}</div>
              ))
            )}
            {!done && !failed && (
              <div className="flex items-center gap-2 text-viral mt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-viral animate-pulse" />
                {phase || 'Processing'}…
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-5 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-muted hover:text-fg border border-edge hover:bg-white/5 transition-colors"
          >
            {done ? 'Close' : 'Run in background'}
          </button>
          {done && (
            <button
              onClick={onViewClips}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-fg text-[#18181b] hover:bg-white active:scale-[0.99] transition-all"
            >
              View clips
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
