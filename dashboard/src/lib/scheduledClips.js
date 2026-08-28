// Which clips of a job have already been posted or scheduled, so the grid can
// mark them and the week scheduler can leave them out of the next batch.
// ponytail: browser-only memory — the posting service (Calendar tab) is the
// real record. Move this server-side if it ever has to follow the user
// between machines.

const KEY = 'openshorts_scheduled_clips';
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

/** Clip indexes of `jobId` already posted or scheduled, ascending. */
export function getScheduledClips(jobId) {
  if (!jobId) return [];
  const list = readAll()[jobId];
  return Array.isArray(list) ? list : [];
}

/** Remembers `indexes` as scheduled and returns the job's full list. */
export function markClipsScheduled(jobId, indexes) {
  const merged = [...new Set([...getScheduledClips(jobId), ...indexes])].sort((a, b) => a - b);
  if (!jobId) return merged;
  const all = readAll();
  delete all[jobId];          // re-insert last so the oldest jobs are the ones dropped
  all[jobId] = merged;
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-MAX_JOBS))));
  } catch {
    // localStorage full or unavailable — ignore
  }
  return merged;
}
