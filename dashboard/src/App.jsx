import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileVideo, Sparkles, Scissors, Youtube, Instagram, Share2, LogOut, ChevronDown, Check, Activity, LayoutDashboard, Settings, PlusCircle, History, Menu, X, Terminal, Shield, LayoutGrid, Image, Globe, RotateCcw, Calendar, AlertTriangle, KeyRound, Bot, Users, Smartphone, ExternalLink, Copy, CheckCircle2, Trash2 } from 'lucide-react';
import KeyInput from './components/KeyInput';
import MediaInput from './components/MediaInput';
import ResultCard from './components/ResultCard';
// import Gallery from './components/Gallery';
import ThumbnailStudio from './components/ThumbnailStudio';
import SaaShortsTab from './components/SaaShortsTab';
import UGCGallery from './components/UGCGallery';
import ScheduleWeekModal from './components/ScheduleWeekModal';
import ProcessingModal from './components/ProcessingModal';
import EditorView from './components/editor/EditorView';
import { getProjects, addProject, updateProject, removeProject, phaseFromLogs, titleFromPayload, thumbFromPayload, coverFromString, fetchVideoTitle, captureVideoFrame } from './lib/projectHistory';
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

const UserProfileSelector = ({ profiles, selectedUserId, onSelect }) => {
  const [isOpen, setIsOpen] = useState(false);

  if (!profiles || profiles.length === 0) return null;

  const selectedProfile = profiles.find(p => p.username === selectedUserId) || profiles[0];

  return (
    <div className="relative z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between bg-surface border border-white/10 rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-white/5 transition-colors min-w-[180px]"
      >
        <span className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-[10px] font-bold text-white">
            {selectedProfile?.username?.substring(0, 1).toUpperCase() || "U"}
          </div>
          <span className="font-medium text-white truncate max-w-[100px]">{selectedProfile?.username || "Select User"}</span>
        </span>
        <ChevronDown size={14} className={`text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute top-full mt-2 right-0 w-64 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          <div className="max-h-60 overflow-y-auto custom-scrollbar">
            {profiles.map((profile) => (
              <button
                key={profile.username}
                onClick={() => {
                  onSelect(profile.username);
                  setIsOpen(false);
                }}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 transition-colors text-left group border-b border-white/5 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-purple-500/20 flex items-center justify-center text-xs font-bold text-white border border-white/10 shrink-0">
                    {profile.username.substring(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate">
                      {profile.username}
                    </div>
                    <div className="flex gap-2 mt-0.5">
                      {/* Status indicators */}
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('tiktok') ? 'text-zinc-300' : 'text-zinc-600'}`}>
                        <TikTokIcon size={10} />
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('instagram') ? 'text-pink-400' : 'text-zinc-600'}`}>
                        <Instagram size={10} />
                      </div>
                      <div className={`flex items-center gap-1 text-[10px] ${profile.connected.includes('youtube') ? 'text-red-400' : 'text-zinc-600'}`}>
                        <Youtube size={10} />
                      </div>
                    </div>
                  </div>
                </div>
                {selectedUserId === profile.username && <Check size={14} className="text-primary shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const SESSION_KEY = 'openshorts_session';
const LEGACY_SESSION_KEY = 'openshorts_session_v1';
const SESSION_MAX_AGE = 3600000; // 1 hour (matches server job retention)
const MAX_POLL_FAILURES = 5;

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
  // Social API State - Load encrypted or plain
  const [uploadPostKey, setUploadPostKey] = useState(() => {
    const stored = localStorage.getItem('uploadPostKey_v3');
    if (stored) return decrypt(stored);
    return '';
  });
  // ElevenLabs API State - Load encrypted
  const [elevenLabsKey, setElevenLabsKey] = useState(() => {
    const stored = localStorage.getItem('elevenLabsKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });

  // fal.ai API State - Load encrypted
  const [falKey, setFalKey] = useState(() => {
    const stored = localStorage.getItem('falKey_v1');
    if (stored) return decrypt(stored);
    return '';
  });

  const [uploadUserId, setUploadUserId] = useState(() => localStorage.getItem('uploadUserId') || '');
  const [userProfiles, setUserProfiles] = useState([]); // List of {username, connected: []}
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, complete, error
  const [results, setResults] = useState(null);
  const [logs, setLogs] = useState([]);
  const [processingMedia, setProcessingMedia] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard'); // dashboard, settings

  const [sessionRecovered, setSessionRecovered] = useState(false);
  const [showScheduleWeek, setShowScheduleWeek] = useState(false);
  const [projects, setProjects] = useState(() => getProjects());
  const [showProcessingModal, setShowProcessingModal] = useState(false);
  const [viewingResults, setViewingResults] = useState(false);
  const [openClip, setOpenClip] = useState(null);
  const [editingClip, setEditingClip] = useState(null); // clip index being edited in EditorView
  const [processingJobIds, setProcessingJobIds] = useState(() => (
    getProjects().filter((p) => p.status === 'processing').map((p) => p.id)
  ));
  const pollFailureCounts = useRef({});

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
            setSessionRecovered(true);
            setTimeout(() => setSessionRecovered(false), 5000);
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
    if (uploadPostKey) {
      localStorage.setItem('uploadPostKey_v3', encrypt(uploadPostKey));
    }
    if (uploadUserId) {
      localStorage.setItem('uploadUserId', uploadUserId);
    }
  }, [uploadPostKey, uploadUserId]);

  useEffect(() => {
    if (elevenLabsKey) {
      localStorage.setItem('elevenLabsKey_v1', encrypt(elevenLabsKey));
    }
  }, [elevenLabsKey]);

  useEffect(() => {
    if (falKey) {
      localStorage.setItem('falKey_v1', encrypt(falKey));
    }
  }, [falKey]);

  useEffect(() => {
    if (uploadPostKey && userProfiles.length === 0) {
      fetchUserProfiles();
    }
  }, [uploadPostKey]);

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
            }));
            if (id === jobId) {
              setStatus('complete');
              if (data.result) setResults(data.result);
            }
          } else if (data.status === 'failed') {
            setProjects(updateProject(id, { status: 'failed' }));
            if (id === jobId) {
              setStatus('error');
              const errorMsg = data.error || (data.logs && data.logs.length > 0 ? data.logs[data.logs.length - 1] : "Process failed");
              setLogs(prev => [...prev, "Error: " + errorMsg]);
            }
          } else {
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


  const fetchUserProfiles = async () => {
    if (!uploadPostKey) return;
    try {
      const res = await fetch(getApiUrl('/api/social/user'), {
        headers: { 'X-Upload-Post-Key': uploadPostKey }
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.profiles && data.profiles.length > 0) {
        setUserProfiles(data.profiles);
        const selectedProfileExists = data.profiles.some((profile) => profile.username === uploadUserId);
        if (!selectedProfileExists) {
          setUploadUserId(data.profiles[0].username);
        }
      } else {
        console.warn("No Upload-Post profiles found for this API key.");
        setUserProfiles([]);
        setUploadUserId('');
      }
    } catch (e) {
      console.warn("Upload-Post profile fetch failed. Posting will stay disabled until the key is fixed.", e);
      setUserProfiles([]);
    }
  };

  const startProcessJob = async (data, { makeActive = true } = {}) => {
    let body;
    const headers = { 'X-Gemini-Key': apiKey };

    if (data.type === 'url') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ url: data.payload, acknowledged: !!data.acknowledged, whisper_model: data.whisperModel });
    } else {
      const formData = new FormData();
      formData.append('file', data.payload);
      formData.append('acknowledged', data.acknowledged ? 'true' : 'false');
      formData.append('whisper_model', data.whisperModel);
      body = formData;
    }

    const res = await fetch(getApiUrl('/api/process'), {
      method: 'POST',
      headers: data.type === 'url' ? headers : { 'X-Gemini-Key': apiKey },
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
        }));
        for (let i = 0; i < fileJobs.length; i++) {
          await startProcessJob(fileJobs[i], { makeActive: i === 0 });
        }
        setLogs([`Queued ${fileJobs.length} videos. They will process in parallel up to the server limit.`]);
      } else {
        await startProcessJob(data, { makeActive: true });
      }
      setShowProcessingModal(true);

    } catch (e) {
      setStatus('error');
      setLogs(l => [...l, `Error starting job: ${e.message}`]);
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
            }));
          } else if (data.status === 'failed') {
            setStatus('error');
            setProjects(updateProject(p.id, { status: 'failed' }));
          } else {
            setStatus('processing');
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
      if (data.status === 'completed' && data.result) {
        setResults(data.result);
        setStatus('complete');
        setProcessingMedia(null);
        setViewingResults(true);
        setShowProcessingModal(false);
      } else if (data.status === 'processing' || data.status === 'queued') {
        setStatus('processing');
        setLogs(data.logs || []);
        setViewingResults(false);
        setShowProcessingModal(true);
        setProcessingJobIds((ids) => ids.includes(p.id) ? ids : [...ids, p.id]);
      } else {
        setResults(data.result || null);
        setStatus('complete');
        setViewingResults(true);
      }
    } catch (e) {
      if (e instanceof JobExpiredError) {
        setProjects(updateProject(p.id, { status: 'expired' }));
        setProcessingJobIds((ids) => ids.filter((id) => id !== p.id));
      }
      alert('This project has expired. Jobs are kept on the server for about an hour after processing.');
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
        <RailItem icon={Sparkles} label="AI Shorts" active={activeTab === 'saasshorts'} onClick={() => setActiveTab('saasshorts')} />
        <RailItem icon={Bot} label="AI Agent" active={activeTab === 'ai-agent'} onClick={() => setActiveTab('ai-agent')} />
        <RailItem icon={Youtube} label="YouTube Studio" active={activeTab === 'thumbnails'} onClick={() => setActiveTab('thumbnails')} />
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
    const cover = p.thumb || coverFromString(p.src || p.title);
    const handleDelete = (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete "${p.title}"? This removes it from your recent projects.`)) return;
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
            {userProfiles.length > 0 && (
              <UserProfileSelector
                profiles={userProfiles}
                selectedUserId={uploadUserId}
                onSelect={setUploadUserId}
              />
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
                  Set your Gemini API key to generate clips. Upload-Post is only needed for social publishing.
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
                  Add an <strong>Upload-Post</strong> key only if you want to publish clips to TikTok, Instagram Reels, or YouTube Shorts directly from OpenShorts.
                  Clip generation works without it.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">Upload-Post API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={uploadPostKey}
                      onChange={(e) => setUploadPostKey(e.target.value)}
                      className="input-field"
                      placeholder="ey..."
                    />
                    <button onClick={fetchUserProfiles} className="btn-primary py-2 px-4 text-sm">
                      Connect
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Connect your Upload-Post account to enable one-click publishing.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <a href="https://app.upload-post.com/login" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Login</span>
                        <span className="text-[10px] text-zinc-600">Register account</span>
                      </a>
                      <a href="https://app.upload-post.com/manage-users" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. Profiles</span>
                        <span className="text-[10px] text-zinc-600">Create & Connect</span>
                      </a>
                      <a href="https://app.upload-post.com/api-keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">3. API Key</span>
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
                  <h2 className="text-lg font-semibold">AI Shorts (UGC Videos)</h2>
                  <span className="text-[10px] bg-violet-500/10 border border-violet-500/20 px-2 py-0.5 rounded text-violet-400 uppercase tracking-wider">New</span>
                </div>
                <p className="text-xs text-zinc-500 mb-6 leading-relaxed">
                  Generate UGC-style videos with AI actors for any product or business using <strong>fal.ai</strong>.
                  Just describe your product or paste a URL. Requires fal.ai + ElevenLabs API keys.
                </p>
                <div className="space-y-4">
                  <label className="block text-sm text-zinc-400">fal.ai API Key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={falKey}
                      onChange={(e) => setFalKey(e.target.value)}
                      className="input-field"
                      placeholder="fal_..."
                    />
                    <button
                      onClick={() => {
                        if (falKey) {
                          localStorage.setItem('falKey_v1', encrypt(falKey));
                          alert('fal.ai API Key saved!');
                        }
                      }}
                      className="btn-primary py-2 px-4 text-sm"
                    >
                      Save
                    </button>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    Get your API key from fal.ai to enable AI actor video generation.
                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">1. Sign Up</span>
                        <span className="text-[10px] text-zinc-600">Create fal.ai account</span>
                      </a>
                      <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener noreferrer" className="p-2 border border-white/5 rounded-lg hover:bg-white/5 transition-colors flex flex-col gap-1">
                        <span className="text-zinc-400 font-medium">2. API Key</span>
                        <span className="text-[10px] text-zinc-600">Generate key</span>
                      </a>
                    </div>
                    <br />
                    <span className="text-zinc-600 italic">
                      Keys are only stored in your browser. Sent to backend only to process requests.
                    </span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* View: SaaS Shorts */}
          {activeTab === 'saasshorts' && (
            <SaaShortsTab geminiApiKey={apiKey} elevenLabsKey={elevenLabsKey} falKey={falKey} uploadPostKey={uploadPostKey} uploadUserId={uploadUserId} />
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
                      Approve the candidates you like and the skill auto-publishes them to TikTok, Reels and YouTube Shorts via Upload-Post.
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

          {/* View: UGC Gallery */}
          {activeTab === 'ugc-gallery' && (
            <UGCGallery />
          )}

          {/* View: Thumbnails */}
          {activeTab === 'thumbnails' && (
            <ThumbnailStudio geminiApiKey={apiKey} uploadPostKey={uploadPostKey} uploadUserId={uploadUserId} />
          )}

          {/* View: Gallery */}
          {/* {activeTab === 'gallery' && (
            <Gallery />
          )} */}

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
                  <MediaInput onProcess={handleProcess} isProcessing={status === 'processing'} />
                </div>

                {/* 3-tool shortcut row */}
                <div className="relative flex items-center justify-center gap-10 mt-12">
                  <ShortcutItem icon={Scissors} color="text-viral" label="Clip Generator" onClick={() => setActiveTab('dashboard')} />
                  <ShortcutItem icon={Sparkles} color="text-violet-300" label="AI Shorts" onClick={() => setActiveTab('saasshorts')} />
                  <ShortcutItem icon={Youtube} color="text-red-300" label="YouTube Studio" onClick={() => setActiveTab('thumbnails')} />
                </div>
              </div>

              {/* Recent projects */}
              <div className="max-w-5xl mx-auto px-6 pb-14">
                <div className="flex items-center gap-4 mb-3">
                  <span className="text-sm text-fg">Recent projects {projects.length > 0 && <span className="text-muted">({projects.length})</span>}</span>
                </div>
                {projects.length === 0 ? (
                  <div className="border border-edge rounded-lg py-12 text-center">
                    <p className="text-sm text-muted">Your generated clips will appear here.</p>
                    <p className="text-xs text-muted/60 mt-1">Drop a YouTube link or upload a video to get started.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
                  </div>
                )}
              </div>
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
                <div className="ml-auto flex items-center gap-2">
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
                    {results.clips.map((clip, i) => (
                      <ResultCard
                        key={i}
                        clip={clip}
                        index={i}
                        jobId={jobId}
                        uploadPostKey={uploadPostKey}
                        uploadUserId={uploadUserId}
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
              OpenShorts needs a <strong className="text-zinc-200">Gemini</strong> API key to generate clips. Upload-Post is optional and only used for direct social publishing.
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

            {/* Upload-Post block */}
            <div className={`rounded-lg p-4 space-y-2 border ${!uploadPostKey ? 'bg-violet-500/5 border-violet-500/30' : 'bg-white/5 border-white/10 opacity-70'}`}>
              <p className="text-xs font-semibold text-zinc-200 flex items-center gap-2">
                {uploadPostKey ? <Check size={12} className="text-green-400" /> : <AlertTriangle size={12} className="text-amber-400" />}
                Upload-Post API Key <span className="text-zinc-500">— optional</span>{uploadPostKey && <span className="text-green-400">— set</span>}
              </p>
              {!uploadPostKey && (
                <>
                  <p className="text-xs text-zinc-400">
                    Only needed to publish your clips to TikTok, Instagram Reels, and YouTube Shorts from this app.
                  </p>
                  <ol className="text-xs text-zinc-400 space-y-1 list-decimal list-inside">
                    <li>Register at <a href="https://app.upload-post.com/login" target="_blank" rel="noopener noreferrer" className="text-violet-400 underline">app.upload-post.com</a></li>
                    <li>Connect your TikTok, Instagram, or YouTube accounts</li>
                    <li>Go to <a href="https://app.upload-post.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-violet-400 underline">API Keys</a> and generate one</li>
                    <li>Paste it below</li>
                  </ol>
                  <input
                    type="text"
                    placeholder="Paste your Upload-Post API key here..."
                    className="w-full bg-black/50 border border-white/20 rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-violet-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target.value.trim()) {
                        setUploadPostKey(e.target.value.trim());
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
        uploadPostKey={uploadPostKey}
        uploadUserId={uploadUserId}
      />

      <ProcessingModal
        open={showProcessingModal}
        onClose={() => setShowProcessingModal(false)}
        title={processingMedia ? titleFromPayload(processingMedia) : 'Processing'}
        logs={logs}
        status={status}
        phase={phaseFromLogs(logs)}
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
