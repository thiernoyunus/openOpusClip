import React, { useState, useEffect, useRef } from 'react';
import { Youtube, Upload, FileVideo, X, ArrowLeft, Film, AlertTriangle, KeyRound } from 'lucide-react';
import ProcessingModal from './components/ProcessingModal';
import { phaseFromLogs, addProject, updateProject, removeProject, getProjects, isTrailerProject } from './lib/projectHistory';
import { getApiUrl } from './config';

// Transcription engines mirror MediaInput: 'whisper' (built-in, free) or
// 'soniox' (BYO key, best for multilingual). Soniox is only usable with a key
// saved in Settings on the main app (localStorage soniox_key_v1).
const WHISPER_MODELS = [
  { value: 'tiny', label: 'Tiny', help: 'Fastest, lowest accuracy' },
  { value: 'base', label: 'Base', help: 'Current default' },
  { value: 'small', label: 'Small', help: 'Better accuracy, slower' },
  { value: 'medium', label: 'Medium', help: 'Strong accuracy, much slower' },
  { value: 'large-v3-turbo', label: 'Large v3 Turbo', help: 'Near-best accuracy, much faster' },
  { value: 'large-v3', label: 'Large v3', help: 'Best accuracy, slowest' },
];

const ASPECT_RATIOS = [
  { value: '9:16', label: '9:16 · Reels / Shorts / TikTok' },
  { value: '1:1', label: '1:1 · Square' },
  { value: '4:5', label: '4:5 · Portrait' },
  { value: '16:9', label: '16:9 · Landscape' },
];

// Pace presets mirror main.TRAILER_PACE_PRESETS. Moments are coherent complete
// thoughts (~4-10s); the preset scales how many beats the trailer holds.
const PACES = [
  { value: 'punchy', label: 'Punchy · ~35s, tightest' },
  { value: 'standard', label: 'Standard · ~60s (recommended)' },
  { value: 'extended', label: 'Extended · ~90s' },
];

// Same decryption used by App.jsx to read the Soniox key out of localStorage,
// so a key saved in the main app's Settings works here too.
const SECRET_KEY = import.meta.env.VITE_ENCRYPTION_KEY || 'OpenShorts-Static-Salt-Change-Me';
const ENCRYPTION_PREFIX = 'ENC:';
const decrypt = (text) => {
  if (!text) return '';
  if (text.startsWith(ENCRYPTION_PREFIX)) {
    try {
      const raw = text.slice(ENCRYPTION_PREFIX.length);
      const xor = atob(raw);
      return xor
        .split('')
        .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length)))
        .join('');
    } catch (e) {
      return '';
    }
  }
  return text;
};

const MAX_POLL_FAILURES = 5;

export default function TrailerPage() {
  // Reuse the exact same localStorage keys the main app uses.
  const apiKey = localStorage.getItem('gemini_key') || '';
  const sonioxKey = (() => {
    const stored = localStorage.getItem('soniox_key_v1');
    return stored ? decrypt(stored) : '';
  })();

  const [mode, setMode] = useState('url'); // 'url' | 'file'
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [pace, setPace] = useState('standard');
  const [smartPlacement, setSmartPlacement] = useState(false);
  const [whisperModel, setWhisperModel] = useState('base');
  const [transcriptionEngine, setTranscriptionEngine] = useState('whisper');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | processing | complete | error
  const [logs, setLogs] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [projects, setProjects] = useState(() => getProjects().filter(isTrailerProject));
  const pollFailures = useRef(0);

  const sonioxBlocked = transcriptionEngine === 'soniox' && !sonioxKey;

  // Poll /api/status/{jobId} like App.jsx does; on completion open the editor on
  // the single trailer clip (result.clips[0]).
  useEffect(() => {
    if (status !== 'processing' || !jobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(getApiUrl(`/api/status/${jobId}`));
        if (res.status === 404 || res.status === 410) {
          throw new Error('Job expired or server restarted');
        }
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = await res.json();
        if (cancelled) return;
        pollFailures.current = 0;
        if (data.logs) setLogs(data.logs);

        if (data.status === 'completed') {
          setStatus('complete');
          if (data.logs) setLogs(data.logs);
          updateProject(jobId, { status: 'completed', clipCount: 1, duration_seconds: data.duration_seconds ?? null });
          setProjects(getProjects().filter(isTrailerProject));
          if (data.result?.clips?.[0]) {
            // Navigate to the editor on the trailer clip via the same mechanism
            // App uses: editorJob=<jobId>&clip=0. main.jsx's Root() picks this up.
            const params = new URLSearchParams();
            params.set('editorJob', jobId);
            params.set('clip', '0');
            window.location.search = params.toString();
          }
        } else if (data.status === 'failed') {
          setStatus('error');
          updateProject(jobId, { status: 'error' });
          setProjects(getProjects().filter(isTrailerProject));
          const errorMsg = data.error || (data.logs?.length ? data.logs[data.logs.length - 1] : 'Process failed');
          setLogs((prev) => [...prev, 'Error: ' + errorMsg]);
        }
      } catch (e) {
        if (cancelled) return;
        pollFailures.current += 1;
        if (pollFailures.current >= MAX_POLL_FAILURES) {
          setStatus('error');
          setLogs((prev) => [...prev, `Error: ${e.message}`]);
        }
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, jobId]);

  // Resume polling for trailer jobs left 'processing' (e.g. the user reloaded or
  // came back to #trailer while one was still running). Without this their
  // "Recent trailers" card stays stuck on "Processing…" and never becomes
  // clickable. Excludes the active submission (the effect above owns that one).
  // Keyed on the processing-id SET so it re-arms only when that set changes.
  const resumeIds = projects
    .filter((p) => p.status === 'processing' && p.id !== jobId)
    .map((p) => p.id)
    .join(',');
  useEffect(() => {
    if (!resumeIds) return;
    const ids = resumeIds.split(',');
    let cancelled = false;
    const tick = async () => {
      for (const id of ids) {
        try {
          const res = await fetch(getApiUrl(`/api/status/${id}`));
          if (res.status === 404 || res.status === 410) {
            updateProject(id, { status: 'expired' });
            continue;
          }
          if (!res.ok) continue;
          const data = await res.json();
          if (cancelled) return;
          if (data.status === 'completed') updateProject(id, { status: 'completed', clipCount: 1 });
          else if (data.status === 'failed') updateProject(id, { status: 'error' });
        } catch { /* transient — try again next tick */ }
      }
      if (!cancelled) setProjects(getProjects().filter(isTrailerProject));
    };
    tick();
    const iv = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [resumeIds, jobId]);

  // Mirror App.jsx startProcessJob exactly, but add mode:'trailer' and omit the
  // clip-length / skip_analysis / moment_prompt controls (trailer mode owns the
  // moment selection on the backend).
  const submit = async () => {
    if (!apiKey) {
      // Same prompt path App uses: bounce to Settings on the main app.
      alert('Add your Gemini API key in Settings (on the main app) to generate a trailer.');
      window.location.hash = '#app';
      return;
    }
    if (!acknowledged || sonioxBlocked || submitting) return;
    if (mode === 'url' && !url) return;
    if (mode === 'file' && !file) return;

    setSubmitting(true);
    setStatus('processing');
    setLogs(['Queued podcast trailer…']);
    setShowModal(true);

    try {
      const headers = { 'X-Gemini-Key': apiKey };
      if (transcriptionEngine === 'soniox' && sonioxKey) {
        headers['X-Soniox-Key'] = sonioxKey;
      }

      let body;
      if (mode === 'url') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          url,
          mode: 'trailer',
          trailer_pace: pace,
          smart_placement: smartPlacement,
          acknowledged: true,
          whisper_model: whisperModel,
          transcription_engine: transcriptionEngine,
          aspect_ratio: aspectRatio,
        });
      } else {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mode', 'trailer');
        formData.append('trailer_pace', pace);
        formData.append('smart_placement', smartPlacement ? 'true' : 'false');
        formData.append('acknowledged', 'true');
        formData.append('whisper_model', whisperModel);
        formData.append('transcription_engine', transcriptionEngine || 'whisper');
        formData.append('aspect_ratio', aspectRatio);
        body = formData;
      }

      const res = await fetch(getApiUrl('/api/process'), {
        method: 'POST',
        // For file uploads the browser sets Content-Type (multipart boundary),
        // so only forward the auth headers — including X-Soniox-Key when present.
        headers:
          mode === 'url'
            ? headers
            : { 'X-Gemini-Key': apiKey, ...(headers['X-Soniox-Key'] ? { 'X-Soniox-Key': headers['X-Soniox-Key'] } : {}) },
        body,
      });

      if (!res.ok) throw new Error(await res.text());
      const resData = await res.json();
      setJobId(resData.job_id);
      // Register in the shared project history (localStorage) so the trailer
      // shows up on the dashboard and App's poller picks it up. Mirrors
      // App.jsx startProcessJob; 'Trailer ·' marks it apart from clip jobs.
      addProject({
        id: resData.job_id,
        title: `Trailer · ${mode === 'url' ? url : file?.name || 'Podcast'}`,
        type: mode,
        model: whisperModel,
        src: mode === 'url' ? url : null,
        startedAt: Date.now(),
        kind: 'trailer',
      });
      setProjects(getProjects().filter(isTrailerProject));
      setLogs([`Queued ${mode === 'url' ? url : file?.name || 'video'}…`]);
    } catch (e) {
      setStatus('error');
      setLogs((l) => [...l, `Error starting job: ${e.message}`]);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    submit();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('video/'));
    if (dropped.length > 0) {
      setFile(dropped[0]);
      setMode('file');
    }
  };

  // Open a finished trailer in the editor (same mechanism App / main.jsx use).
  const openTrailer = (id) => {
    const params = new URLSearchParams();
    params.set('editorJob', id);
    params.set('clip', '0');
    window.location.search = params.toString();
  };

  const phase = phaseFromLogs(logs);
  const submitDisabled =
    !acknowledged || sonioxBlocked || submitting || (mode === 'url' && !url) || (mode === 'file' && !file);

  return (
    <div className="min-h-screen bg-background text-fg selection:bg-primary/30">
      {/* Header */}
      <header className="h-14 border-b border-edge bg-background flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <a
            href="#app"
            className="flex items-center gap-2 text-sm text-muted hover:text-fg transition-colors"
          >
            <ArrowLeft size={16} />
            <span>Back</span>
          </a>
          <span className="text-edge">/</span>
          <span className="flex items-center gap-2 text-sm font-medium text-fg">
            <Film size={16} className="text-primary" />
            Podcast Trailer
          </span>
        </div>
        {!apiKey && (
          <a
            href="#app"
            className="text-xs text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1 rounded-full border border-amber-500/30 transition-colors flex items-center gap-1.5"
          >
            <AlertTriangle size={12} />
            Gemini API Key Missing
          </a>
        )}
      </header>

      <div className="max-w-lg mx-auto px-6 py-12">
        <div className="mb-8">
          <h1 className="text-3xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
            Podcast Trailer
          </h1>
          <p className="text-zinc-400 mt-2 leading-relaxed">
            Turn a full podcast episode into one gripping cold-open trailer. The AI scripts the best
            moments into a coherent Diary-of-a-CEO-style story that ends on a cliffhanger — then drops
            you into the editor to fine-tune.
          </p>
        </div>

        {!apiKey && (
          <div className="mb-6 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-amber-200">
              <KeyRound size={16} className="shrink-0 text-amber-400" />
              <span>
                <span className="font-semibold">Gemini API key required.</span>{' '}
                <span className="text-amber-200/80">Set it in Settings on the main app first.</span>
              </span>
            </div>
            <a
              href="#app"
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-colors"
            >
              Settings
            </a>
          </div>
        )}

        <div className="bg-surface border border-edge rounded-xl p-5 animate-[fadeIn_0.6s_ease-out]">
          <div className="flex gap-5 mb-5 border-b border-edge pb-3 text-sm">
            <button
              type="button"
              onClick={() => setMode('url')}
              className={`flex items-center gap-2 pb-2 transition-all ${
                mode === 'url' ? 'text-fg border-b-2 border-fg -mb-[14px]' : 'text-muted hover:text-fg'
              }`}
            >
              <Youtube size={17} />
              YouTube URL
            </button>
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center gap-2 pb-2 transition-all ${
                mode === 'file' ? 'text-fg border-b-2 border-fg -mb-[14px]' : 'text-muted hover:text-fg'
              }`}
            >
              <Upload size={17} />
              Upload File
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {mode === 'url' ? (
              <div className="space-y-4">
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="input-field"
                  required
                />
              </div>
            ) : (
              <div
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
                  file ? 'border-primary/50 bg-primary/5' : 'border-zinc-700 hover:border-zinc-500 bg-white/5'
                }`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
              >
                {file ? (
                  <div className="space-y-3 text-white">
                    <div className="flex items-center justify-center gap-3 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-left">
                      <FileVideo size={16} className="text-primary shrink-0" />
                      <span className="font-medium text-sm truncate flex-1">{file.name}</span>
                      <span className="text-xs text-zinc-500 shrink-0">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button
                        type="button"
                        onClick={() => setFile(null)}
                        className="p-1 hover:bg-white/10 rounded-full shrink-0"
                        aria-label={`Remove ${file.name}`}
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <label className="inline-flex cursor-pointer text-xs text-zinc-400 hover:text-white">
                      <input
                        type="file"
                        accept="video/*"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                      Choose a different video
                    </label>
                  </div>
                ) : (
                  <label className="cursor-pointer block">
                    <input
                      type="file"
                      accept="video/*"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="hidden"
                    />
                    <Upload className="mx-auto mb-3 text-zinc-500" size={24} />
                    <p className="text-zinc-400">Click to upload a podcast or drag and drop</p>
                    <p className="text-xs text-zinc-600 mt-1">One MP4 or MOV file</p>
                  </label>
                )}
              </div>
            )}

            <label className="block mt-5">
              <span className="block text-xs font-medium text-zinc-400 mb-2">Aspect ratio</span>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="input-field cursor-pointer"
              >
                {ASPECT_RATIOS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block mt-5">
              <span className="block text-xs font-medium text-zinc-400 mb-2">Length &amp; pace</span>
              <select
                value={pace}
                onChange={(e) => setPace(e.target.value)}
                className="input-field cursor-pointer"
              >
                {PACES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="block text-[11px] text-zinc-500 mt-2">
                All follow the DOAC story arc — longer just holds more beats, not slower ones.
              </span>
            </label>

            <label className="flex items-start gap-2.5 mt-5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={smartPlacement}
                onChange={(e) => setSmartPlacement(e.target.checked)}
                className="mt-0.5 accent-primary cursor-pointer"
              />
              <span>
                <span className="block text-xs font-medium text-zinc-300">Cinematic captions</span>
                <span className="block text-[11px] text-zinc-500 mt-0.5">
                  Vary caption placement per shot — beside the speaker or at the bottom — for a
                  composed, produced feel. Works on wide / square formats (16:9, 1:1); 9:16 stays at
                  the bottom.
                </span>
              </span>
            </label>

            <label className="block mt-5">
              <span className="block text-xs font-medium text-zinc-400 mb-2">Transcription</span>
              <select
                value={transcriptionEngine === 'soniox' ? 'soniox' : `whisper:${whisperModel}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === 'soniox') {
                    setTranscriptionEngine('soniox');
                  } else {
                    setTranscriptionEngine('whisper');
                    setWhisperModel(v.split(':')[1]);
                  }
                }}
                className="input-field cursor-pointer"
              >
                <optgroup label="Built-in · runs free on the server">
                  {WHISPER_MODELS.map((model) => (
                    <option key={model.value} value={`whisper:${model.value}`}>
                      {model.label} - {model.help}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Soniox · best for multilingual (Arabic, etc.) · needs API key">
                  <option value="soniox">Soniox v5 - catches multiple languages in one video</option>
                </optgroup>
              </select>
              {transcriptionEngine === 'soniox' && !sonioxKey && (
                <span className="block text-[11px] text-amber-400/90 mt-2">
                  Add your Soniox API key in Settings (main app) to use this engine.
                </span>
              )}
            </label>

            <label className="flex items-start gap-2 mt-5 text-xs text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 accent-primary cursor-pointer"
              />
              <span>
                I confirm I own this content or have the rights to process it. I am responsible for any
                content I submit. See our{' '}
                <a
                  href="/#legal"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Terms & Privacy
                </a>
                .
              </span>
            </label>

            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full mt-4 py-3 rounded-lg bg-fg text-[#18181b] font-medium text-sm hover:bg-white active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              <Film size={16} />
              Generate trailer
            </button>
          </form>
        </div>

        {projects.length > 0 && (
          <div className="mt-8">
            <div className="text-sm text-zinc-400 mb-3">Recent trailers ({projects.length})</div>
            <div className="space-y-2">
              {projects.map((p) => {
                const done = p.status === 'completed' || p.status === 'complete';
                const failed = p.status === 'error' || p.status === 'expired';
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-3 bg-surface border border-edge rounded-lg px-3 py-2.5 ${done ? 'cursor-pointer hover:border-zinc-600' : ''}`}
                    onClick={done ? () => openTrailer(p.id) : undefined}
                  >
                    <Film size={15} className="shrink-0 text-primary" />
                    <span className="flex-1 truncate text-sm text-zinc-200">
                      {(p.title || 'Trailer').replace(/^Trailer · /, '')}
                    </span>
                    <span
                      className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${
                        done
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : failed
                          ? 'bg-red-500/15 text-red-300'
                          : 'bg-amber-500/15 text-amber-300'
                      }`}
                    >
                      {done ? 'Ready' : failed ? 'Failed' : 'Processing…'}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove trailer"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm('Delete this trailer? This permanently deletes the project and its files.')) return;
                        let res;
                        try { res = await fetch(getApiUrl(`/api/jobs/${p.id}`), { method: 'DELETE' }); }
                        catch { /* offline / already gone — drop the local card below */ }
                        if (res && res.status === 409) {
                          window.alert('This trailer is still processing — you can delete it once it finishes.');
                          return;
                        }
                        removeProject(p.id);
                        setProjects(getProjects().filter(isTrailerProject));
                      }}
                      className="shrink-0 p-1 rounded text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100"
                    >
                      <X size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <ProcessingModal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="Podcast Trailer"
        logs={logs}
        status={status}
        phase={phase}
        onViewClips={() => {
          if (jobId) {
            const params = new URLSearchParams();
            params.set('editorJob', jobId);
            params.set('clip', '0');
            window.location.search = params.toString();
          }
        }}
      />
    </div>
  );
}
