import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileVideo, Sparkles, Scissors, Youtube, Instagram, Share2, LogOut, ChevronDown, Check, Activity, LayoutDashboard, Settings, PlusCircle, History, Menu, X, Terminal, Shield, LayoutGrid, Image, Globe, RotateCcw, Calendar, AlertTriangle, KeyRound, Bot, Users, Smartphone, ExternalLink, Copy, CheckCircle2, Trash2, Film } from 'lucide-react';
import KeyInput from './components/KeyInput';
import MediaInput from './components/MediaInput';
import ResultCard from './components/ResultCard';
import { GhostClipCard, SkeletonClipCard } from './components/GenerateMoreCards';
import ThumbnailStudio from './components/ThumbnailStudio';
import ScheduleWeekModal from './components/ScheduleWeekModal';
import SocialCalendar from './components/SocialCalendar';
import ProcessingModal from './components/ProcessingModal';
import EditorView from './components/editor/EditorView';
import { getProjects, addProject, updateProject, removeProject, phaseFromLogs, titleFromPayload, thumbFromPayload, coverFromString, fetchVideoTitle, captureVideoFrame, isTrailerProject } from './lib/projectHistory';
import { getApiUrl } from './config';

// Enhanced "Encryption" using XOR + Base64 with a Salt
// This is better than plain Base64 but still client-side.
const SECRET_KEY = import.meta.env.VITE_ENCRYPTION_KEY || "OpenShorts-Static-Salt-Change-Me";
const ENCRYPTION_PREFIX = "ENC:";

const encrypt = (text) => {
  if (!text) return '';
  try {
    const xor = text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
    ).join('');
    return ENCRYPTION_PREFIX + btoa(xor);
  } catch (e) {
    console.error("Encryption failed", e);
    return text;
  }
};

const decrypt = (text) => {
  if (!text) return '';
  if (text.startsWith(ENCRYPTION_PREFIX)) {
    try {
      const raw = text.slice(ENCRYPTION_PREFIX.length);
      // Check if it's plain base64 or our custom XOR (simple try)
      const xor = atob(raw);
      const result = xor.split('').map((c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length))
      ).join('');
      return result;
    } catch (e) {
      // Fallback if decryption fails (might be old plain text)
      return '';
    }
  }
  // Backward compatibility: If no prefix, assume old plain text (or return empty if you want to force re-login)
  // For migration: Return text as is, so it populates the field, and next save will encrypt it.
  return text;
};

// Simple TikTok icon sine Lucide might not have it or it varies
const TikTokIcon = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z" />
  </svg>
);

const SESSION_KEY = 'openshorts_session';
const LEGACY_SESSION_KEY = 'openshorts_session_v1';
// Remembers the last recovered jobId we greeted, so the "session recovered"
// banner shows at most once per job instead of on every in-app navigation that
// remounts the App view. localStorage (not sessionStorage) so it survives the
// app's page reloads.
const RECOVERY_GREETED_KEY = 'openshorts_recovery_greeted';
// Sanity backstop for a genuinely ancient localStorage blob (e.g. months-old
// browser tab) — NOT a job-expiry timer. The server is the source of truth for
// whether a job still exists (see pollJob's 404/410 -> JobExpiredError below);
// projects are kept until you delete them, so this no longer mirrors any
// server-side retention window.
const SESSION_MAX_AGE = 30 * 24 * 3600000; // 30 days
const MAX_POLL_FAILURES = 5;

const formatJobDuration = (seconds) => {
  if (seconds == null || Number.isNaN(Number(seconds))) return null;
  const total = Math.max(0, Math.round(Number(seconds)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};

class JobExpiredError extends Error {
  constructor(message = 'Job expired') {
    super(message);
    this.name = 'JobExpiredError';
  }
}

const pollJob = async (jobId) => {
  const res = await fetch(getApiUrl(`/api/status/${jobId}`));
  if (res.status === 404 || res.status === 410) {
    throw new JobExpiredError('Job expired or server restarted');
  }
  if (!res.ok) throw new Error(`Status check failed (${res.status})`);
  return res.json();
};

function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_key') || '');
  // Social API State (Zernio) - Load encrypted or plain
  const [zernioKey, setZernioKey] = useState(() => {
    const stored = localStorage.getItem('zernioKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });
  // ElevenLabs API State - Load encrypted
  const [elevenLabsKey, setElevenLabsKey] = useState(() => {
    const stored = localStorage.getItem('elevenLabsKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });
  // Soniox API State - Load encrypted (multilingual transcription engine)
  const [sonioxKey, setSonioxKey] = useState(() => {
    const stored = localStorage.getItem('soniox_key_v1');
    if (stored) return decrypt(stored);
    return '';
  });

  const [socialAccounts, setSocialAccounts] = useState([]); // [{id, platform, username, displayName}]
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, complete, error
  const [results, setResults] = useState(null);
  const [sortBy, setSortBy] = useState('score'); // 'score' | 'order'
  const [logs, setLogs] = useState([]);
  const [processingMedia, setProcessingMedia] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard'); // dashboard, settings

  const [sessionRecovered, setSessionRecovered] = useState(false);
  const [showScheduleWeek, setShowScheduleWeek] = useState(false);
  const [projects, setProjects] = useState(() => getProjects());
  const [showProcessingModal, setShowProcessingModal] = useState(false);
  const [viewingResults, setViewingResults] = useState(false);
  const [generatingMore, setGeneratingMore] = useState(false);
  const [moreClipsNotice, setMoreClipsNotice] = useState('');
  // Auto-dismiss the inline notice, with cleanup so a fast unmount or a new
  // notice can't leave a stray timer that clears the wrong message.
  useEffect(() => {
    if (!moreClipsNotice) return;
    const timer = setTimeout(() => setMoreClipsNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [moreClipsNotice]);
  const [openClip, setOpenClip] = useState(null);
  const [editingClip, setEditingClip] = useState(null); // clip index being edited in EditorView
  const [processingJobIds, setProcessingJobIds] = useState(() => (
    getProjects().filter((p) => p.status === 'processing').map((p) => p.id)
  ));
  const pollFailureCounts = useRef({});
  const fallbackDurationSeconds = (id) => {
    const project = getProjects().find((p) => p.id === id);
    return project?.createdAt ? (Date.now() - project.createdAt) / 1000 : null;
  };

  // Sync state for original video playback
  const [_syncedTime, setSyncedTime] = useState(0);
  const [_isSyncedPlaying, setIsSyncedPlaying] = useState(false);
  const [_syncTrigger, setSyncTrigger] = useState(0);

  const handleClipPlay = (startTime) => {
    setSyncedTime(startTime);
    setIsSyncedPlaying(true);
    setSyncTrigger(prev => prev + 1);
  };

  const handleClipPause = () => {
    setIsSyncedPlaying(false);
  };

  // Session Recovery: Restore on mount
  useEffect(() => {
    localStorage.removeItem(LEGACY_SESSION_KEY);

    let cancelled = false;
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const session = JSON.parse(saved);
      if (Date.now() - session.timestamp > SESSION_MAX_AGE) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      if (session.jobId && session.status && session.status !== 'idle') {
        pollJob(session.jobId)
          .then((data) => {
            if (cancelled) return;
            setJobId(session.jobId);
            setResults(data.result || session.results || null);
            if (data.logs) setLogs(data.logs);
            if (session.processingMedia) setProcessingMedia(session.processingMedia);
            if (session.activeTab) setActiveTab(session.activeTab);
            setStatus(data.status === 'completed' ? 'complete' : data.status === 'failed' ? 'error' : 'processing');
            const recoveredDone = data.status === 'completed' || data.status === 'failed';
            setProjects(updateProject(session.jobId, {
              durationSeconds: data.duration_seconds ?? (recoveredDone ? fallbackDurationSeconds(session.jobId) : null),
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
            // Greet with the "recovered" banner at most once per recovered
            // job. The App view remounts on every in-app navigation (switching
            // pages, closing the editor) and re-runs this restore, so without a
            // guard the banner flashes each time even though nothing was lost.
            // We track the greeted job in localStorage (which reliably persists
            // across this app's reloads/navigations — sessionStorage did not).
            // Guard the storage calls so a throw can't fall through to the
            // .catch below and wrongly delete the saved session.
            try {
              if (localStorage.getItem(RECOVERY_GREETED_KEY) !== session.jobId) {
                localStorage.setItem(RECOVERY_GREETED_KEY, session.jobId);
                setSessionRecovered(true);
                setTimeout(() => setSessionRecovered(false), 5000);
              }
            } catch {
              // storage unavailable — skip the banner rather than risk the session
            }
          })
          .catch((e) => {
            if (cancelled) return;
            localStorage.removeItem(SESSION_KEY);
            if (e instanceof JobExpiredError) {
              setProjects(updateProject(session.jobId, { status: 'expired' }));
              setProcessingJobIds((ids) => ids.filter((id) => id !== session.jobId));
            }
          });
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Session Recovery: Save state changes
  useEffect(() => {
    if (status === 'idle') {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    try {
      const sessionData = {
        jobId,
        status,
        results,
        processingMedia: processingMedia?.type === 'url' ? processingMedia : null,
        activeTab,
        timestamp: Date.now()
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
    } catch (e) {
      // localStorage full or serialization error - ignore
    }
  }, [jobId, status, results, activeTab]);

  // Backfill real video titles for projects whose title is still a raw URL
  // (e.g. created before title-resolution existed, or the active job).
  useEffect(() => {
    getProjects().forEach((p) => {
      const looksLikeUrl = /youtu\.?be|\/watch|\/shorts\//.test(p.title || '') || p.src;
      if (!looksLikeUrl) return;
      fetchVideoTitle({ type: 'url', payload: p.src || p.title }).then((t) => {
        if (t && t !== p.title) setProjects(updateProject(p.id, { title: t }));
      });
    });
  }, []);

  useEffect(() => {
    // Encrypt Gemini Key too for consistency if desired, but user asked specifically about Social integration not saving well.
    // For now keeping gemini plain for compatibility unless requested.
    if (apiKey) localStorage.setItem('gemini_key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    if (zernioKey) {
      localStorage.setItem('zernioKey_v1', encrypt(zernioKey));
    }
  }, [zernioKey]);

  useEffect(() => {
    if (elevenLabsKey) {
      localStorage.setItem('elevenLabsKey_v1', encrypt(elevenLabsKey));
    }
  }, [elevenLabsKey]);

  useEffect(() => {
    if (sonioxKey) {
      localStorage.setItem('soniox_key_v1', encrypt(sonioxKey));
    } else {
      localStorage.removeItem('soniox_key_v1');
    }
  }, [sonioxKey]);

  useEffect(() => {
    // Refetch on every key change so a swapped key never leaves stale account IDs.
    if (zernioKey) {
      fetchSocialAccounts();
    } else {
      setSocialAccounts([]);
    }
  }, [zernioKey]);

  useEffect(() => {
    if (status === 'processing' && jobId) {
      setProcessingJobIds((ids) => ids.includes(jobId) ? ids : [...ids, jobId]);
    }
  }, [status, jobId]);

  useEffect(() => {
    if (processingJobIds.length === 0) return;

    let cancelled = false;
    const pollProcessingJobs = async () => {
      const nextIds = [];

      for (const id of processingJobIds) {
        try {
          const data = await pollJob(id);
          if (cancelled) return;
          console.log("Job status:", id, data);

          if (id === jobId) {
            if (data.result) setResults(data.result);
            if (data.logs) setLogs(data.logs);
          }

          if (data.status === 'completed') {
            setProjects(updateProject(id, {
              status: 'complete',
              clipCount: data.result?.clips?.length || 0,
              cost: data.result?.cost_analysis?.total_cost ?? null,
              durationSeconds: data.duration_seconds ?? fallbackDurationSeconds(id),
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
            if (id === jobId) {
              setStatus('complete');
              if (data.result) setResults(data.result);
              setGeneratingMore(false);
            }
          } else if (data.status === 'failed') {
            setProjects(updateProject(id, {
              status: 'failed',
              durationSeconds: data.duration_seconds ?? fallbackDurationSeconds(id),
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
            if (id === jobId) {
              setStatus('error');
              setGeneratingMore(false);
              const errorMsg = data.error || (data.logs && data.logs.length > 0 ? data.logs[data.logs.length - 1] : "Process failed");
              setLogs(prev => [...prev, "Error: " + errorMsg]);
            }
          } else {
            setProjects(updateProject(id, {
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
            nextIds.push(id);
          }
        } catch (e) {
          if (e instanceof JobExpiredError) {
            console.warn("Dropping expired job", id);
            setProjects(updateProject(id, { status: 'expired' }));
            delete pollFailureCounts.current[id];
            if (id === jobId) {
              setStatus('idle');
              setJobId(null);
              setResults(null);
              setLogs(["This recovered job expired or the backend restarted. Start a new job when you're ready."]);
              setProcessingMedia(null);
              localStorage.removeItem(SESSION_KEY);
            }
          } else {
            const failures = (pollFailureCounts.current[id] || 0) + 1;
            pollFailureCounts.current[id] = failures;
            console.warn("Polling temporarily failed", id, e);
            if (failures < MAX_POLL_FAILURES) {
              nextIds.push(id);
            } else {
              setProjects(updateProject(id, { status: 'expired' }));
              delete pollFailureCounts.current[id];
              if (id === jobId) {
                setStatus('error');
                setLogs(prev => [...prev, "Backend is not reachable. Polling paused so the app does not spam requests."]);
                localStorage.removeItem(SESSION_KEY);
              }
            }
          }
        }
      }

      // Keep the SAME array reference when the active job set is unchanged.
      // Returning a new array every poll would re-trigger this effect (whose
      // deps include processingJobIds), which immediately re-polls — a storm
      // that re-renders the whole app as fast as fetches resolve and wedges
      // the tab. Only churn the reference when the set actually changes.
      if (!cancelled) {
        setProcessingJobIds((prev) =>
          prev.length === nextIds.length && prev.every((v, i) => v === nextIds[i])
            ? prev
            : nextIds
        );
      }
    };

    pollProcessingJobs();
    const interval = setInterval(pollProcessingJobs, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [processingJobIds, jobId]);


  const fetchSocialAccounts = async () => {
    if (!zernioKey) return;
    try {
      const res = await fetch(getApiUrl('/api/social/accounts'), {
        headers: { 'X-Zernio-Key': zernioKey }
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setSocialAccounts(data.accounts || []);
    } catch (e) {
      console.warn("Zernio account fetch failed. Posting will stay disabled until the key is fixed.", e);
      setSocialAccounts([]);
    }
  };

  const connectSocialAccount = async (platform) => {
    if (!zernioKey) return;
    try {
      const res = await fetch(getApiUrl(`/api/social/connect/${platform}`), {
        headers: { 'X-Zernio-Key': zernioKey }
      });
      const data = await res.json();
      if (!res.ok || !data.authUrl) throw new Error(data.detail || 'No auth URL returned');
      window.open(data.authUrl, '_blank', 'noopener');
    } catch (e) {
      alert(`Could not start ${platform} connection: ${e.message}`);
    }
  };

  const startProcessJob = async (data, { makeActive = true } = {}) => {
    let body;
    const headers = { 'X-Gemini-Key': apiKey };
    // Soniox is bring-your-own key: only sent when that engine is selected.
    if (data.transcriptionEngine === 'soniox' && sonioxKey) {
      headers['X-Soniox-Key'] = sonioxKey;
    }

    // Optional clip controls (omit when unset so the backend keeps its defaults).
    const clip = {};
    if (data.minClipLength != null) clip.min_clip_length = data.minClipLength;
    if (data.maxClipLength != null) clip.max_clip_length = data.maxClipLength;
    if (data.momentPrompt) clip.moment_prompt = data.momentPrompt;
    if (data.skipAnalysis) clip.skip_analysis = true;
    if (data.trimStart != null) clip.trim_start = data.trimStart;
    if (data.trimEnd != null) clip.trim_end = data.trimEnd;
    if (data.aspectRatio) clip.aspect_ratio = data.aspectRatio;

    if (data.type === 'url') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ url: data.payload, acknowledged: !!data.acknowledged, whisper_model: data.whisperModel, transcription_engine: data.transcriptionEngine, ...clip });
    } else {
      const formData = new FormData();
      formData.append('file', data.payload);
      formData.append('acknowledged', data.acknowledged ? 'true' : 'false');
      formData.append('whisper_model', data.whisperModel);
      formData.append('transcription_engine', data.transcriptionEngine || 'whisper');
      Object.entries(clip).forEach(([k, v]) => formData.append(k, String(v)));
      body = formData;
    }

    const res = await fetch(getApiUrl('/api/process'), {
      method: 'POST',
      // For file uploads the browser sets Content-Type (multipart boundary), so
      // only forward the auth headers — including X-Soniox-Key when present.
      headers: data.type === 'url' ? headers : { 'X-Gemini-Key': apiKey, ...(headers['X-Soniox-Key'] ? { 'X-Soniox-Key': headers['X-Soniox-Key'] } : {}) },
      body
    });

    if (!res.ok) throw new Error(await res.text());
    const resData = await res.json();
    const newId = resData.job_id;

    setProjects(addProject({
      id: newId,
      title: titleFromPayload(data),
      type: data.type,
      model: data.whisperModel,
      thumb: thumbFromPayload(data),
      startedAt: Date.now(),
      src: data.type === 'url' ? data.payload : null,
    }));
    setProcessingJobIds((ids) => ids.includes(newId) ? ids : [...ids, newId]);

    if (makeActive) {
      setJobId(newId);
      setStatus('processing');
      setLogs([`Queued ${titleFromPayload(data)}...`]);
      setResults(null);
      setProcessingMedia(data);
    }

    // Enrich asynchronously: real video title + (for files) a cover frame.
    fetchVideoTitle(data).then((t) => { if (t) setProjects(updateProject(newId, { title: t })); });
    if (data.type === 'file') {
      captureVideoFrame(data.payload).then((th) => { if (th) setProjects(updateProject(newId, { thumb: th })); });
    }

    return newId;
  };

  // Generate more clips for the currently-open, completed project. The backend
  // re-runs viral detection on the saved transcript and appends new clips; the
  // existing poll loop then grows the grid (we stay on the results view — no
  // global 'processing' status swap).
  const handleGenerateMore = async () => {
    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }
    if (!jobId || generatingMore) return;
    setMoreClipsNotice('');
    setGeneratingMore(true);
    try {
      const res = await fetch(getApiUrl(`/api/jobs/${jobId}/more-clips`), {
        method: 'POST',
        headers: { 'X-Gemini-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        let detail = 'Could not generate more clips.';
        try { detail = (await res.json()).detail || detail; } catch { /* non-JSON body */ }
        // A 409 means a run is already in flight — a benign race (e.g. the
        // grid was reopened mid-run). Show a small inline notice rather than
        // an interrupting alert; the poll loop will pick the run back up.
        if (res.status === 409) {
          setGeneratingMore(false);
          setMoreClipsNotice(detail); // auto-dismissed by the effect above
          setProcessingJobIds((ids) => (ids.includes(jobId) ? ids : [...ids, jobId]));
          return;
        }
        throw new Error(detail);
      }
      setProjects(updateProject(jobId, { status: 'processing' }));
      setProcessingJobIds((ids) => (ids.includes(jobId) ? ids : [...ids, jobId]));
    } catch (e) {
      setGeneratingMore(false);
      alert(e.message || 'Could not generate more clips.');
    }
  };

  const handleProcess = async (data) => {
    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }
    setStatus('processing');
    setLogs(data.type === 'files' ? [`Starting ${data.payload.length} video jobs...`] : ["Starting process..."]);
    setResults(null);
    setProcessingMedia(data);
    setViewingResults(false);
    setShowProcessingModal(true);

    try {
      if (data.type === 'files') {
        const fileJobs = data.payload.map((file) => ({
          type: 'file',
          payload: file,
          acknowledged: data.acknowledged,
          whisperModel: data.whisperModel,
          transcriptionEngine: data.transcriptionEngine,
          minClipLength: data.minClipLength,
          maxClipLength: data.maxClipLength,
          momentPrompt: data.momentPrompt,
          skipAnalysis: data.skipAnalysis,
          trimStart: data.trimStart,
          trimEnd: data.trimEnd,
          aspectRatio: data.aspectRatio,
        }));
        for (let i = 0; i < fileJobs.length; i++) {
          await startProcessJob(fileJobs[i], { makeActive: i === 0 });
        }
        setLogs([`Queued ${fileJobs.length} videos. They will process in parallel up to the server limit.`]);
      } else {
        await startProcessJob(data, { makeActive: true });
      }
      setShowProcessingModal(true);
      return true;
    } catch (e) {
      setStatus('error');
      setLogs(l => [...l, `Error starting job: ${e.message}`]);
      return false;
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setJobId(null);
    setResults(null);
    setLogs([]);
    setProcessingMedia(null);
    setViewingResults(false);
    setShowProcessingModal(false);
    setOpenClip(null);
    setGeneratingMore(false);
    setMoreClipsNotice('');
    localStorage.removeItem(SESSION_KEY);
  };

  // Open a project from the grid: resume the active job, or restore a past one
  // from the backend (jobs live ~1h server-side).
  const openProject = async (p) => {
    if (p.id === jobId) {
      if (status === 'complete') { setViewingResults(true); setShowProcessingModal(false); }
      else {
        try {
          const data = await pollJob(p.id);
          if (data.result) setResults(data.result);
          if (data.logs) setLogs(data.logs);
          if (data.status === 'completed') {
            setStatus('complete');
            setProjects(updateProject(p.id, {
              status: 'complete',
              clipCount: data.result?.clips?.length || 0,
              cost: data.result?.cost_analysis?.total_cost ?? null,
              durationSeconds: data.duration_seconds ?? (p.createdAt ? (Date.now() - p.createdAt) / 1000 : null),
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
          } else if (data.status === 'failed') {
            setStatus('error');
            setProjects(updateProject(p.id, {
              status: 'failed',
              durationSeconds: data.duration_seconds ?? (p.createdAt ? (Date.now() - p.createdAt) / 1000 : null),
              elapsedSeconds: data.elapsed_seconds ?? null,
            }));
          } else {
            setStatus('processing');
            if (data.result?.clips?.length > 0) {
              // Still running but has baked clips: show the grid, not the log
              // modal (mirrors the restore-a-past-job path below).
              setResults(data.result);
              setViewingResults(true);
              setShowProcessingModal(false);
              setGeneratingMore((p.clipCount || 0) > 0);
              return;
            }
          }
        } catch (e) {
          console.warn('Could not refresh active project logs before opening modal', e);
        }
        setShowProcessingModal(true);
      }
      return;
    }
    try {
      const data = await pollJob(p.id);
      setJobId(p.id);
      // Switching projects clears any leftover skeleton state; the more-clips
      // partial branch below re-arms it when this project is itself mid-run.
      setGeneratingMore(false);
      setMoreClipsNotice('');
      if (data.status === 'completed' && data.result) {
        setResults(data.result);
        setStatus('complete');
        setProcessingMedia(null);
        setViewingResults(true);
        setShowProcessingModal(false);
      } else if (data.status === 'processing' || data.status === 'queued') {
        setStatus('processing');
        setLogs(data.logs || []);
        setProcessingJobIds((ids) => ids.includes(p.id) ? ids : [...ids, p.id]);
        if (data.result?.clips?.length > 0) {
          // The job is still working but already has baked clips — either a
          // "generate more" run appending to a finished project, or an
          // original run that's partway done. Either way, DON'T trap the user
          // in the processing/log view: land them on the grid with the clips
          // they already have (fully interactive) and let polling grow it.
          setResults(data.result);
          setViewingResults(true);
          setShowProcessingModal(false);
          // A prior completion (clipCount recorded) means this is a more-clips
          // run → show skeletons. A never-completed job is an original partial
          // → the grid just shows a "still processing" hint, no skeletons.
          setGeneratingMore((p.clipCount || 0) > 0);
        } else {
          // Nothing baked yet — the classic processing view is correct.
          setResults(data.result || null);
          setViewingResults(false);
          setShowProcessingModal(true);
        }
      } else {
        setResults(data.result || null);
        setStatus('complete');
        setViewingResults(true);
      }
    } catch (e) {
      if (e instanceof JobExpiredError) {
        setProjects(updateProject(p.id, { status: 'expired' }));
        setProcessingJobIds((ids) => ids.filter((id) => id !== p.id));
        alert('Could not find this project on the server. It may have been deleted, or the server restarted before it finished — try processing it again.');
      } else {
        // Network blip / 500 / etc — not evidence the project is gone, don't
        // mislabel it as expired.
        alert(`Could not open this project: ${e.message || 'unknown error'}. Check your connection and try again.`);
      }
    }
  };

  // --- UI Components ---

  const RailItem = ({ icon: Icon, label, active, onClick }) => (
    <button
      onClick={onClick}
      aria-label={label}
      className={`relative group w-10 h-10 mx-auto rounded-lg flex items-center justify-center transition-colors ${active ? 'bg-white/10 text-fg' : 'text-muted hover:text-fg hover:bg-white/5'}`}
    >
      <Icon size={20} />
      <span className="pointer-events-none absolute left-full ml-3 px-2 py-1 rounded-md bg-surface2 border border-edge text-fg text-xs whitespace-nowrap opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150 z-50 shadow-lg">
        {label}
      </span>
    </button>
  );

  const Sidebar = () => (
    <div className="w-[60px] bg-background border-r border-edge flex flex-col items-center py-4 shrink-0">
      <div className="w-9 h-9 rounded-lg overflow-hidden border border-edge mb-5 shrink-0">
        <img src="/logo-openshorts.png" alt="OpenShorts" className="w-full h-full object-cover" />
      </div>

      <nav className="flex-1 flex flex-col gap-1.5 w-full">
        <RailItem icon={Scissors} label="Clip Generator" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
        <RailItem icon={Film} label="Podcast Trailer" active={false} onClick={() => { window.location.hash = '#trailer'; }} />
        <RailItem icon={Bot} label="AI Agent" active={activeTab === 'ai-agent'} onClick={() => setActiveTab('ai-agent')} />
        <RailItem icon={Youtube} label="YouTube Studio" active={activeTab === 'thumbnails'} onClick={() => setActiveTab('thumbnails')} />
        <RailItem icon={Calendar} label="Calendar" active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} />
      </nav>

      <div className="flex flex-col gap-1.5 w-full">
        <RailItem icon={Settings} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        <RailItem icon={Globe} label="Landing page" active={false} onClick={() => { localStorage.removeItem('openshorts_skip_landing'); window.location.hash = ''; window.location.reload(); }} />
        <a
          href="https://github.com/mutonby/openshorts"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
          className="relative group w-10 h-10 mx-auto rounded-lg flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"
        >
          <svg height="20" viewBox="0 0 16 16" version="1.1" width="20" aria-hidden="true" fill="currentColor"><path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
          <span className="pointer-events-none absolute left-full ml-3 px-2 py-1 rounded-md bg-surface2 border border-edge text-fg text-xs whitespace-nowrap opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-150 z-50 shadow-lg">GitHub</span>
        </a>
      </div>
    </div>
  );

  const ShortcutItem = ({ icon: Icon, color, label, onClick }) => (
    <button onClick={onClick} className="group flex flex-col items-center gap-2.5 text-muted hover:text-fg transition-colors">
      <span className={`w-14 h-14 rounded-full bg-surface border border-edge flex items-center justify-center ${color} group-hover:border-white/20 transition-colors`}>
        <Icon size={22} />
      </span>
      <span className="text-xs">{label}</span>
    </button>
  );

  const ProjectCard = ({ p }) => {
    const isActive = p.id === jobId;
    const proc = p.status === 'processing';
    const failed = p.status === 'failed';
    const expired = p.status === 'expired';
    const phase = isActive ? phaseFromLogs(logs) : 'Processing';
    const durationLabel = formatJobDuration(
      p.durationSeconds ?? p.elapsedSeconds ?? (proc && p.createdAt ? (Date.now() - p.createdAt) / 1000 : null)
    );
    const cover = p.thumb || coverFromString(p.src || p.title);
    const handleDelete = async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete "${p.title}"? This permanently deletes the project and its files.`)) return;
      let res;
      try { res = await fetch(getApiUrl(`/api/jobs/${p.id}`), { method: 'DELETE' }); }
      catch { /* offline / already gone — drop the local card below */ }
      if (res && res.status === 409) {
        window.alert("This project is still processing — you can delete it once it finishes.");
        return; // keep the card; server refused to delete a running job
      }
      setProjects(removeProject(p.id));
    };
    return (
      <div className="text-left group relative">
        <button onClick={() => openProject(p)} className="text-left w-full block">
        <div className="relative aspect-video rounded-lg overflow-hidden bg-black border border-edge flex items-center justify-center">
          {cover ? (
            <img src={cover} alt="" className="absolute inset-0 w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ) : (
            <Scissors size={20} className="text-zinc-700" />
          )}
          {proc && (
            <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
              <span className="flex items-center gap-2 bg-black/60 border border-viral/50 text-viral text-xs px-2.5 py-1.5 rounded-lg">
                <span className="w-3 h-3 rounded-full border-2 border-viral/30 border-t-viral animate-spin" />
                {phase}…
              </span>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
              <span className="flex items-center gap-1.5 text-red-400 text-xs"><AlertTriangle size={13} /> Failed</span>
            </div>
          )}
          {expired && (
            <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
              <span className="flex items-center gap-1.5 text-zinc-300 text-xs"><AlertTriangle size={13} /> Expired</span>
            </div>
          )}
        </div>
        <div className="mt-2">
          <div className="text-xs text-fg truncate group-hover:text-white transition-colors">{p.title}</div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-muted">
              {proc ? 'Processing' : failed ? 'Failed' : expired ? 'Expired' : `${p.clipCount} clip${p.clipCount === 1 ? '' : 's'}`}
              {durationLabel ? ` · ${proc ? 'running ' : ''}${durationLabel}` : ''}
            </span>
            {p.cost != null && (
              <span className="text-[10px] text-muted bg-surface2 px-1.5 py-0.5 rounded">${p.cost.toFixed(3)}</span>
            )}
          </div>
        </div>
        </button>
        <button
          onClick={handleDelete}
          title="Delete project"
          aria-label="Delete project"
          className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 border border-edge text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 hover:border-red-400/50 transition-all"
        >
          <Trash2 size={14} />
        </button>
      </div>
    );
  };

  const activeProject = projects.find((p) => p.id === jobId);
  const activeDuration = formatJobDuration(
    activeProject?.durationSeconds ??
    activeProject?.elapsedSeconds ??
    (activeProject?.createdAt ? (Date.now() - activeProject.createdAt) / 1000 : null)
  );

  // Is the currently-open job still doing work in the background (an original
  // run finishing, or a "generate more" pass)? Drives the grid's ghost/skeleton
  // tiles and the "still processing" hint without hijacking the whole view.
  const openJobBusy = !!jobId && processingJobIds.includes(jobId);

  return (
    <div className="flex h-screen bg-background overflow-hidden selection:bg-primary/30">
      <Sidebar />

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Top Header */}
        <header className="h-14 border-b border-edge bg-background flex items-center justify-between px-6 shrink-0 z-10">
          <div className="flex items-center gap-4">
            {status !== 'idle' && (
              <button
                onClick={handleReset}
                className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
              >
                <PlusCircle size={16} />
                <span className="hidden sm:inline">New Project</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-4">
            {socialAccounts.length > 0 && (
              <button
                onClick={() => setActiveTab('calendar')}
                className="flex items-center gap-2 bg-surface border border-white/10 rounded-lg px-3 py-2 text-xs text-zinc-300 hover:bg-white/5 transition-colors"
                title="View connected accounts & calendar"
              >
                <Users size={14} className="text-primary" />
                {socialAccounts.length} account{socialAccounts.length === 1 ? '' : 's'} connected
              </button>
            )}

            {!apiKey && (
              <button
                onClick={() => setActiveTab('settings')}
                className="text-xs text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-3 py-1 rounded-full border border-amber-500/30 transition-colors flex items-center gap-1.5"
                title="Click to configure your API keys"
              >
                <AlertTriangle size={12} />
                Gemini API Key Missing
              </button>
            )}
          </div>
        </header>

        {/* Persistent Missing Keys Banner — visible on every screen */}
        {!apiKey && activeTab !== 'settings' && (
          <div className="mx-6 mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center justify-between gap-4 shrink-0 animate-[fadeIn_0.3s_ease-out]">
            <div className="flex items-center gap-3 text-sm text-amber-200">
              <KeyRound size={16} className="shrink-0 text-amber-400" />
              <div>
                <span className="font-semibold">Gemini API key required.</span>{' '}
                <span className="text-amber-200/80">
                  Set your Gemini API key to generate clips. Zernio is only needed for social publishing.
                </span>
              </div>
            </div>
            <button
              onClick={() => setActiveTab('settings')}
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black transition-colors"
            >
              Go to Settings
            </button>
          </div>
        )}

        {/* Session Recovery Banner */}
        {sessionRecovered && (
          <div className="mx-6 mt-2 p-3 bg-primary/10 border border-primary/20 rounded-xl flex items-center justify-between animate-[fadeIn_0.3s_ease-out] shrink-0">
            <div className="flex items-center gap-2 text-sm text-primary">
              <RotateCcw size={16} />
              <span className="font-medium">Session recovered</span>
              <span className="text-zinc-400 text-xs">Your previous work has been restored.</span>
            </div>
            <button onClick={() => setSessionRecovered(false)} className="text-zinc-500 hover:text-white transition-colors">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex-1 overflow-hidden relative">

          {/* View: Settings */}
          {activeTab === 'settings' && (
            <div className="h-full overflow-y-auto p-8 max-w-2xl mx-auto animate-[fadeIn_0.3s_ease-out]">
              <div className="flex items-center justify-between mb-8">
                <h1 className="text-2xl font-bold">Settings</h1>
                <div className="px-3 py-1 bg-green-500/10 border border-green-500/20 rounded-full text-[10px] text-green-400 font-medium flex items-center gap-2">
                  <Shield size={12} /> Privacy: keys only live in your browser (sent to backend just to process)
                </div>
              </div>
              <KeyInput onKeySet={setApiKey} savedKey={apiKey} />

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Social Integration</h2>
                  <span className="text-[10px] bg-zinc-500/10 border border-white/10 px-2 py-0.5 rounded text-zinc-400 uppercase tracking-wider">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Add a <strong>Zernio</strong> key only if you want to publish or schedule clips to TikTok, Instagram Reels, YouTube Shorts and more directly from OpenShorts.
                  Clip generation works without it.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">Zernio API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={zernioKey}
                      onChange={(e) => setZernioKey(e.target.value)}
                      className="input-field"
                      placeholder="zern_..."
                    />
                    <button onClick={fetchSocialAccounts} className="btn-primary py-2 px-4 text-sm">
                      Connect
                    </button>
                  </div>

                  {zernioKey && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-zinc-400">Connected accounts</span>
                        <button onClick={fetchSocialAccounts} className="text-xs text-zinc-500 hover:text-white transition-colors flex items-center gap-1">
                          <RotateCcw size={11} /> Refresh
                        </button>
                      </div>
                      {socialAccounts.length === 0 ? (
                        <p className="text-xs text-zinc-600">No accounts connected yet. Use the buttons below — a Zernio window opens to authorize the platform, then hit Refresh.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {socialAccounts.map((acc) => (
                            <div key={acc.id} className="flex items-center gap-2.5 p-2 border border-white/5 rounded-lg text-xs">
                              {acc.platform === 'tiktok' ? <TikTokIcon size={13} className="text-zinc-300" /> :
                               acc.platform === 'instagram' ? <Instagram size={13} className="text-pink-400" /> :
                               acc.platform === 'youtube' ? <Youtube size={13} className="text-red-400" /> :
                               <Globe size={13} className="text-zinc-400" />}
                              <span className="text-zinc-200 font-medium">{acc.displayName || acc.username}</span>
                              <span className="text-zinc-600 capitalize">{acc.platform}</span>
                              {acc.isActive && <Check size={12} className="text-green-400 ml-auto" />}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                        {/* Pinterest omitted: Zernio needs a per-post board id we don't collect yet */}
                        {['tiktok', 'instagram', 'youtube', 'facebook', 'twitter', 'linkedin', 'threads'].map((p) => (
                          <button
                            key={p}
                            onClick={() => connectSocialAccount(p)}
                            className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors text-[11px] text-zinc-400 capitalize"
                          >
                            + {p === 'twitter' ? 'X / Twitter' : p}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your key at <a href="https://zernio.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">zernio.com</a>.
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. They are sent to the backend only to process your request, never stored server-side.
                    </span>
                  </p>
                </div>
              </div>

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Video Translation</h2>
                  <span className="text-[10px] bg-white/5 border border-white/5 px-2 py-0.5 rounded text-zinc-500 uppercase tracking-wider">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Translate your clips to different languages using <strong>ElevenLabs</strong> AI dubbing.
                  Automatically translates speech while preserving the original voice characteristics.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">ElevenLabs API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={elevenLabsKey}
                      onChange={(e) => setElevenLabsKey(e.target.value)}
                      className="input-field"
                      placeholder="sk_..."
                    />
                    <button
                      onClick={() => {
                        if (elevenLabsKey) {
                          localStorage.setItem('elevenLabsKey_v1', encrypt(elevenLabsKey));
                          alert('ElevenLabs API Key saved!');
                        }
                      }}
                      className="btn-primary py-2 px-4 text-sm"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your API key from ElevenLabs to enable video translation.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a href="https://elevenlabs.io/sign-up" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Sign Up</span>
                        <span className="text-[10px] text-zinc-600">Create account</span>
                      </a>
                      <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. They are sent to the backend only to process your request, never stored server-side.
                    </span>
                  </p>
                </div>
              </div>

              <div className="glass-panel p-6 mt-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold">Transcription (Soniox)</h2>
                  <span className="text-[10px] bg-white/5 border border-white/5 px-2 py-0.5 rounded text-zinc-500 uppercase tracking-wider">Optional</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Use <strong>Soniox</strong> for transcription instead of the built-in Whisper.
                  It's far better at <strong>multilingual</strong> audio &mdash; it catches both
                  languages when someone speaks, e.g., Arabic and English in the same video.
                  Select it under "Transcription" when you start a clip.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">Soniox API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={sonioxKey}
                      onChange={(e) => setSonioxKey(e.target.value)}
                      className="input-field"
                      placeholder="soniox API key..."
                    />
                    <button
                      onClick={() => {
                        if (sonioxKey) {
                          localStorage.setItem('soniox_key_v1', encrypt(sonioxKey));
                          alert('Soniox API Key saved!');
                        }
                      }}
                      className="btn-primary py-2 px-4 text-sm"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your API key from Soniox to enable multilingual transcription.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a href="https://console.soniox.com/" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Sign Up</span>
                        <span className="text-[10px] text-zinc-600">Create account</span>
                      </a>
                      <a href="https://console.soniox.com/api-keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. They are sent to the backend only to process your request, never stored server-side.
                    </span>
                  </p>
                </div>
              </div>

            </div>
          )}

          {/* View: AI Agent */}
          {activeTab === 'ai-agent' && (
            <div className="h-full overflow-y-auto custom-scrollbar p-6 md:p-10 animate-[fadeIn_0.3s_ease-out]">
              <div className="max-w-4xl mx-auto space-y-8">

                {/* Header */}
                <div className="space-y-3">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[11px] uppercase tracking-wider text-emerald-400 font-semibold">
                    <Bot size={12} /> Autonomous Skill
                  </div>
                  <h1 className="text-3xl md:text-4xl font-black bg-gradient-to-b from-white to-white/60 bg-clip-text text-transparent">
                    Your Personal Clipping Team
                  </h1>
                  <p className="text-zinc-400 text-base md:text-lg leading-relaxed max-w-2xl">
                    Drop your videos in a folder and a team of AI clippers picks the viral moments, edits them, and queues them for your approval — like having a 24/7 short-form editing crew on autopilot.
                  </p>
                </div>

                {/* Mobile-format warning */}
                <div className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-start gap-3">
                  <Smartphone size={20} className="text-amber-400 shrink-0 mt-0.5" />
                  <div className="text-sm text-amber-100">
                    <p className="font-semibold text-amber-300 mb-1">Upload videos already in vertical (9:16) mobile format.</p>
                    <p className="text-amber-100/80 leading-relaxed">
                      The agent does not reframe horizontal footage. Make sure every source video is shot or pre-cropped to mobile/portrait format before dropping it into the input folder.
                    </p>
                  </div>
                </div>

                {/* Workflow */}
                <div className="grid md:grid-cols-3 gap-4">
                  <div className="glass-panel p-5 space-y-2">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <Upload size={18} />
                    </div>
                    <h3 className="font-semibold text-white">1. Drop your videos</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Put your long-form vertical footage in the watched folder. The skill picks one video per run.
                    </p>
                  </div>

                  <div className="glass-panel p-5 space-y-2">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <Users size={18} />
                    </div>
                    <h3 className="font-semibold text-white">2. AI clippers work</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Whisper transcribes, Gemini 3 Flash spots viral beats, FFmpeg cuts each clip and adds a hook overlay.
                    </p>
                  </div>

                  <div className="glass-panel p-5 space-y-2">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
                      <CheckCircle2 size={18} />
                    </div>
                    <h3 className="font-semibold text-white">3. You validate, it ships</h3>
                    <p className="text-xs text-zinc-400 leading-relaxed">
                      Approve the candidates you like and the skill auto-publishes them to TikTok, Reels and YouTube Shorts via Zernio.
                    </p>
                  </div>
                </div>

                {/* Repo CTA */}
                <div className="glass-panel p-6 md:p-8 space-y-5">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className="text-xl font-bold text-white mb-1">skill-autoshorts</h2>
                      <p className="text-sm text-zinc-400">
                        The Claude Code skill that powers this workflow. Install it once and trigger it whenever you want a fresh batch of clips.
                      </p>
                    </div>
                    <a
                      href="https://github.com/mutonby/skill-autoshorts"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-primary py-2 px-4 text-sm flex items-center gap-2 shrink-0"
                    >
                      View on GitHub <ExternalLink size={14} />
                    </a>
                  </div>

                  <div className="bg-[#0c0c0e] border border-white/10 rounded-lg p-4 font-mono text-xs text-zinc-300 flex items-center justify-between gap-3">
                    <span className="truncate">git clone https://github.com/mutonby/skill-autoshorts</span>
                    <button
                      onClick={() => navigator.clipboard.writeText('git clone https://github.com/mutonby/skill-autoshorts')}
                      className="text-zinc-500 hover:text-white transition-colors shrink-0"
                      title="Copy"
                    >
                      <Copy size={14} />
                    </button>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3 text-sm">
                    <div className="flex items-start gap-2 text-zinc-300">
                      <Check size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Daily batch — picks one long video per run</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-300">
                      <Check size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Whisper transcription with word-level timing</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-300">
                      <Check size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Gemini 3 Flash multimodal moment detection</span>
                    </div>
                    <div className="flex items-start gap-2 text-zinc-300">
                      <Check size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                      <span>Auto-publish to TikTok, Reels & YouTube Shorts</span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* View: Thumbnails */}
          {activeTab === 'thumbnails' && (
            <ThumbnailStudio geminiApiKey={apiKey} zernioKey={zernioKey} socialAccounts={socialAccounts} />
          )}

          {/* View: Social Calendar & Analytics */}
          {activeTab === 'calendar' && (
            <SocialCalendar
              zernioKey={zernioKey}
              accounts={socialAccounts}
              onGoToSettings={() => setActiveTab('settings')}
            />
          )}

          {/* View: Dashboard homepage (idle / processing / error) — Opus-style */}
          {activeTab === 'dashboard' && !(viewingResults && results) && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-[fadeIn_0.3s_ease-out]">
              {/* Hero: submit card over faint wordmark */}
              <div className="relative px-6 pt-20 pb-10">
                <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center overflow-hidden">
                  <span className="font-display font-semibold text-[120px] leading-none text-white/[0.035] tracking-tighter select-none whitespace-nowrap">
                    OpenShorts
                  </span>
                </div>

                <div className="relative max-w-lg mx-auto">
                  <MediaInput onProcess={handleProcess} isProcessing={status === 'processing'} hasSonioxKey={!!sonioxKey} />
                </div>

                {/* 3-tool shortcut row */}
                <div className="relative flex items-center justify-center gap-10 mt-12">
                  <ShortcutItem icon={Scissors} color="text-viral" label="Clip Generator" onClick={() => setActiveTab('dashboard')} />
                  <ShortcutItem icon={Youtube} color="text-red-300" label="YouTube Studio" onClick={() => setActiveTab('thumbnails')} />
                </div>
              </div>

              {/* Recent projects (clip jobs only — trailers live on the #trailer page) */}
              {(() => {
                const clipProjects = projects.filter((p) => !isTrailerProject(p));
                return (
              <div className="max-w-5xl mx-auto px-6 pb-14">
                <div className="flex items-center gap-4 mb-3">
                  <span className="text-sm text-fg">Recent projects {clipProjects.length > 0 && <span className="text-muted">({clipProjects.length})</span>}</span>
                </div>
                {clipProjects.length === 0 ? (
                  <div className="border border-edge rounded-lg py-12 text-center">
                    <p className="text-sm text-muted">Your generated clips will appear here.</p>
                    <p className="text-xs text-muted/60 mt-1">Drop a YouTube link or upload a video to get started.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {clipProjects.map((p) => <ProjectCard key={p.id} p={p} />)}
                  </div>
                )}
              </div>
                );
              })()}
            </div>
          )}

          {/* View: Results (clips) — shown when a completed project is opened */}
          {activeTab === 'dashboard' && viewingResults && results && (
            <div className="h-full flex flex-col animate-[fadeIn_0.3s_ease-out]">
              <div className="flex items-center gap-3 px-6 py-3.5 border-b border-edge shrink-0">
                <button onClick={handleReset} className="flex items-center gap-1.5 text-sm text-muted hover:text-fg transition-colors">
                  <PlusCircle size={16} /> New project
                </button>
                <span className="w-px h-4 bg-edge" />
                <h2 className="text-sm font-medium text-fg flex items-center gap-2">
                  <Sparkles size={16} className="text-viral" /> Generated shorts
                </h2>
                {results?.clips?.length > 0 && (
                  <span className="text-xs bg-surface2 text-muted px-2 py-0.5 rounded-full">{results.clips.length}</span>
                )}
                {results?.cost_analysis && (
                  <span className="text-xs bg-viral/10 border border-viral/20 text-viral px-2 py-0.5 rounded-full" title={`Input: ${results.cost_analysis.input_tokens} | Output: ${results.cost_analysis.output_tokens}`}>
                    ${results.cost_analysis.total_cost.toFixed(4)}
                  </span>
                )}
                {openJobBusy && (
                  <span className="flex items-center gap-1.5 text-xs bg-surface2 border border-edge text-muted px-2 py-0.5 rounded-full">
                    <RotateCcw size={11} className="animate-spin" />
                    {generatingMore ? 'Finding more clips…' : 'Still processing…'}
                  </span>
                )}
                {moreClipsNotice && (
                  <span className="text-xs bg-amber-500/10 border border-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">
                    {moreClipsNotice}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {results?.clips?.length > 1 && (
                    <div className="flex items-center rounded-lg border border-edge overflow-hidden text-xs">
                      <button
                        onClick={() => setSortBy('score')}
                        className={`px-2.5 py-1.5 transition-colors ${sortBy === 'score' ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}
                      >
                        Virality
                      </button>
                      <button
                        onClick={() => setSortBy('order')}
                        className={`px-2.5 py-1.5 border-l border-edge transition-colors ${sortBy === 'order' ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}
                      >
                        Original
                      </button>
                    </div>
                  )}
                  <button
                    onClick={handleGenerateMore}
                    disabled={generatingMore || openJobBusy}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface2 hover:bg-white/10 border border-edge text-fg rounded-lg text-xs font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {generatingMore
                      ? <><RotateCcw size={14} className="animate-spin" /> Generating…</>
                      : <><Sparkles size={14} className="text-viral" /> More clips</>}
                  </button>
                  <button
                    onClick={() => setShowProcessingModal(true)}
                    className="flex items-center gap-1.5 text-xs text-muted hover:text-fg border border-edge hover:bg-white/5 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    <Terminal size={14} /> Logs
                  </button>
                  {results?.clips?.length > 1 && (
                    <button
                      onClick={() => setShowScheduleWeek(true)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface2 hover:bg-white/10 border border-edge text-fg rounded-lg text-xs font-medium transition-colors"
                    >
                      <Calendar size={14} /> Schedule week
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                {results.clips && results.clips.length > 0 ? (
                  <div className="grid gap-x-4 gap-y-6 pb-10 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                    {results.clips
                      .map((clip, i) => ({ clip, i }))
                      .sort((a, b) => sortBy === 'score'
                        ? (Number(b.clip.virality_score) || 0) - (Number(a.clip.virality_score) || 0)
                        : a.i - b.i)
                      .map(({ clip, i }, pos, arr) => (
                      <ResultCard
                        key={i}
                        clip={clip}
                        index={i}
                        prevIndex={pos > 0 ? arr[pos - 1].i : null}
                        nextIndex={pos < arr.length - 1 ? arr[pos + 1].i : null}
                        jobId={jobId}
                        zernioKey={zernioKey}
                        socialAccounts={socialAccounts}
                        geminiApiKey={apiKey}
                        elevenLabsKey={elevenLabsKey}
                        onPlay={(time) => handleClipPlay(time)}
                        onPause={handleClipPause}
                        openIndex={openClip}
                        setOpenIndex={setOpenClip}
                        totalClips={results.clips.length}
                        onEdit={(clipIndex) => setEditingClip(clipIndex)}
                      />
                    ))}
                    {/* Trailing tiles — rendered AFTER the sorted real cards and
                        outside the sort so they never reorder the clips. */}
                    {generatingMore ? (
                      <>
                        <SkeletonClipCard caption="Finding new moments…" />
                        <SkeletonClipCard />
                        <SkeletonClipCard />
                      </>
                    ) : !openJobBusy ? (
                      <GhostClipCard onClick={handleGenerateMore} />
                    ) : null}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-muted">
                    <p className="text-sm">No clips were generated for this project.</p>
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

      </main>

      {/* Missing API Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowKeyModal(false)}>
          <div className="bg-[#18181b] border border-white/10 rounded-2xl p-6 max-w-md w-full mx-4 space-y-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white">Gemini API Key Required</h2>
            <p className="text-sm text-zinc-400">
              OpenShorts needs a <strong className="text-zinc-200">Gemini</strong> API key to generate clips. Zernio is optional and only used for social publishing & scheduling.
            </p>

            {/* Gemini block */}
            <div className={`rounded-lg p-4 space-y-2 border ${!apiKey ? 'bg-blue-500/5 border-blue-500/30' : 'bg-white/5 border-white/10 opacity-70'}`}>
              <p className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                {apiKey ? <Check size={12} className="text-green-400" /> : <AlertTriangle size={12} className="text-amber-400" />}
                Gemini API Key {apiKey && <span className="text-green-400">— set</span>}
              </p>
              {!apiKey && (
                <>
                  <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                    <li>Go to <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">aistudio.google.com/app/apikey</a></li>
                    <li>Sign in with your Google account</li>
                    <li>Click "Create API Key"</li>
                    <li>Copy the key and paste it below</li>
                  </ol>
                  <input
                    type="text"
                    placeholder="Paste your Gemini API key here..."
                    className="w-full bg-black/50 border border-white/20 rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target.value.trim()) {
                        setApiKey(e.target.value.trim());
                      }
                    }}
                  />
                </>
              )}
            </div>

            {/* Zernio block */}
            <div className={`rounded-lg p-4 space-y-2 border ${!zernioKey ? 'bg-violet-500/5 border-violet-500/30' : 'bg-white/5 border-white/10 opacity-70'}`}>
              <p className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                {zernioKey ? <Check size={12} className="text-green-400" /> : <AlertTriangle size={12} className="text-amber-400" />}
                Zernio API Key <span className="text-zinc-500">— optional</span>{zernioKey && <span className="text-green-400">— set</span>}
              </p>
              {!zernioKey && (
                <>
                  <p className="text-xs text-zinc-400">
                    Only needed to publish or schedule your clips to TikTok, Instagram Reels, YouTube Shorts and more from this app.
                  </p>
                  <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                    <li>Register at <a href="https://zernio.com" target="_blank" rel="noopener noreferrer" className="text-violet-400 underline">zernio.com</a> and generate an API key</li>
                    <li>Paste it below, then connect your social accounts in Settings</li>
                  </ol>
                  <input
                    type="text"
                    placeholder="Paste your Zernio API key here..."
                    className="w-full bg-black/50 border border-white/20 rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target.value.trim()) {
                        setZernioKey(e.target.value.trim());
                      }
                    }}
                  />
                </>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowKeyModal(false)}
                className="flex-1 text-sm text-zinc-400 py-2 rounded-lg border border-white/10 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setShowKeyModal(false); setActiveTab('settings'); }}
                className="flex-1 text-sm text-white py-2 rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors font-medium"
              >
                Go to Settings
              </button>
            </div>
          </div>
        </div>
      )}

      <ScheduleWeekModal
        isOpen={showScheduleWeek}
        onClose={() => setShowScheduleWeek(false)}
        clips={results?.clips || []}
        jobId={jobId}
        zernioKey={zernioKey}
        socialAccounts={socialAccounts}
        onViewCalendar={() => setActiveTab('calendar')}
      />

      <ProcessingModal
        open={showProcessingModal}
        onClose={() => setShowProcessingModal(false)}
        title={processingMedia ? titleFromPayload(processingMedia) : 'Processing'}
        logs={logs}
        status={status}
        phase={phaseFromLogs(logs)}
        duration={activeDuration}
        onViewClips={() => { setShowProcessingModal(false); setViewingResults(true); }}
      />

      {editingClip !== null && results?.clips?.[editingClip] && (
        <EditorView
          clip={results.clips[editingClip]}
          index={editingClip}
          jobId={jobId}
          onClose={() => setEditingClip(null)}
          onExported={(newVideoUrl) => {
            setResults((prev) => {
              if (!prev?.clips?.[editingClip]) return prev;
              const clips = prev.clips.map((c, i) =>
                i === editingClip ? { ...c, video_url: newVideoUrl } : c
              );
              return { ...prev, clips };
            });
          }}
        />
      )}
    </div>
  );
}

export default App;
