// Client-side project history.
// Projects are kept on the server until you delete them (JOB_RETENTION_SECONDS
// defaults to permanent), so we just persist lightweight metadata in
// localStorage to power the "Recent projects" grid on the homepage — the
// server (via openProject's pollJob check) is the only source of truth for
// whether a project actually still exists. A card stuck on 'processing' (e.g.
// the tab closed before the job finished) stays that way until you click it —
// don't guess it's gone here.

const KEY = 'openshorts_projects';
const MAX = 30;
// One-time migration flag: browsers that used the app before the fix above
// could have projects PERMANENTLY saved as 'expired' by the old buggy
// getProjects() (e.g. via a later updateProject() call baking that guess
// into storage). Downgrade those back to 'processing' exactly once so a
// click re-validates them for real, instead of trusting a stale guess forever.
const MIGRATION_KEY = 'openshorts_projects_migrated_v1';

function migrateStaleExpired(list) {
  if (localStorage.getItem(MIGRATION_KEY)) return list;
  try { localStorage.setItem(MIGRATION_KEY, '1'); } catch { /* ignore */ }
  let changed = false;
  const migrated = list.map((p) => {
    if (p.status === 'expired') { changed = true; return { ...p, status: 'processing' }; }
    return p;
  });
  return changed ? save(migrated) : list;
}

export function getProjects() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return migrateStaleExpired(Array.isArray(list) ? list : []);
  } catch {
    return [];
  }
}

function save(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // localStorage full or unavailable — ignore
  }
  return list.slice(0, MAX);
}

export function addProject({ id, title, type, model, thumb, src, startedAt, kind }) {
  const list = getProjects().filter((p) => p.id !== id);
  const entry = {
    id,
    title: title || 'Untitled project',
    type: type || 'url',
    model: model || 'base',
    src: src || null,
    thumb: thumb || null,
    status: 'processing',
    createdAt: startedAt || Date.now(),
    cost: null,
    clipCount: 0,
    // 'trailer' for Podcast Trailer jobs, else undefined (normal clip jobs).
    kind: kind || undefined,
  };
  return save([entry, ...list]);
}

// A project belongs to the Podcast Trailer page when tagged kind:'trailer'.
// The title-prefix fallback catches trailers created before `kind` existed.
export function isTrailerProject(p) {
  return p?.kind === 'trailer' || (p?.title || '').startsWith('Trailer ·');
}

export function updateProject(id, patch) {
  const list = getProjects();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) return list;
  list[i] = { ...list[i], ...patch };
  return save(list);
}

export function removeProject(id) {
  return save(getProjects().filter((p) => p.id !== id));
}

// Derive a human-readable phase from the latest processing logs.
const PHASES = [
  { re: /(download|fetch|yt-dlp|ingest)/i, label: 'Downloading video' },
  { re: /(transcrib|whisper|word-level)/i, label: 'Transcribing audio' },
  { re: /(scene|pyscenedetect|bound<|segment)/i, label: 'Detecting scenes' },
  { re: /(gemini|analy|viral|moment|curation)/i, label: 'Analyzing for viral moments' },
  { re: /(ffmpeg|extract|cut|clip)/i, label: 'Extracting clips' },
  { re: /(crop|reframe|track|mediapipe|yolo)/i, label: 'Reframing to vertical' },
  { re: /(subtitle|caption|burn)/i, label: 'Adding subtitles' },
  { re: /(render|compil|upload|s3)/i, label: 'Finalizing' },
];

export function phaseFromLogs(logs) {
  if (!logs || logs.length === 0) return 'Starting up';
  const explicit = explicitPhaseIndex(logs);
  if (explicit !== null) return PHASE_LABELS[Math.min(explicit, PHASE_LABELS.length - 1)] || 'Processing';
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i] || '';
    const match = PHASES.find((p) => p.re.test(line));
    if (match) return match.label;
  }
  return 'Processing';
}

// Ordered, friendly stage labels for the processing checklist.
export const PHASE_LABELS = PHASES.map((p) => p.label);

const EXPLICIT_STAGE_INDEX = {
  download: 0,
  transcribe: 1,
  scenes: 2,
  analyze: 3,
  extract: 4,
  reframe: 5,
  subtitles: 6,
  finalize: 7,
};
const EXPLICIT_STAGE_RE = /OPENSHORTS_STAGE:([a-z]+):(start|done)/i;

function explicitPhaseIndex(logs) {
  let reached = -1;
  let found = false;
  for (const line of logs || []) {
    const match = String(line || '').match(EXPLICIT_STAGE_RE);
    if (!match) continue;
    const index = EXPLICIT_STAGE_INDEX[match[1].toLowerCase()];
    if (index === undefined) continue;
    found = true;
    reached = Math.max(reached, match[2].toLowerCase() === 'done' ? index + 1 : index);
  }
  return found ? reached : null;
}

// Index of the furthest stage the logs have reached (-1 = not started yet).
// Uses the MAX matched index, not the newest match: the per-clip pipeline
// re-logs "Step 1: Detecting scenes…" for every clip during extraction, so a
// newest-match would make the checklist jump backwards mid-run. Progress is
// monotonic, so take the highest stage any line has reached.
export function phaseIndexFromLogs(logs) {
  if (!logs || logs.length === 0) return -1;
  const explicit = explicitPhaseIndex(logs);
  if (explicit !== null) return explicit;
  let max = -1;
  for (const line of logs) {
    const idx = PHASES.findIndex((p) => p.re.test(line || ''));
    if (idx > max) max = idx;
  }
  return max;
}

// A short, friendly fallback title from the submit payload.
export function titleFromPayload(data) {
  if (!data) return 'Untitled project';
  if (data.type === 'file') return data.payload?.name || 'Uploaded video';
  const url = String(data.payload || '');
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.slice(0, 24);
  } catch {
    return url.slice(0, 40) || 'YouTube video';
  }
}

// Extract a YouTube video id from any common URL/string form.
export function youtubeId(str) {
  if (!str) return null;
  const m = String(str).match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// A cover-image URL for a string (YouTube only); null otherwise.
export function coverFromString(str) {
  const id = youtubeId(str);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

// Cover for a submit payload at submit time (YouTube URL only here; files are
// handled by captureVideoFrame).
export function thumbFromPayload(data) {
  if (!data || data.type !== 'url') return null;
  return coverFromString(data.payload);
}

// Resolve the real video title. YouTube oEmbed needs no API key and is
// CORS-enabled; falls back to null so callers keep their fallback title.
export async function fetchVideoTitle(data) {
  if (!data || data.type === 'file') return null;
  const url = String(data.payload || '');
  if (!youtubeId(url)) return null;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (res.ok) {
      const j = await res.json();
      return j.title || null;
    }
  } catch {
    // CORS / offline / non-embeddable — keep fallback
  }
  return null;
}

// Grab a single frame from a local video File and return a small JPEG dataURL.
export function captureVideoFrame(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.src = url;
      const cleanup = () => URL.revokeObjectURL(url);
      video.onloadeddata = () => {
        try { video.currentTime = Math.min(1, (video.duration || 2) / 2); } catch { /* */ }
      };
      video.onseeked = () => {
        try {
          const w = video.videoWidth || 480;
          const scale = Math.min(1, 480 / w);
          const canvas = document.createElement('canvas');
          canvas.width = w * scale;
          canvas.height = (video.videoHeight || 270) * scale;
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          cleanup();
          resolve(dataUrl);
        } catch { cleanup(); resolve(null); }
      };
      video.onerror = () => { cleanup(); resolve(null); };
    } catch {
      resolve(null);
    }
  });
}
