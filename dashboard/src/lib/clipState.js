// Per-project notes about individual clips, kept in the browser:
//   scheduled — already posted or booked, so the grid can mark them and the
//               week scheduler can leave them out of the next batch
//   picked    — clips you ticked, ready to carry into the scheduler
// Clips are referenced by their position in the project's clip list, which is
// also what the server expects, so nothing is ever renumbered.
// ponytail: browser-only memory — the posting service (Calendar tab) is the
// real record. Move this server-side if it ever has to follow the user
// between machines.

const KEY = 'openshorts_clip_state';
const MAX_JOBS = 50;

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_JOBS))));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Clip indexes on one of a job's lists ('scheduled' | 'picked'), ascending. */
export function getClipList(jobId, kind) {
  if (!jobId) return [];
  const list = readAll()[jobId]?.[kind];
  return Array.isArray(list) ? list : [];
}

/** Replaces one of a job's lists and returns it. */
export function setClipList(jobId, kind, indexes) {
  const next = [...new Set(indexes)].sort((a, b) => a - b);
  if (!jobId) return next;
  const all = readAll();
  const job = all[jobId] || {};
  delete all[jobId];              // re-insert last so the oldest jobs are dropped first
  all[jobId] = { ...job, [kind]: next };
  write(all);
  return next;
}

/** Adds `indexes` to one of a job's lists and returns the full list. */
export function addToClipList(jobId, kind, indexes) {
  return setClipList(jobId, kind, [...getClipList(jobId, kind), ...indexes]);
}
