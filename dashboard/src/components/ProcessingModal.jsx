import React, { useEffect, useRef, useState } from 'react';
import { X, ArrowDown, Check, ChevronRight } from 'lucide-react';
import { PHASE_LABELS, phaseIndexFromLogs } from '../lib/projectHistory';

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
  const scrollRef = useRef(null);
  // Stick to the newest line only while the user is already at the bottom.
  // Once they scroll up to read, leave them there until they come back down.
  // The parent mounts this only while open, so state resets fresh per run.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Raw log is secondary: hidden behind a disclosure so the friendly checklist
  // reads first. Auto-opens on failure so the error is visible without a click.
  const [showDetails, setShowDetails] = useState(false);
  const autoOpenedRef = useRef(false);

  const pinToBottom = () => {
    pinnedRef.current = true;
    setPinned(true);
  };

  useEffect(() => {
    // Instant (not smooth): a smooth animation fires intermediate scroll events
    // that read as "not at bottom" and would unpin us mid-stream.
    if (open && showDetails && pinnedRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, open, showDetails]);

  useEffect(() => {
    if (status === 'error' && !autoOpenedRef.current) {
      pinToBottom(); // land on the error line, not wherever a prior mount left off
      setShowDetails(true);
      autoOpenedRef.current = true;
    }
  }, [status]);

  // Reset per-open so state never leaks between jobs. App.jsx unmounts the modal
  // while closed, but TrailerPage keeps it mounted with open={showModal}, so
  // without this a hidden-details / unpinned state would carry into the next run.
  useEffect(() => {
    if (!open) {
      setShowDetails(false);
      autoOpenedRef.current = false;
      pinnedRef.current = true; // ref only — modal renders null while closed;
      // `pinned` state re-syncs when the log is reopened (toggleDetails pins).
    }
  }, [open]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom === pinnedRef.current) return; // no-op when the flag hasn't flipped
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  };

  const toggleDetails = () => {
    // Reopening remounts the scroll box; start pinned at the latest line rather
    // than stuck at the top where the previous mount was scrolled.
    if (!showDetails) pinToBottom();
    setShowDetails((v) => !v);
  };

  const jumpToLatest = () => {
    pinToBottom();
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  if (!open) return null;

  const done = status === 'complete';
  const failed = status === 'error';
  const current = phaseIndexFromLogs(logs);

  // done → every stage complete; failed → the reached stage is the one that
  // broke; running → stages before `current` done, `current` active, rest wait.
  const stageState = (i) => {
    if (done) return 'done';
    if (failed) return i < current ? 'done' : i === current ? 'failed' : 'pending';
    return i < current ? 'done' : i === current ? 'active' : 'pending';
  };

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
                  ? 'Something went wrong — the technical details are below.'
                  : `You'll get a notification once it's done${duration ? ` — running ${duration}` : ''}.`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-fg transition-colors shrink-0 ml-3">
            <X size={18} />
          </button>
        </div>

        <div className="px-5">
          {/* Friendly stage checklist — the primary, plain-language view. */}
          <ul className="bg-canvas border border-edge rounded-lg p-4 space-y-0.5">
            {PHASE_LABELS.map((label, i) => {
              const state = stageState(i);
              return (
                <li key={label} className="flex items-center gap-2.5 py-1">
                  <span className="shrink-0 w-4 h-4 flex items-center justify-center">
                    {state === 'done' && (
                      <span className="w-4 h-4 rounded-full bg-viral flex items-center justify-center">
                        <Check size={11} strokeWidth={3} className="text-[#18181b]" />
                      </span>
                    )}
                    {state === 'active' && <span className="w-2 h-2 rounded-full bg-viral animate-pulse" />}
                    {state === 'failed' && (
                      <span className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
                        <X size={11} strokeWidth={3} className="text-white" />
                      </span>
                    )}
                    {state === 'pending' && <span className="w-2 h-2 rounded-full border border-edge" />}
                  </span>
                  <span
                    className={
                      state === 'active'
                        ? 'text-sm text-fg font-medium'
                        : state === 'failed'
                          ? 'text-sm text-red-400'
                          : state === 'done'
                            ? 'text-sm text-muted'
                            : 'text-sm text-muted/50'
                    }
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* Raw log, collapsed by default. Keeps the exact streaming output for
              anyone who wants it, without making it the first thing you see. */}
          <button
            onClick={toggleDetails}
            className="flex items-center gap-1 mt-3 text-xs text-muted hover:text-fg transition-colors"
          >
            <ChevronRight size={13} className={`transition-transform ${showDetails ? 'rotate-90' : ''}`} />
            {showDetails ? 'Hide technical details' : 'Show technical details'}
          </button>

          {showDetails && (
            <div className="relative mt-2">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="bg-canvas border border-edge rounded-lg p-4 font-mono text-xs leading-relaxed max-h-[240px] overflow-y-auto custom-scrollbar"
              >
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
                    {/* Use the monotonic active stage so this agrees with the
                        checklist above rather than the newest raw log line. */}
                    {(current >= 0 ? PHASE_LABELS[current] : phase) || 'Processing'}…
                  </div>
                )}
                <div ref={endRef} />
              </div>
              {!pinned && (
                <button
                  onClick={jumpToLatest}
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-fg text-[#18181b] shadow-lg hover:bg-white active:scale-[0.98] transition-all"
                >
                  <ArrowDown size={13} />
                  Jump to latest
                </button>
              )}
            </div>
          )}
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
