// Client-side project history.
// The backend keeps jobs in memory for ~1h, so we persist lightweight project
// metadata in localStorage to power the "Recent projects" grid on the homepage.

const KEY = 'openshorts_projects';
const MAX = 30;
const PROCESSING_MAX_AGE = 60 * 60 * 1000;

export function getProjects() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.map((p) => {
      if (p.status === 'processing' && p.createdAt && now - p.createdAt > PROCESSING_MAX_AGE) {
        return { ...p, status: 'expired' };
      }
      return p;
    });
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

export function addProject({ id, title, type, model, thumb, src }) {
  const list = getProjects().filter((p) => p.id !== id);
  const entry = {
    id,
    title: title || 'Untitled project',
    type: type || 'url',
    model: model || 'base',
    src: src || null,
    thumb: thumb || null,
    status: 'processing',
    createdAt: Date.now(),
    cost: null,
    clipCount: 0,
  };
  return save([entry, ...list]);
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
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i] || '';
    const match = PHASES.find((p) => p.re.test(line));
    if (match) return match.label;
  }
  return 'Processing';
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
