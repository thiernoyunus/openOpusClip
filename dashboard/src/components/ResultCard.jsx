import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Download, Share2, Instagram, Youtube, Video, CheckCircle, AlertCircle, X, Loader2, Copy, Wand2, Calendar, Clock, Play, ArrowUp, ArrowDown, FileText, Crop, Flame, Check, Trash2 } from 'lucide-react';
import { getApiUrl } from '../config';
import { captureError, track } from '../analytics';
import RemotionPreview from './RemotionPreview';
import { renderClipOnServer, applyRender } from '../lib/renderClip';
import { outputDurationFrames } from '@remotion-src/lib/edl';
import { defaultSubtitleConfig, loadDefaultCaptionStyle } from './editor/useEditorState';

const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Virality score → full Tailwind class strings (kept static so the JIT can see them)
const scoreTheme = (score) => {
    if (score >= 80) return { text: 'text-emerald-400', border: 'border-emerald-500/60', bar: 'bg-emerald-400' };
    if (score >= 60) return { text: 'text-amber-400', border: 'border-amber-500/60', bar: 'bg-amber-400' };
    return { text: 'text-orange-400', border: 'border-orange-500/60', bar: 'bg-orange-400' };
};

// Solid dark fill + bright colored number + colored border = readable on any frame
const ScoreBadge = ({ score, lg, box }) => {
    const t = scoreTheme(score);
    // OpusClip-style: big bold number in a solid boxed badge with a colored border
    if (box) {
        return (
            <span className={`inline-flex flex-col items-center justify-center bg-black/85 ${t.text} border-2 ${t.border} rounded-lg shadow-md w-12 h-12 leading-none`}>
                <span className="text-xl font-extrabold tabular-nums">{score}</span>
            </span>
        );
    }
    return (
        <span className={`inline-flex items-center gap-1 bg-black/85 ${t.text} border ${t.border} font-bold rounded-md tabular-nums shadow-sm ${lg ? 'text-sm px-2 py-1' : 'text-xs px-1.5 py-1'}`}>
            <Flame size={lg ? 13 : 12} /> {score}
        </span>
    );
};

const BREAKDOWN_LABELS = { hook: 'Hook', flow: 'Flow', value: 'Value', trend: 'Trend' };

// The only three settings YouTube accepts for who can see an upload.
const YT_VISIBILITIES = [
    { value: 'public', label: 'Public' },
    { value: 'unlisted', label: 'Unlisted' },
    { value: 'private', label: 'Private' },
];

export default function ResultCard({ clip, index, prevIndex = null, nextIndex = null, jobId, zernioKey, socialAccounts = [], onPlay, onPause, openIndex, setOpenIndex, totalClips: _totalClips, onEdit, framingVersion = 0, scheduled = false, onScheduled, picked = false, onTogglePick, onDelete }) {
    const isOpen = openIndex === index;
    const [showModal, setShowModal] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [captions, setCaptions] = useState([]);
    const videoRef = React.useRef(null);
    // Where the visible player was last left, in seconds. The plain <video> and
    // the Remotion preview swap places (see useFramingPreview), so videoRef is
    // null half the time — this is the one reading that works for both.
    const lastPreviewTimeRef = React.useRef(0);
    const originalVideoUrl = getApiUrl(clip.video_url); // Base URL for Remotion when not EDL-edited
    const [currentVideoUrl, setCurrentVideoUrl] = useState(originalVideoUrl);

    // Keep card video URL in sync when parent updates clip.video_url (e.g. editor export)
    useEffect(() => {
        setCurrentVideoUrl(originalVideoUrl);
    }, [originalVideoUrl]);

    // Account selection: default every connected account to ON until the user unticks it
    const [accountToggles, setAccountToggles] = useState({});
    const selectedAccounts = socialAccounts.filter((a) => accountToggles[a.id] ?? true);
    // Per-account channel options. Keyed by account id, not by platform — someone
    // can connect two YouTube channels and want different settings on each.
    const [ytVisibility, setYtVisibility] = useState({}); // { [accountId]: 'public' | 'unlisted' | 'private' }
    const [igCoverMs, setIgCoverMs] = useState({});       // { [accountId]: ms into the clip }
    const coverPreviewRefs = useRef({});                  // { [accountId]: <video> showing the chosen frame }

    // Move the little preview to the picked moment so the user sees the frame they chose.
    const setCoverMs = useCallback((accountId, ms) => {
        setIgCoverMs((prev) => ({ ...prev, [accountId]: ms }));
        const el = coverPreviewRefs.current[accountId];
        if (el) {
            try { el.currentTime = ms / 1000; } catch { /* not seekable yet */ }
        }
    }, []);

    const [postTitle, setPostTitle] = useState("");
    const [postDescription, setPostDescription] = useState("");
    const [isScheduling, setIsScheduling] = useState(false);
    const [scheduleDate, setScheduleDate] = useState("");

    const [posting, setPosting] = useState(false);
    const [postResult, setPostResult] = useState(null);

    // Server-side burn progress (download / social share)
    const [isRendering, setIsRendering] = useState(false);
    const [renderProgress, setRenderProgress] = useState(null); // 0–100 for UI
    // Cache last burned output so a second click doesn't re-render
    const renderCacheRef = useRef(null); // { key, downloadUrl, filename, applied }
    // Drop cache when editor closes / framing version bumps
    useEffect(() => {
        renderCacheRef.current = null;
    }, [framingVersion, index]);
    // Local mirror of clip.rendered_edited_at after applyRender from this card
    const [localRenderedEditedAt, setLocalRenderedEditedAt] = useState(clip.rendered_edited_at ?? null);
    useEffect(() => {
        setLocalRenderedEditedAt(clip.rendered_edited_at ?? null);
    }, [clip.rendered_edited_at]);

    const [clipDuration, setClipDuration] = useState(clip.end != null && clip.start != null ? clip.end - clip.start : 30);

    // Caption config saved in the editor for this clip (position/style/on-off),
    // loaded from the clip's framing. null = clip has no framing / not loaded.
    const [framingCaptions, setFramingCaptions] = useState(null);
    // Full framing JSON (EDL) — used when the user has edited the clip in the editor
    const [framingFull, setFramingFull] = useState(null);

    // Default captions in the preview (Opus-style): overlay the same caption
    // engine the editor/export use, so the user sees captions WITHOUT opening
    // the editor. Only on an untouched clip (any applied edit is already baked
    // into currentVideoUrl).
    const previewSubtitles = React.useMemo(() => {
        if (captions.length === 0) return null;
        if (currentVideoUrl !== originalVideoUrl) return null;
        // Prefer what the user set in the editor: keep its position/style but use
        // the clip-relative caption timings from the transcript endpoint.
        if (framingCaptions) {
            if (framingCaptions.subtitles) return { ...framingCaptions.subtitles, captions };
            // Captions were explicitly turned off in the editor → show none.
            if (framingCaptions.captionsInitialized) return null;
        }
        // Untouched clip → fall back to the user's default caption style, if on.
        if (loadDefaultCaptionStyle()?.enabled !== true) return null;
        return defaultSubtitleConfig(captions);
    }, [captions, currentVideoUrl, originalVideoUrl, framingCaptions]);

    // Fetch clip duration from transcript endpoint
    // framingVersion: re-fetch after editor extends/edits so captions stay current
    useEffect(() => {
        if (!jobId || index === undefined) return;
        fetch(getApiUrl(`/api/clip/${jobId}/${index}/transcript`))
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data && data.durationSec) setClipDuration(data.durationSec);
                if (data && data.captions) setCaptions(data.captions);
            })
            .catch(() => {});
    }, [jobId, index, framingVersion]);

    // Load the clip's saved framing so the preview mirrors editor caption edits
    // (position/style, or captions turned off). Full JSON is kept for EDL preview
    // when the user has edited in the editor (framing.editedAt).
    // framingVersion bumps when the editor closes: the card never unmounts (the
    // editor is an overlay), so without it the preview keeps the pre-edit style.
    // The ?v= also defeats the browser's heuristic cache on the static JSON.
    useEffect(() => {
        if (!clip.framing_url) {
            setFramingCaptions(null);
            setFramingFull(null);
            return;
        }
        let alive = true;
        setFramingCaptions(null); // drop the previous clip's config so it can't flash
        setFramingFull(null);
        fetch(getApiUrl(clip.framing_url) + `?v=${framingVersion}`)
            .then(res => res.ok ? res.json() : null)
            .then(f => {
                if (!alive || !f) return;
                setFramingFull(f);
                setFramingCaptions({
                    subtitles: f.subtitles ?? null,
                    captionsInitialized: f.captionsInitialized ?? false,
                });
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [clip.framing_url, framingVersion]);

    const isEdited = !!framingFull?.editedAt;
    const effectiveDuration = isEdited
        ? outputDurationFrames(framingFull, 30) / 30
        : clipDuration;

    // A cover frame is only meaningful when the file we preview is the file we
    // post. An unexported edit is burned at post time, so trims and reorders
    // would shift every timestamp — the frame picked here would not be the
    // frame Instagram receives, and the offset could even land past the end.
    const coverMatchesPost = !isEdited
        || (localRenderedEditedAt ?? clip.rendered_edited_at) === framingFull?.editedAt;

    // Furthest into the posted file a cover frame can sit. Derived from the
    // effective duration so a trim shortens it — the picked offset is kept
    // rather than reset (a re-trim shouldn't silently discard the choice), so
    // every read of it clamps here instead.
    // Stop one frame short of the end. An offset equal to the duration is EOF,
    // not a frame, so it can be rejected or silently resolve to something else.
    // Everything in this app composes at 30fps (see outputDurationFrames calls).
    const coverMaxMs = Math.max(
        0,
        Math.round((effectiveDuration || clipDuration || 30) * 1000) - Math.round(1000 / 30),
    );

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

    /**
     * Ensure the file on disk matches what the card preview shows (edits + captions).
     * Returns { downloadUrl, filename, applied } where:
     * - applied: true if video_url was promoted (edited burn)
     * - filename: set when a captions-only render was produced (pass to social/post)
     * - downloadUrl: absolute or API-relative URL to fetch for download
     */
    const ensureRenderedFile = useCallback(async () => {
        const renderedEditedAt = localRenderedEditedAt ?? clip.rendered_edited_at;
        const isFreshEdit = isEdited && renderedEditedAt && framingFull?.editedAt
            && renderedEditedAt === framingFull.editedAt;

        // Edited clip already burned for this framing revision → use current video_url
        if (isFreshEdit) {
            return { downloadUrl: currentVideoUrl, filename: null, applied: true };
        }

        const needsRender = isEdited || !!previewSubtitles;
        if (!needsRender) {
            return { downloadUrl: currentVideoUrl, filename: null, applied: false };
        }

        const cacheKey = isEdited
            ? `edit:${framingVersion}:${framingFull.editedAt}`
            : `captions:${framingVersion}:${JSON.stringify({ style: previewSubtitles?.style, position: previewSubtitles?.position })}:${captions.length}`;
        if (renderCacheRef.current?.key === cacheKey) {
            return renderCacheRef.current;
        }

        setIsRendering(true);
        setRenderProgress(0);
        track('clip_render_started', {
            operation_category: isEdited ? 'edit_burn' : 'captions_burn',
        });
        try {
            let props;
            if (isEdited) {
                props = {
                    videoUrl: clip.video_url || '',
                    sourceVideoUrl: clip.source_url,
                    framing: framingFull,
                    durationInFrames: outputDurationFrames(framingFull, 30),
                    fps: 30,
                    width: framingFull.outputWidth ?? 1080,
                    height: framingFull.outputHeight ?? 1920,
                    subtitles: framingFull.subtitles ?? null,
                    hook: null,
                    effects: null,
                };
            } else {
                // Default caption style on an untouched clip — burn overlay only
                props = {
                    videoUrl: currentVideoUrl,
                    sourceVideoUrl: clip.source_url,
                    framing: null,
                    durationInFrames: Math.round(clipDuration * 30),
                    fps: 30,
                    width: 1080,
                    height: 1920,
                    subtitles: previewSubtitles,
                    hook: null,
                    effects: null,
                };
            }

            const { filename } = await renderClipOnServer({
                jobId,
                clipIndex: index,
                props,
                // Render service reports 0–100 (same as editor Export progress)
                onProgress: (p) => setRenderProgress(Math.round(p ?? 0)),
            });

            if (isEdited) {
                const applied = await applyRender({ jobId, clipIndex: index, filename });
                const newUrl = getApiUrl(applied.new_video_url);
                setCurrentVideoUrl(newUrl);
                setLocalRenderedEditedAt(framingFull.editedAt);
                const result = { key: cacheKey, downloadUrl: newUrl, filename: null, applied: true };
                renderCacheRef.current = result;
                track('clip_render_completed', { result_category: 'edited_clip' });
                return result;
            }

            // Captions-only: do NOT applyRender (keep raw clip for live overlay preview).
            // The render service's outputUrl is a server-local file path — the file is
            // only served under /videos/{jobId}/, so build that URL instead.
            const result = {
                key: cacheKey,
                downloadUrl: getApiUrl(`/videos/${jobId}/${encodeURIComponent(filename)}`),
                filename,
                applied: false,
            };
            renderCacheRef.current = result;
            track('clip_render_completed', { result_category: 'captioned_clip' });
            return result;
        } catch (error) {
            track('clip_render_failed', { failure_category: 'render' });
            captureError(error, { area: 'clip_render' });
            throw error;
        } finally {
            setIsRendering(false);
            setRenderProgress(null);
        }
    }, [
        localRenderedEditedAt, clip.rendered_edited_at, clip.video_url, clip.source_url,
        isEdited, framingFull, framingVersion, previewSubtitles, captions.length,
        currentVideoUrl, clipDuration, jobId, index,
    ]);

    const handlePost = async () => {
        if (!zernioKey) {
            setPostResult({ success: false, msg: "Missing Zernio API Key." });
            return;
        }

        if (selectedAccounts.length === 0) {
            setPostResult({ success: false, msg: "Select at least one account." });
            return;
        }

        if (isScheduling && !scheduleDate) {
            setPostResult({ success: false, msg: "Please select a date and time." });
            return;
        }

        setPosting(true);
        setPostResult(null);
        const _platforms = [...new Set(selectedAccounts.map((a) => a.platform))].sort().join('-');
        const platformCount = _platforms ? _platforms.split('-').length : 0;
        track('social_post_started', { mode: isScheduling ? 'schedule' : 'post', source: 'clip_card', platform_count: platformCount, platforms: _platforms });

        try {
            // Burn edits/captions before upload so social matches the card preview
            const prepared = await ensureRenderedFile();

            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: zernioKey,
                accounts: selectedAccounts.map((a) => {
                    const target = { accountId: a.id, platform: a.platform };
                    if (a.platform === 'youtube') target.visibility = ytVisibility[a.id] || 'public';
                    // Only send an offset we can stand behind (see coverMatchesPost), and
                    // clamp it — a later trim can leave the stored pick past the end.
                    // Omitted when 0, which is the first frame and the default anyway.
                    if (a.platform === 'instagram' && coverMatchesPost && igCoverMs[a.id]) {
                        target.thumbOffset = Math.min(Math.round(igCoverMs[a.id]), coverMaxMs);
                    }
                    return target;
                }),
                title: postTitle,
                description: postDescription
            };

            // Captions-only burns are not applied to video_url — pass filename so
            // the backend uploads the temporary render instead of the raw mp4.
            if (prepared.filename) {
                payload.filename = prepared.filename;
            }

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
                let detail = errText;
                try {
                    detail = JSON.parse(errText).detail || errText;
                } catch { /* plain text */ }
                throw new Error(detail);
            }

            setPostResult({ success: true, msg: isScheduling ? "Scheduled successfully!" : "Posted successfully!" });
            if (onScheduled) onScheduled();
            track('social_post_completed', { mode: isScheduling ? 'schedule' : 'post', source: 'clip_card', platform_count: platformCount, platforms: _platforms });
            setTimeout(() => {
                setShowModal(false);
                setPostResult(null);
            }, 3000);

        } catch (e) {
            setPostResult({ success: false, msg: `Failed: ${e.message}` });
            track('social_post_failed', { mode: isScheduling ? 'schedule' : 'post', source: 'clip_card', platform_count: platformCount, platforms: _platforms, error_category: 'client' });
            captureError(e, { area: 'social_post' });
        } finally {
            setPosting(false);
        }
    };

    const handleDownload = async () => {
        track('clip_download_started', { source_category: 'clip_card' });
        try {
            const prepared = await ensureRenderedFile();
            const response = await fetch(prepared.downloadUrl);
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
            track('clip_download_completed', { result_category: 'downloaded' });
        } catch (err) {
            console.error('Download error:', err);
            track('clip_download_failed', { failure_category: 'download' });
            captureError(err, { area: 'clip_download' });
            // Do not fall back to the raw file — user expects what they saw
        }
    };

    const title = clip.video_title_for_youtube_short || `Viral clip ${index + 1}`;
    const description = clip.video_description_for_tiktok || clip.video_description_for_instagram || '';
    // LLM may return stringified numbers — coerce defensively
    const num = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? NaN : Number(v));
    const viralityScore = num(clip.virality_score);
    const hasScore = !isNaN(viralityScore);
    const breakdown = clip.score_breakdown || {};
    const transcriptText = captions.map((c) => c.text).join(' ');
    const durSec = Math.floor(effectiveDuration);
    const useFramingPreview = isEdited || !!previewSubtitles;
    const renderPct = renderProgress != null ? `${renderProgress}%` : null;

    const ActionBtn = ({ icon: Icon, label, onClick, loading, primary, ...rest }) => (
        <button
            onClick={onClick}
            disabled={loading}
            {...rest}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${primary ? 'bg-fg text-[#18181b] hover:bg-white' : 'bg-surface2 text-fg hover:bg-white/10 border border-edge'}`}
        >
            {loading ? <Loader2 size={15} className="animate-spin shrink-0" /> : <Icon size={15} className="shrink-0" />}
            <span className="truncate">{label}</span>
        </button>
    );

    return (
        <>
            {/* Compact grid card */}
            <div data-tour="clip-card" className="group flex flex-col animate-[fadeIn_0.4s_ease-out]">
                <div
                    className={`relative aspect-[9/16] rounded-xl overflow-hidden bg-black border cursor-pointer ${picked ? 'border-viral' : scheduled ? 'border-emerald-500/50' : 'border-edge'}`}
                    onClick={() => { if (!playing) setOpenIndex(index); }}
                >
                    {playing && useFramingPreview ? (
                        <RemotionPreview
                            videoUrl={isEdited ? currentVideoUrl : originalVideoUrl}
                            sourceVideoUrl={isEdited ? getApiUrl(clip.source_url) : null}
                            framing={isEdited ? framingFull : null}
                            durationInSeconds={effectiveDuration}
                            subtitles={isEdited ? (framingFull.subtitles ?? null) : previewSubtitles}
                            loop={false}
                            onPlay={(t) => { lastPreviewTimeRef.current = t; onPlay && onPlay(clip.start + t); }}
                            onPause={(t) => { if (typeof t === 'number') lastPreviewTimeRef.current = t; onPause && onPause(); }}
                            onEnded={() => setPlaying(false)}
                        />
                    ) : (
                    <video
                        ref={videoRef}
                        src={currentVideoUrl}
                        playsInline
                        preload="metadata"
                        controls={playing}
                        className="w-full h-full object-cover"
                        onPlay={() => { const t = videoRef.current ? videoRef.current.currentTime : 0; onPlay && onPlay(clip.start + t); }}
                        onPause={() => onPause && onPause()}
                        onTimeUpdate={(e) => { lastPreviewTimeRef.current = e.currentTarget.currentTime; }}
                        onEnded={() => { setPlaying(false); if (videoRef.current) videoRef.current.currentTime = 0; }}
                    />
                    )}
                    <button
                        onClick={(e) => { e.stopPropagation(); onTogglePick && onTogglePick(); }}
                        disabled={!onTogglePick}
                        aria-pressed={picked}
                        aria-label={`${picked ? 'Unpick' : 'Pick'} clip ${index + 1} for scheduling`}
                        title={picked ? 'Picked for scheduling' : 'Pick for scheduling'}
                        className={`absolute top-2 left-2 flex items-center gap-1.5 text-[10px] font-medium pl-1 pr-1.5 py-0.5 rounded transition-colors ${picked ? 'bg-viral text-black' : 'bg-black/65 text-white hover:bg-black/85'}`}
                    >
                        <span className={`size-3.5 rounded-[3px] border flex items-center justify-center ${picked ? 'bg-black/20 border-black/30' : 'border-white/50'}`}>
                            <Check size={9} className={picked ? 'opacity-100' : 'opacity-0'} />
                        </span>
                        Clip {index + 1}
                    </button>
                    <span className="absolute top-2 right-2 bg-black/65 text-white text-[11px] font-medium px-1.5 py-0.5 rounded tabular-nums">{fmtTime(durSec)}</span>

                    {!playing && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/25 transition-colors pointer-events-none">
                            <button
                                onClick={(e) => { e.stopPropagation(); setPlaying(true); if (!useFramingPreview) videoRef.current && videoRef.current.play(); }}
                                className="w-12 h-12 rounded-full bg-black/55 backdrop-blur flex items-center justify-center text-white pointer-events-auto hover:bg-black/75 active:scale-95 transition-all"
                                aria-label="Play clip"
                            >
                                <Play size={22} className="ml-0.5" />
                            </button>
                        </div>
                    )}

                </div>

                {confirmDelete && (
                    <div className="mt-2 p-2.5 rounded-lg border border-red-500/40 bg-red-500/10 animate-[fadeIn_0.15s_ease-out]">
                        <p className="text-[11px] text-red-200 leading-snug">
                            Delete clip {index + 1}? The video file goes too{scheduled ? ', though anything already scheduled still goes out' : ''}. This can't be undone.
                        </p>
                        <div className="flex items-center gap-1.5 mt-2">
                            <button
                                onClick={async (e) => {
                                    e.stopPropagation();
                                    setDeleting(true);
                                    await onDelete();
                                    setDeleting(false);
                                    setConfirmDelete(false);
                                }}
                                disabled={deleting}
                                className="flex items-center gap-1.5 text-[11px] text-red-200 border border-red-500/40 hover:bg-red-500/20 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                            >
                                {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />} Delete
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                                disabled={deleting}
                                className="text-[11px] text-muted hover:text-fg border border-edge hover:bg-white/5 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                            >
                                Keep it
                            </button>
                        </div>
                    </div>
                )}

                <h3 className="ph-mask mt-2.5 text-sm font-medium text-fg leading-snug line-clamp-2 cursor-pointer hover:text-white" onClick={() => setOpenIndex(index)} title="Open clip">
                    {title}
                </h3>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                    {hasScore && <ScoreBadge score={viralityScore} />}
                    {scheduled && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded"><Calendar size={10} /> Scheduled</span>
                    )}
                    {clip.viral_hook_text && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted bg-surface2 border border-edge px-1.5 py-0.5 rounded"><Wand2 size={10} /> Hook</span>
                    )}
                    <span className="text-[10px] text-muted bg-surface2 border border-edge px-1.5 py-0.5 rounded tabular-nums">{durSec}s</span>
                </div>
                <div className="flex items-center gap-1 mt-2">
                    <button onClick={(e) => { e.stopPropagation(); setShowModal(true); }} title="Post / schedule" className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"><Share2 size={15} /></button>
                    <button
                        onClick={(e) => { e.stopPropagation(); handleDownload(); }}
                        title={isRendering ? `Preparing… ${renderPct || ''}`.trim() : 'Download'}
                        disabled={isRendering}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        {isRendering ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                    </button>
                    {onDelete && (
                        <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                            title="Delete this clip"
                            aria-label={`Delete clip ${index + 1}`}
                            className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:text-red-300 hover:bg-white/5 transition-colors"
                        >
                            <Trash2 size={15} />
                        </button>
                    )}
                </div>
            </div>

            {/* Clip detail modal */}
            {isOpen && (
                <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-[fadeIn_0.2s_ease-out]" onClick={() => setOpenIndex(null)}>
                    <div className="absolute top-5 right-5 flex items-center gap-2 z-10">
                        <button disabled={prevIndex === null} onClick={(e) => { e.stopPropagation(); setOpenIndex(prevIndex); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 disabled:opacity-40 transition-colors" aria-label="Previous clip"><ArrowUp size={16} /></button>
                        <button disabled={nextIndex === null} onClick={(e) => { e.stopPropagation(); setOpenIndex(nextIndex); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 disabled:opacity-40 transition-colors" aria-label="Next clip"><ArrowDown size={16} /></button>
                        <button onClick={(e) => { e.stopPropagation(); setOpenIndex(null); }} className="w-9 h-9 rounded-lg bg-surface2 border border-edge text-fg flex items-center justify-center hover:bg-white/10 transition-colors" aria-label="Close"><X size={16} /></button>
                    </div>

                    <div className="bg-surface border border-edge rounded-2xl w-full max-w-4xl max-h-[88vh] overflow-hidden flex shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        {/* Preview */}
                        <div className="w-[clamp(200px,26vw,280px)] shrink-0 bg-black relative">
                            {useFramingPreview ? (
                                <RemotionPreview
                                    videoUrl={isEdited ? currentVideoUrl : originalVideoUrl}
                                    sourceVideoUrl={isEdited ? getApiUrl(clip.source_url) : null}
                                    framing={isEdited ? framingFull : null}
                                    durationInSeconds={effectiveDuration}
                                    subtitles={isEdited ? (framingFull.subtitles ?? null) : previewSubtitles}
                                    className="aspect-[9/16]"
                                    loop={false}
                                />
                            ) : (
                                <video src={currentVideoUrl} controls autoPlay playsInline className="w-full h-full object-cover aspect-[9/16]" />
                            )}
                            <span className="absolute top-3 right-3 bg-black/65 text-white text-[11px] font-medium px-1.5 py-0.5 rounded tabular-nums">{fmtTime(durSec)}</span>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 p-5 overflow-y-auto custom-scrollbar">
                            <h2 className="ph-mask text-base font-medium text-fg leading-snug">{title}</h2>
                            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                                {hasScore && <ScoreBadge score={viralityScore} />}
                                {clip.viral_hook_text && <span className="inline-flex items-center gap-1 text-[11px] text-muted bg-surface2 border border-edge px-2 py-0.5 rounded"><Wand2 size={11} /> Hook</span>}
                                <span className="text-[11px] text-muted bg-surface2 border border-edge px-2 py-0.5 rounded tabular-nums">{durSec}s</span>
                            </div>
                            {hasScore && (
                                <div className="mt-4 p-3 bg-surface2 border border-edge rounded-lg">
                                    <div className="flex items-center justify-between mb-2.5">
                                        <span className="flex items-center gap-1.5 text-xs font-medium text-fg"><Flame size={13} className={scoreTheme(viralityScore).text} /> Virality score</span>
                                        <span className={`text-lg font-bold tabular-nums ${scoreTheme(viralityScore).text}`}>{viralityScore}</span>
                                    </div>
                                    <div className="space-y-1.5">
                                        {Object.keys(BREAKDOWN_LABELS).map((k) => {
                                            const pv = num(breakdown[k]);
                                            const v = isNaN(pv) ? 0 : pv;
                                            return (
                                                <div key={k} className="flex items-center gap-2">
                                                    <span className="text-[10px] text-muted w-9 shrink-0">{BREAKDOWN_LABELS[k]}</span>
                                                    <div className="flex-1 h-1.5 bg-black/40 rounded-full overflow-hidden">
                                                        <div className={`h-full rounded-full ${scoreTheme(v).bar}`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
                                                    </div>
                                                    <span className="text-[10px] text-muted w-6 text-right tabular-nums">{v}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {clip.virality_reason && <p className="ph-mask text-[11px] text-muted leading-relaxed mt-2.5">{clip.virality_reason}</p>}
                                </div>
                            )}
                            {description && <p className="ph-mask text-sm text-muted leading-relaxed mt-4">{description}</p>}
                            {transcriptText && (
                                <div className="mt-5">
                                    <div className="flex items-center gap-1.5 text-xs text-muted mb-2"><FileText size={13} /> Transcript</div>
                                    <p className="ph-mask text-sm text-zinc-300 leading-relaxed">{transcriptText}</p>
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="w-[200px] shrink-0 border-l border-edge p-4 space-y-2 overflow-y-auto custom-scrollbar">
                            {clip.framing_url && clip.source_url && onEdit && (
                                <ActionBtn icon={Crop} label="Edit clip" primary data-tour="edit-clip" onClick={() => { setOpenIndex(null); onEdit(index); }} />
                            )}
                            <ActionBtn icon={Share2} label="Publish on Social" primary onClick={() => setShowModal(true)} />
                            <ActionBtn
                                icon={Download}
                                label={isRendering ? `Preparing… ${renderPct || ''}`.trim() : 'Download HD'}
                                loading={isRendering}
                                onClick={handleDownload}
                            />
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

                        {!zernioKey && (
                            <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 text-yellow-200 text-xs rounded-lg flex items-start gap-2">
                                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                                <div>Configure your Zernio API Key in Settings first.</div>
                            </div>
                        )}

                        <div className="space-y-4 mb-6">
                            {/* Title & Description */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Video Title</label>
                                <input
                                    type="text"
                                    data-posthog-sensitive="true"
                                    value={postTitle}
                                    onChange={(e) => setPostTitle(e.target.value)}
                                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm text-white focus:outline-none focus:border-primary/50 placeholder-zinc-600"
                                    placeholder="Enter a catchy title..."
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-1">Caption / Description</label>
                                <textarea
                                    data-posthog-sensitive="true"
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

                            {/* Accounts */}
                            <div>
                                <label className="block text-xs font-bold text-zinc-400 mb-2">Select Accounts</label>
                                {socialAccounts.length === 0 ? (
                                    <p className="text-xs text-zinc-500 p-3 bg-white/5 rounded-lg border border-white/5">
                                        No social accounts connected yet. Connect them in Settings → Social Integration.
                                    </p>
                                ) : (
                                    <div className="grid grid-cols-1 gap-2">
                                        {socialAccounts.map((acc) => {
                                            const isSelected = accountToggles[acc.id] ?? true;
                                            // Clamped so the readout, the preview seek and the slider
                                            // all agree after a trim shortens the clip.
                                            const coverMs = Math.min(igCoverMs[acc.id] || 0, coverMaxMs);
                                            // Bound by the posted file's own length — a trimmed edit is
                                            // shorter than the original, and an offset past its end is invalid.
                                            return (
                                            <div key={acc.id} className="bg-white/5 rounded-lg border border-white/5 overflow-hidden">
                                                <label className="flex items-center gap-3 p-3 cursor-pointer hover:bg-white/10 transition-colors">
                                                    <input
                                                        type="checkbox"
                                                        checked={isSelected}
                                                        onChange={(e) => setAccountToggles({ ...accountToggles, [acc.id]: e.target.checked })}
                                                        className="w-4 h-4 rounded border-zinc-600 bg-black/50 text-primary focus:ring-primary"
                                                    />
                                                    <div className="flex items-center gap-2 text-sm text-white">
                                                        {acc.platform === 'tiktok' ? <Video size={16} className="text-cyan-400" /> :
                                                         acc.platform === 'instagram' ? <Instagram size={16} className="text-pink-400" /> :
                                                         acc.platform === 'youtube' ? <Youtube size={16} className="text-red-400" /> :
                                                         <Share2 size={16} className="text-zinc-400" />}
                                                        <span className="ph-mask">{acc.displayName || acc.username}</span>
                                                        <span className="text-xs text-zinc-500 capitalize">{acc.platform}</span>
                                                    </div>
                                                </label>

                                                {/* YouTube: who can see the upload */}
                                                {isSelected && acc.platform === 'youtube' && (
                                                    <div className="px-3 pb-3 pt-2.5 border-t border-edge">
                                                        <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1.5">Who can see it</div>
                                                        <div className="flex gap-1 p-0.5 bg-black/40 border border-edge rounded-lg">
                                                            {YT_VISIBILITIES.map((v) => {
                                                                const active = (ytVisibility[acc.id] || 'public') === v.value;
                                                                return (
                                                                    <button
                                                                        key={v.value}
                                                                        type="button"
                                                                        onClick={() => setYtVisibility({ ...ytVisibility, [acc.id]: v.value })}
                                                                        className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${active ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}
                                                                    >
                                                                        {v.label}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                        {isScheduling && (
                                                            <p className="mt-2 text-[11px] text-muted leading-snug">
                                                                Scheduled uploads go up right away as private, then switch to your choice at the scheduled time.
                                                            </p>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Unexported edit: the preview below would lie, so don't offer it. */}
                                                {isSelected && acc.platform === 'instagram' && !coverMatchesPost && (
                                                    <div className="px-3 pb-3 pt-2.5 border-t border-edge">
                                                        <div className="text-[11px] font-bold text-muted uppercase tracking-wide mb-1.5">Reel cover</div>
                                                        <p className="text-[11px] text-muted leading-snug">
                                                            Your edit hasn&rsquo;t been exported yet, so we can&rsquo;t show you which frame
                                                            would land where. Export it now to pick a cover &mdash; otherwise we export it
                                                            when you publish and Instagram uses the first frame.
                                                        </p>
                                                        {/* ponytail: publishing exports anyway; this just does it early so the picker can appear. */}
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setPostResult(null);
                                                                ensureRenderedFile().catch((err) => setPostResult({
                                                                    success: false,
                                                                    msg: `Export failed: ${err.message || err}`,
                                                                }));
                                                            }}
                                                            disabled={isRendering}
                                                            className="mt-2 text-[11px] text-muted hover:text-fg underline underline-offset-2 disabled:opacity-50"
                                                        >
                                                            {isRendering ? `Exporting…${renderPct ? ` ${renderPct}` : ''}` : 'Export now'}
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Instagram: which frame of the clip becomes the Reel cover */}
                                                {isSelected && acc.platform === 'instagram' && coverMatchesPost && (
                                                    <div className="px-3 pb-3 pt-2.5 border-t border-edge">
                                                        <div className="flex items-center justify-between mb-1.5">
                                                            <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Reel cover</span>
                                                            <span className="text-[11px] text-muted tabular-nums">{(coverMs / 1000).toFixed(1)}s in</span>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            {/* Preview seeks a hair past 0 so the browser decodes and paints a
                                                                frame instead of leaving the thumbnail blank. */}
                                                            <video
                                                                ref={(el) => { coverPreviewRefs.current[acc.id] = el; }}
                                                                src={currentVideoUrl}
                                                                muted
                                                                playsInline
                                                                preload="metadata"
                                                                onLoadedMetadata={(e) => { e.currentTarget.currentTime = Math.max(coverMs / 1000, 0.04); }}
                                                                className="w-12 shrink-0 aspect-[9/16] rounded-md bg-black object-cover border border-edge"
                                                            />
                                                            <div className="flex-1 min-w-0">
                                                                <input
                                                                    type="range"
                                                                    min={0}
                                                                    max={coverMaxMs}
                                                                    step={100}
                                                                    value={coverMs}
                                                                    onChange={(e) => setCoverMs(acc.id, Number(e.target.value))}
                                                                    className="w-full accent-viral cursor-pointer"
                                                                />
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setCoverMs(acc.id, Math.min(
                                                                        Math.round((videoRef.current?.currentTime ?? lastPreviewTimeRef.current) * 1000),
                                                                        coverMaxMs,
                                                                    ))}
                                                                    className="mt-1.5 text-[11px] text-muted hover:text-fg underline underline-offset-2"
                                                                >
                                                                    Use the frame the clip is paused on
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {postResult && (
                            <div className={`mb-4 p-3 rounded-lg text-xs flex items-start gap-2 ${postResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                                {postResult.success ? <CheckCircle size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
                                <div>{postResult.msg}</div>
                            </div>
                        )}

                        {posting && isRendering && (
                            <p className="mb-3 text-xs text-zinc-400 text-center">
                                Preparing video…{renderPct ? ` ${renderPct}` : ''}
                            </p>
                        )}

                        <button
                            onClick={handlePost}
                            disabled={posting || !zernioKey}
                            className="w-full py-3 bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-bold transition-all flex items-center justify-center gap-2"
                        >
                            {posting ? (
                                <>
                                    <Loader2 size={16} className="animate-spin" />
                                    {isRendering
                                        ? `Preparing…${renderPct ? ` ${renderPct}` : ''}`
                                        : (isScheduling ? 'Scheduling...' : 'Publishing...')}
                                </>
                            ) : (
                                <><Share2 size={16} /> {isScheduling ? 'Schedule Post' : 'Publish Now'}</>
                            )}
                        </button>
                    </div>
                </div>
            )}

        </>
    );
}
