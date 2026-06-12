import React, { useState, useEffect } from 'react';
import { Download, Share2, Instagram, Youtube, Video, CheckCircle, AlertCircle, X, Loader2, Copy, Wand2, Type, Calendar, Clock, Languages, Play, ArrowUp, ArrowDown, FileText } from 'lucide-react';
import { getApiUrl } from '../config';
import SubtitleModal from './SubtitleModal';
import HookModal from './HookModal';
import TranslateModal from './TranslateModal';
import { renderInBrowser } from '../lib/renderInBrowser';

const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export default function ResultCard({ clip, index, jobId, uploadPostKey, uploadUserId, geminiApiKey, elevenLabsKey, onPlay, onPause, openIndex, setOpenIndex, totalClips }) {
    const isOpen = openIndex === index;
    const [showModal, setShowModal] = useState(false);
    const [showSubtitleModal, setShowSubtitleModal] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [captions, setCaptions] = useState([]);
    const videoRef = React.useRef(null);
    const originalVideoUrl = getApiUrl(clip.video_url); // Never changes — used for Remotion previews
    const [currentVideoUrl, setCurrentVideoUrl] = useState(originalVideoUrl);

    const [platforms, setPlatforms] = useState({
        tiktok: true,
        instagram: true,
        youtube: true
    });
    const [postTitle, setPostTitle] = useState("");
    const [postDescription, setPostDescription] = useState("");
    const [isScheduling, setIsScheduling] = useState(false);
    const [scheduleDate, setScheduleDate] = useState("");

    const [posting, setPosting] = useState(false);
    const [postResult, setPostResult] = useState(null);

    const [isEditing, setIsEditing] = useState(false);
    const [isSubtitling, setIsSubtitling] = useState(false);
    const [isHooking, setIsHooking] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
    const [showHookModal, setShowHookModal] = useState(false);
    const [showTranslateModal, setShowTranslateModal] = useState(false);
    const [editError, setEditError] = useState(null);

    const [clipDuration, setClipDuration] = useState(clip.end != null && clip.start != null ? clip.end - clip.start : 30);

    // Accumulate Remotion layers across operations
    const [activeLayers, setActiveLayers] = useState({ subtitles: null, hook: null, effects: null });

    // Fetch clip duration from transcript endpoint
    useEffect(() => {
        if (!jobId || index === undefined) return;
        fetch(getApiUrl(`/api/clip/${jobId}/${index}/transcript`))
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.durationSec) setClipDuration(data.durationSec);
                if (data && data.captions) setCaptions(data.captions);
            })
            .catch(() => {});
    }, [jobId, index]);

    // Initialize/Reset form when modal opens
    useEffect(() => {
        if (showModal) {
            setPostTitle(clip.video_title_for_youtube_short || "Viral Short");
            setPostDescription(clip.video_description_for_instagram || clip.video_description_for_tiktok || "");
            setIsScheduling(false);
            setScheduleDate("");
            setPostResult(null);
        }
    }, [showModal, clip]);

    const handleAutoEdit = async () => {
        setIsEditing(true);
        setEditError(null);
        try {
            const apiKey = geminiApiKey || localStorage.getItem('gemini_key');

            if (!apiKey) {
                throw new Error("Gemini API Key is missing. Please set it in Settings.");
            }

            // Try Remotion effects endpoint first
            const effectsRes = await fetch(getApiUrl('/api/effects/generate'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Gemini-Key': apiKey
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: currentVideoUrl.split('/').pop()
                })
            });

            if (effectsRes.ok) {
                const data = await effectsRes.json();
                if (data.effects && data.effects.segments) {
                    const newLayers = { ...activeLayers, effects: data.effects };
                    setActiveLayers(newLayers);
                    const blobUrl = await renderInBrowser({
                        videoUrl: originalVideoUrl,
                        durationInSeconds: clipDuration,
                        subtitles: newLayers.subtitles,
                        hook: newLayers.hook,
                        effects: newLayers.effects,
                    });
                    setCurrentVideoUrl(blobUrl);
                    if (videoRef.current) videoRef.current.load();
                    return;
                }
            }

            // Fallback: legacy FFmpeg edit endpoint
            const res = await fetch(getApiUrl('/api/edit'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Gemini-Key': apiKey
                },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    input_filename: currentVideoUrl.split('/').pop()
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) {
                    videoRef.current.load();
                }
            }

        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsEditing(false);
        }
    };

    const handleSubtitle = async (options) => {
        setIsSubtitling(true);
        setEditError(null);
        try {
            if (options.remotion) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, subtitles: options.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const res = await fetch(getApiUrl('/api/subtitle'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    position: options.position,
                    font_size: options.fontSize,
                    font_name: options.fontName,
                    font_color: options.fontColor,
                    border_color: options.borderColor,
                    border_width: options.borderWidth,
                    bg_color: options.bgColor,
                    bg_opacity: options.bgOpacity,
                    input_filename: currentVideoUrl.split('/').pop()
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) videoRef.current.load();
                setShowSubtitleModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsSubtitling(false);
        }
    };

    const handleHook = async (hookData) => {
        setIsHooking(true);
        setEditError(null);
        try {
            if (hookData.remotion) {
                // Accumulate layer and render all layers together
                const newLayers = { ...activeLayers, hook: hookData.remotion };
                setActiveLayers(newLayers);
                const blobUrl = await renderInBrowser({
                    videoUrl: originalVideoUrl,
                    durationInSeconds: clipDuration,
                    subtitles: newLayers.subtitles,
                    hook: newLayers.hook,
                    effects: newLayers.effects,
                });
                setCurrentVideoUrl(blobUrl);
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
                return;
            }

            // Fallback: legacy FFmpeg
            const payload = typeof hookData === 'string'
                ? { text: hookData, position: 'top', size: 'M' }
                : hookData;

            const res = await fetch(getApiUrl('/api/hook'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    clip_index: index,
                    text: payload.text,
                    position: payload.position,
                    size: payload.size,
                    input_filename: currentVideoUrl.split('/').pop()
                })
            });

            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) videoRef.current.load();
                setShowHookModal(false);
            }
        } catch (e) {
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsHooking(false);
        }
    };

    const handleTranslate = async (options) => {
        console.log('[Translate] Starting translation with options:', options);
        setIsTranslating(true);
        setEditError(null);
        try {
            const apiKey = elevenLabsKey;
            console.log('[Translate] API Key available:', !!apiKey);

            if (!apiKey) {
                throw new Error("ElevenLabs API Key is missing. Please set it in Settings.");
            }

            const requestBody = {
                job_id: jobId,
                clip_index: index,
                target_language: options.targetLanguage,
                input_filename: currentVideoUrl.split('/').pop()
            };
            console.log('[Translate] Request body:', requestBody);
            console.log('[Translate] Sending request to /api/translate');

            const res = await fetch(getApiUrl('/api/translate'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-ElevenLabs-Key': apiKey
                },
                body: JSON.stringify(requestBody)
            });

            console.log('[Translate] Response status:', res.status);

            if (!res.ok) {
                const errText = await res.text();
                console.error('[Translate] Error response:', errText);
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    if (e.message !== errText) throw e;
                    throw new Error(errText);
                }
            }

            const data = await res.json();
            console.log('[Translate] Success response:', data);
            if (data.new_video_url) {
                setCurrentVideoUrl(getApiUrl(data.new_video_url));
                if (videoRef.current) {
                    videoRef.current.load();
                }
                setShowTranslateModal(false);
            }

        } catch (e) {
            console.error('[Translate] Exception:', e);
            setEditError(e.message);
            setTimeout(() => setEditError(null), 5000);
        } finally {
            setIsTranslating(false);
        }
    };

    const handlePost = async () => {
        if (!uploadPostKey || !uploadUserId) {
            setPostResult({ success: false, msg: "Missing API Key or User ID." });
            return;
        }

        const selectedPlatforms = Object.keys(platforms).filter(k => platforms[k]);
        if (selectedPlatforms.length === 0) {
            setPostResult({ success: false, msg: "Select at least one platform." });
            return;
        }

        if (isScheduling && !scheduleDate) {
            setPostResult({ success: false, msg: "Please select a date and time." });
            return;
        }

        setPosting(true);
        setPostResult(null);

        try {
            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: uploadPostKey,
                user_id: uploadUserId,
                platforms: selectedPlatforms,
                title: postTitle,
                description: postDescription
            };

            if (isScheduling && scheduleDate) {
                // Convert to ISO-8601
                payload.scheduled_date = new Date(scheduleDate).toISOString();
                // Optional: pass timezone if needed, backend defaults to UTC or we can send user's timezone
                payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            }

            const res = await fetch(getApiUrl('/api/social/post'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                const errText = await res.text();
                try {
                    const jsonErr = JSON.parse(errText);
                    throw new Error(jsonErr.detail || errText);
                } catch (e) {
                    throw new Error(errText);
                }
            }

            setPostResult({ success: true, msg: isScheduling ? "Scheduled successfully!" : "Posted successfully!" });
            setTimeout(() => {
                setShowModal(false);
                setPostResult(null);
            }, 3000);

        } catch (e) {
            setPostResult({ success: false, msg: `Failed: ${e.message}` });
        } finally {
            setPosting(false);
        }
    };

    const handleDownload = async () => {
        try {
            const response = await fetch(currentVideoUrl);
            if (!response.ok) throw new Error('Download failed');
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = `clip-${index + 1}.mp4`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        } catch (err) {
            console.error('Download error:', err);
            window.open(currentVideoUrl, '_blank');
        }
    };

    const title = clip.video_title_for_youtube_short || `Viral clip ${index + 1}`;
    const description = clip.video_description_for_tiktok || clip.video_description_for_instagram || '';
    const transcriptText = captions.map((c) => c.text).join(' ');
    const durSec = Math.floor(clipDuration);

    const ActionBtn = ({ icon: Icon, label, onClick, loading, primary }) => (
        <button
            onClick={onClick}
            disabled={loading}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${primary ? 'bg-fg text-[#18181b] hover:bg-white' : 'bg-surface2 text-fg hover:bg-white/10 border border-edge'}`}
        >
            {loading ? <Loader2 size={15} className="animate-spin shrink-0" /> : <Icon size={15} className="shrink-0" />}
            <span className="truncate">{label}</span>
        </button>
    );

    return (
        <>
            {/* Compact grid card */}
            <div className="group flex flex-col animate-[fadeIn_0.4s_ease-out]">
                <div
                    className="relative aspect-[9/16] rounded-xl overflow-hidden bg-black border border-edge cursor-pointer"
                    onClick={() => { if (!playing) setOpenIndex(index); }}
                >
                    <video
                        ref={videoRef}
                        src={currentVideoUrl}
                        playsInline
                        preload="metadata"
                        controls={playing}
                        className="w-full h-full object-cover"
                        onPlay={() => { const t = videoRef.current ? videoRef.current.currentTime : 0; onPlay && onPlay(clip.start + t); }}
                        onPause={() => onPause && onPause()}
                        onEnded={() => { setPlaying(false); if (videoRef.current) videoRef.current.currentTime = 0; }}
                    />
                    <span className="absolute top-2 left-2 bg-black/65 text-white text-[10px] font-medium px-1.5 py-0.5 rounded">Clip {index + 1}</span>
                    <span className="absolute top-2 right-2 bg-black/65 text-white text-[11px] font-medium px-1.5 py-0.5 rounded tabular-nums">{fmtTime(durSec)}</span>

                    {!playing && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/25 transition-colors pointer-events-none">
                            <button
                                onClick={(e) => { e.stopPropagation(); setPlaying(true); videoRef.current && videoRef.current.play(); }}
                                className="w-12 h-12 rounded-full bg-black/55 backdrop-blur flex items-center justify-center text-white pointer-events-auto hover:bg-black/75 active:scale-95 transition-all"
                                aria-label="Play clip"
                            >
                                <Play size={22} className="ml-0.5" />
                            </button>
                        </div>
                    )}

                    {isEditing && (
                        <div className="absolute inset-0 bg-black/65 backdrop-blur-sm flex flex-col items-center justify-center z-10 p-4 text-center">
                            <Loader2 size={28} className="text-viral animate-spin mb-2" />
                            <span className="text-[11px] font-medium text-white">Applying AI edits…</span>
                        </div>
                    )}
                </div>

                <h3 className="mt-2.5 text-sm font-medium text-fg leading-snug line-clamp-2 cursor-pointer hover:text-white" onClick={() => setOpenIndex(index)} title={title}>
                    {title}
                </h3>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {clip.viral_hook_text && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted bg-surface2 border border-edge px-1.5 py-0.5 rounded"><Wand2 size={10} /> Hook</span>
                    )}
                    <span className="text-[10px] text-muted bg-surface2 border border-edge px-1.5 py-0.5 rounded tabular-nums">{durSec}s</span>
                </div>
                <div className="flex items-center gap-1 mt-2">
                    <button onClick={(e) => { e.stopPropagation(); setShowModal(true); }} title="Post / schedule" className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"><Share2 size={15} /></button>
                    <button onClick={(e) => { e.stopPropagation(); setShowHookModal(true); }} title="Viral hook" className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"><Wand2 size={15} /></button>
                    <button onClick={(e) => { e.stopPropagation(); handleDownload(); }} title="Download" className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"><Download size={15} /></button>
                </div>
            </div>

            {/* Clip detail modal */}
            {isOpen && (
                <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]" onClick={() => setOpenIndex(null)}>
                    <div className="absolute top-5 right-5 flex items-center gap-2 z-10">
                        <button disabled={index <= 0} onClick={(e) => { e.stopPropagation(); setOpenIndex(index - 1); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 disabled:opacity-40 transition-colors" aria-label="Previous clip"><ArrowUp size={16} /></button>
                        <button disabled={index >= totalClips - 1} onClick={(e) => { e.stopPropagation(); setOpenIndex(index + 1); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 disabled:opacity-40 transition-colors" aria-label="Next clip"><ArrowDown size={16} /></button>
                        <button onClick={(e) => { e.stopPropagation(); setOpenIndex(null); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 transition-colors" aria-label="Close"><X size={16} /></button>
                    </div>

                    <div className="bg-surface border border-edge rounded-2xl w-full max-w-4xl max-h-[88vh] overflow-hidden flex shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        {/* Preview */}
                        <div className="w-[clamp(200px,26vw,280px)] shrink-0 bg-black relative">
                            <video src={currentVideoUrl} controls autoPlay playsInline className="w-full h-full object-cover aspect-[9/16]" />
                            <span className="absolute top-3 right-3 bg-black/65 text-white text-[11px] font-medium px-1.5 py-0.5 rounded tabular-nums">{fmtTime(durSec)}</span>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 p-5 overflow-y-auto custom-scrollbar">
                            <h2 className="text-base font-medium text-fg leading-snug">{title}</h2>
                            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                {clip.viral_hook_text && <span className="inline-flex items-center gap-1 text-[11px] text-muted bg-surface2 border border-edge px-2 py-0.5 rounded"><Wand2 size={11} /> Hook</span>}
                                <span className="text-[11px] text-muted bg-surface2 border border-edge px-2 py-0.5 rounded tabular-nums">{durSec}s</span>
                            </div>
                            {description && <p className="text-sm text-muted leading-relaxed mt-4">{description}</p>}
                            {transcriptText && (
                                <div className="mt-5">
                                    <div className="flex items-center gap-1.5 text-xs text-muted mb-2"><FileText size={13} /> Transcript</div>
                                    <p className="text-sm text-zinc-300 leading-relaxed">{transcriptText}</p>
                                </div>
                            )}
                            {editError && (
                                <div className="mt-4 p-2.5 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg flex items-center gap-2">
                                    <AlertCircle size={13} className="shrink-0" /> {editError}
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="w-[200px] shrink-0 border-l border-edge p-4 space-y-2 overflow-y-auto custom-scrollbar">
                            <ActionBtn icon={Share2} label="Publish on Social" primary onClick={() => setShowModal(true)} />
                            <ActionBtn icon={Download} label="Download HD" onClick={handleDownload} />
                            <div className="h-px bg-edge my-1" />
                            <ActionBtn icon={Wand2} label="Auto edit" loading={isEditing} onClick={handleAutoEdit} />
                            <ActionBtn icon={Type} label="Subtitles" loading={isSubtitling} onClick={() => setShowSubtitleModal(true)} />
                            <ActionBtn icon={Wand2} label="Viral hook" loading={isHooking} onClick={() => setShowHookModal(true)} />
                            <ActionBtn icon={Languages} label="Dub voice" loading={isTranslating} onClick={() => setShowTranslateModal(true)} />
                        </div>
                    </div>
                </div>
            )}

            {/* Post Modal */}
            {showModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
                    <div className="bg-[#121214] border border-white/10 p-6 rounded-2xl w-full max-w-md shadow-2xl relative max-h-[90vh] overflow-y-auto custom-scrollbar">
                        <button
                            onClick={() => setShowModal(false)}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-white"
                        >
                            <X size={20} />
                        </button>

                        <h3 className="text-lg font-bold text-white mb-4">Post / Schedule</h3>

                        {!uploadPostKey && (
                            <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 text-yellow-200 text-xs rounded-lg flex items-start gap-2">
                                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                <div>Configure API Key in Settings first.</div>
                            </div>
                        )}

                        <div className="space-y-4 mb-6">
                            {/* Title & Description */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Video Title</label>
                                <input
                                    type="text"
                                    value={postTitle}
                                    onChange={(e) => setPostTitle(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder-zinc-600"
                                    placeholder="Enter a catchy title..."
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Caption / Description</label>
                                <textarea
                                    value={postDescription}
                                    onChange={(e) => setPostDescription(e.target.value)}
                                    rows={4}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder-zinc-600 resize-none"
                                    placeholder="Write a caption for your post..."
                                />
                            </div>

                            {/* Scheduling */}
                            <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-2 text-sm text-white font-medium">
                                        <Calendar size={16} className="text-purple-400" /> Schedule Post
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" checked={isScheduling} onChange={(e) => setIsScheduling(e.target.checked)} className="sr-only peer" />
                                        <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                                    </label>
                                </div>

                                {isScheduling && (
                                    <div className="mt-3 animate-[fadeIn_0.2s_ease-out]">
                                        <label className="block text-xs text-zinc-400 mb-1">Select Date & Time</label>
                                        <div className="relative">
                                            <input
                                                type="datetime-local"
                                                value={scheduleDate}
                                                onChange={(e) => setScheduleDate(e.target.value)}
                                                className="w-full bg-black/40 border border-white/10 rounded-lg p-2 pl-9 text-sm text-white focus:outline-none focus:border-purple-500/50 [color-scheme:dark]"
                                            />
                                            <Clock size={14} className="absolute left-3 top-2.5 text-zinc-500" />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Platforms */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-2">Select Platforms</label>
                                <div className="grid grid-cols-1 gap-2">
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.tiktok} onChange={e => setPlatforms({ ...platforms, tiktok: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Video size={16} className="text-cyan-400" /> TikTok</div>
                                    </label>
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.instagram} onChange={e => setPlatforms({ ...platforms, instagram: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Instagram size={16} className="text-pink-400" /> Instagram</div>
                                    </label>
                                    <label className="flex items-center gap-3 p-3 bg-white/5 rounded-lg cursor-pointer hover:bg-white/10 transition-colors border border-white/5">
                                        <input type="checkbox" checked={platforms.youtube} onChange={e => setPlatforms({ ...platforms, youtube: e.target.checked })} className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary" />
                                        <div className="flex items-center gap-2 text-sm text-white"><Youtube size={16} className="text-red-400" /> YouTube Shorts</div>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {postResult && (
                            <div className={`mb-4 p-3 rounded-lg text-xs flex items-start gap-2 ${postResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                {postResult.success ? <CheckCircle size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                                <div>{postResult.msg}</div>
                            </div>
                        )}

                        <button
                            onClick={handlePost}
                            disabled={posting || !uploadPostKey}
                            className="w-full py-3 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-bold transition-all flex items-center justify-center gap-2"
                        >
                            {posting ? <><Loader2 size={16} className="animate-spin" /> {isScheduling ? 'Scheduling...' : 'Publishing...'}</> : <><Share2 size={16} /> {isScheduling ? 'Schedule Post' : 'Publish Now'}</>}
                        </button>
                    </div>
                </div>
            )}

            <SubtitleModal
                isOpen={showSubtitleModal}
                onClose={() => setShowSubtitleModal(false)}
                onGenerate={handleSubtitle}
                isProcessing={isSubtitling}
                videoUrl={originalVideoUrl}
                jobId={jobId}
                clipIndex={index}
                existingHook={activeLayers.hook}
            />

            <HookModal
                isOpen={showHookModal}
                onClose={() => setShowHookModal(false)}
                onGenerate={handleHook}
                isProcessing={isHooking}
                videoUrl={originalVideoUrl}
                initialText={clip.viral_hook_text}
                durationInSeconds={clip.end && clip.start ? clip.end - clip.start : 30}
                existingSubtitles={activeLayers.subtitles}
            />

            <TranslateModal
                isOpen={showTranslateModal}
                onClose={() => setShowTranslateModal(false)}
                onTranslate={handleTranslate}
                isProcessing={isTranslating}
                videoUrl={currentVideoUrl}
                hasApiKey={!!elevenLabsKey}
            />
        </>
    );
}
