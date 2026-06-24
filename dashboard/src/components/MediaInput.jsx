import React, { useState, useEffect } from 'react';
import { Youtube, Upload, FileVideo, X, Scissors, Captions } from 'lucide-react';
import { getApiUrl } from '../config';
import { CAPTION_TEMPLATES } from '@remotion-src/lib/captionTemplates';
import { saveDefaultCaptionStyle, loadDefaultCaptionStyle } from './editor/useEditorState';
import CaptionPreview from './editor/CaptionPreview';

const WHISPER_MODELS = [
    { value: 'tiny', label: 'Tiny', help: 'Fastest, lowest accuracy' },
    { value: 'base', label: 'Base', help: 'Current default' },
    { value: 'small', label: 'Small', help: 'Better accuracy, slower' },
    { value: 'medium', label: 'Medium', help: 'Strong accuracy, much slower' },
    { value: 'large-v3-turbo', label: 'Large v3 Turbo', help: 'Near-best accuracy, much faster' },
    { value: 'large-v3', label: 'Large v3', help: 'Best accuracy, slowest' },
];

// Opus-style clip-length buckets. `auto` sends nothing → backend keeps its
// default 15–60s range and lets Gemini decide.
const CLIP_LENGTHS = [
    { value: 'auto', label: 'Auto (AI decides)', min: null, max: null },
    { value: 'lt30', label: 'Under 30s', min: 10, max: 30 },
    { value: '30-59', label: '30 – 59s', min: 30, max: 59 },
    { value: '60-89', label: '60 – 89s', min: 60, max: 89 },
    { value: '90-180', label: '90s – 3m', min: 90, max: 180 },
    { value: '180-300', label: '3 – 5m', min: 180, max: 300 },
    { value: '300-600', label: '5 – 10m', min: 300, max: 600 },
];

function ClipTab({ active, onClick, icon: Icon, label }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                active ? 'bg-white/10 text-fg' : 'text-muted hover:text-fg'
            }`}
        >
            <Icon size={14} />
            {label}
        </button>
    );
}

const ASPECT_RATIOS = [
    { value: '9:16', label: '9:16 · Reels / Shorts / TikTok' },
    { value: '1:1', label: '1:1 · Square' },
    { value: '4:5', label: '4:5 · Portrait' },
    { value: '16:9', label: '16:9 · Landscape' },
];

function fmtTime(s) {
    if (!Number.isFinite(s)) return '0:00';
    const sec = Math.max(0, Math.round(s));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export default function MediaInput({ onProcess, isProcessing, hasSonioxKey = false }) {
    const [youtubeUrlEnabled, setYoutubeUrlEnabled] = useState(true);
    const [mode, setMode] = useState('url'); // 'url' | 'file'
    const [url, setUrl] = useState('');
    const [files, setFiles] = useState([]);
    const [acknowledged, setAcknowledged] = useState(false);
    const [whisperModel, setWhisperModel] = useState('base');
    // 'whisper' = built-in (free, on-server) | 'soniox' = cloud API (multilingual)
    const [transcriptionEngine, setTranscriptionEngine] = useState('whisper');

    // Clip controls
    const [clipMode, setClipMode] = useState('ai'); // 'ai' | 'none'
    const [aspectRatio, setAspectRatio] = useState('9:16');
    const [clipLength, setClipLength] = useState('auto');
    const [momentPrompt, setMomentPrompt] = useState('');
    const [captionTemplate, setCaptionTemplate] = useState(() => {
        const d = loadDefaultCaptionStyle();
        return d?.enabled === true ? (d.style?.template ?? 'none') : 'none';
    });

    // Trim (Don't-clip mode, single file only — we can read its duration locally).
    // durMeta is tagged with the file it was measured for, so we derive `duration`
    // instead of resetting state synchronously when the file changes.
    const [durMeta, setDurMeta] = useState(null); // { file, duration }
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(0);

    useEffect(() => {
        fetch(getApiUrl('/api/config'))
            .then((r) => r.ok ? r.json() : null)
            .then((cfg) => {
                if (cfg && cfg.youtubeUrlEnabled === false) {
                    setYoutubeUrlEnabled(false);
                    setMode('file');
                }
            })
            .catch(() => {});
    }, []);

    // Read duration of a single uploaded file so the trim slider has bounds.
    const singleFile = mode === 'file' && files.length === 1 ? files[0] : null;
    const duration = durMeta && durMeta.file === singleFile ? durMeta.duration : null;
    useEffect(() => {
        if (!singleFile) return;
        const objUrl = URL.createObjectURL(singleFile);
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => {
            const d = v.duration;
            if (Number.isFinite(d) && d > 0) {
                setDurMeta({ file: singleFile, duration: d });
                setTrimStart(0);
                setTrimEnd(d);
            }
            URL.revokeObjectURL(objUrl);
        };
        v.onerror = () => URL.revokeObjectURL(objUrl);
        v.src = objUrl;
        return () => URL.revokeObjectURL(objUrl);
    }, [singleFile]);

    const pickCaption = (tpl) => {
        if (!tpl) {
            // "No caption": keep the style but record intent so clips don't auto-caption.
            setCaptionTemplate('none');
            const cur = loadDefaultCaptionStyle();
            saveDefaultCaptionStyle(cur?.position || 'bottom', cur?.style || {}, false);
            return;
        }
        setCaptionTemplate(tpl.id);
        // Persist as the user's default caption style AND opt new clips into
        // captions; the editor seeds + auto-enables from this same key.
        saveDefaultCaptionStyle('bottom', { ...tpl.defaultStyle, template: tpl.id }, true);
    };

    const buildClipSettings = () => {
        const length = CLIP_LENGTHS.find((c) => c.value === clipLength) ?? CLIP_LENGTHS[0];
        const settings = {
            clipMode,
            aspectRatio,
            captionTemplate: captionTemplate === 'none' ? null : captionTemplate,
        };
        if (clipMode === 'ai') {
            if (length.min != null) settings.minClipLength = length.min;
            if (length.max != null) settings.maxClipLength = length.max;
            if (momentPrompt.trim()) settings.momentPrompt = momentPrompt.trim();
        } else {
            settings.skipAnalysis = true;
            // Trim only applies to a single uploaded file with a known duration.
            if (singleFile && duration && (trimStart > 0 || trimEnd < duration)) {
                settings.trimStart = Math.round(trimStart);
                settings.trimEnd = Math.round(trimEnd);
            }
        }
        return settings;
    };

    // Soniox is bring-your-own key: don't let a submission go out without one
    // (the backend would reject it and the files would already be cleared).
    const sonioxBlocked = transcriptionEngine === 'soniox' && !hasSonioxKey;

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!acknowledged || sonioxBlocked) return;
        const clip = buildClipSettings();
        if (mode === 'url' && url) {
            onProcess({ type: 'url', payload: url, acknowledged: true, whisperModel, transcriptionEngine, ...clip });
        } else if (mode === 'file' && files.length > 0) {
            // Clear the selected files only after the job is accepted, so a
            // failed submit doesn't lose the user's selection.
            const ok = await onProcess({ type: 'files', payload: files, acknowledged: true, whisperModel, transcriptionEngine, ...clip });
            if (ok !== false) setFiles([]);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            setFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/')));
            setMode('file');
        }
    };

    const removeFile = (fileToRemove) => {
        setFiles((current) => current.filter((f) => f !== fileToRemove));
    };

    return (
        <div className="bg-surface border border-edge rounded-xl p-5 animate-[fadeIn_0.6s_ease-out]">
            <div className="flex gap-5 mb-5 border-b border-edge pb-3 text-sm">
                {youtubeUrlEnabled && (
                    <button
                        onClick={() => setMode('url')}
                        className={`flex items-center gap-2 pb-2 transition-all ${mode === 'url'
                            ? 'text-fg border-b-2 border-fg -mb-[14px]'
                            : 'text-muted hover:text-fg'
                            }`}
                    >
                        <Youtube size={17} />
                        YouTube URL
                    </button>
                )}
                <button
                    onClick={() => setMode('file')}
                    className={`flex items-center gap-2 pb-2 transition-all ${mode === 'file'
                        ? 'text-fg border-b-2 border-fg -mb-[14px]'
                        : 'text-muted hover:text-fg'
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
                        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${files.length > 0 ? 'border-primary/50 bg-primary/5' : 'border-zinc-700 hover:border-zinc-500 bg-white/5'
                            }`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {files.length > 0 ? (
                            <div className="space-y-3 text-white">
                                <div className="flex items-center justify-center gap-2 text-sm text-primary">
                                    <FileVideo size={18} />
                                    <span className="font-medium">{files.length} video{files.length === 1 ? '' : 's'} ready</span>
                                </div>
                                <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-2">
                                    {files.map((selectedFile) => (
                                        <div key={`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified}`} className="flex items-center gap-3 bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-left">
                                            <FileVideo size={16} className="text-primary shrink-0" />
                                            <span className="font-medium text-sm truncate flex-1">{selectedFile.name}</span>
                                            <span className="text-xs text-zinc-500 shrink-0">{(selectedFile.size / 1024 / 1024).toFixed(1)} MB</span>
                                            <button
                                                type="button"
                                                onClick={() => removeFile(selectedFile)}
                                                className="p-1 hover:bg-white/10 rounded-full shrink-0"
                                                aria-label={`Remove ${selectedFile.name}`}
                                            >
                                                <X size={16} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <label className="inline-flex cursor-pointer text-xs text-zinc-400 hover:text-white">
                                    <input
                                        type="file"
                                        accept="video/*"
                                        multiple
                                        onChange={(e) => setFiles(Array.from(e.target.files || []))}
                                        className="hidden"
                                    />
                                    Add different videos
                                </label>
                            </div>
                        ) : (
                            <label className="cursor-pointer block">
                                <input
                                    type="file"
                                    accept="video/*"
                                    multiple
                                    onChange={(e) => setFiles(Array.from(e.target.files || []))}
                                    className="hidden"
                                />
                                <Upload className="mx-auto mb-3 text-zinc-500" size={24} />
                                <p className="text-zinc-400">Click to upload videos or drag and drop</p>
                                <p className="text-xs text-zinc-600 mt-1">Select multiple MP4 or MOV files</p>
                            </label>
                        )}
                    </div>
                )}

                {/* Clip mode */}
                <div className="mt-5 bg-black/20 border border-edge rounded-xl p-4">
                    <div className="flex gap-1 mb-4 p-1 bg-black/30 rounded-lg w-fit">
                        <ClipTab active={clipMode === 'ai'} onClick={() => setClipMode('ai')} icon={Scissors} label="AI clipping" />
                        <ClipTab active={clipMode === 'none'} onClick={() => setClipMode('none')} icon={Captions} label="Don't clip" />
                    </div>

                    <label className="block mb-4">
                        <span className="block text-xs font-medium text-zinc-400 mb-2">Aspect ratio</span>
                        <select
                            value={aspectRatio}
                            onChange={(e) => setAspectRatio(e.target.value)}
                            className="input-field cursor-pointer"
                        >
                            {ASPECT_RATIOS.map((a) => (
                                <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                        </select>
                    </label>

                    {clipMode === 'ai' ? (
                        <div className="space-y-4">
                            <label className="block">
                                <span className="block text-xs font-medium text-zinc-400 mb-2">Clip length</span>
                                <select
                                    value={clipLength}
                                    onChange={(e) => setClipLength(e.target.value)}
                                    className="input-field cursor-pointer"
                                >
                                    {CLIP_LENGTHS.map((c) => (
                                        <option key={c.value} value={c.value}>{c.label}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="block">
                                <span className="block text-xs font-medium text-zinc-400 mb-2">Include specific moments <span className="text-zinc-600">(optional)</span></span>
                                <textarea
                                    value={momentPrompt}
                                    onChange={(e) => setMomentPrompt(e.target.value)}
                                    rows={2}
                                    placeholder="e.g. find moments where we talk about pricing, or the funniest reactions"
                                    className="input-field resize-none"
                                />
                            </label>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-xs text-zinc-400">We keep the full video (no viral detection) and just reframe + caption it.</p>
                            {singleFile && duration ? (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between text-xs text-zinc-300 tabular-nums">
                                        <span>Trim: {fmtTime(trimStart)}</span>
                                        <span>{fmtTime(trimEnd)}</span>
                                    </div>
                                    <label className="block">
                                        <span className="block text-[11px] text-zinc-500 mb-1">Start</span>
                                        <input
                                            type="range" min={0} max={duration} step={1} value={trimStart}
                                            onChange={(e) => setTrimStart(Math.min(Number(e.target.value), trimEnd - 1))}
                                            className="w-full accent-primary cursor-pointer"
                                        />
                                    </label>
                                    <label className="block">
                                        <span className="block text-[11px] text-zinc-500 mb-1">End</span>
                                        <input
                                            type="range" min={0} max={duration} step={1} value={trimEnd}
                                            onChange={(e) => setTrimEnd(Math.max(Number(e.target.value), trimStart + 1))}
                                            className="w-full accent-primary cursor-pointer"
                                        />
                                    </label>
                                </div>
                            ) : (
                                <p className="text-[11px] text-zinc-600">
                                    {mode === 'file' && files.length > 1
                                        ? 'Trimming applies to single uploads — each video is processed in full.'
                                        : 'Upload a single file to trim a specific time range. URLs are processed in full.'}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* Caption preset strip */}
                <div className="mt-4">
                    <span className="block text-xs font-medium text-zinc-400 mb-2">Caption style <span className="text-zinc-600">(applied when you add captions in the editor)</span></span>
                    <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2">
                        <button
                            type="button"
                            onClick={() => pickCaption(null)}
                            className={`shrink-0 w-24 h-16 rounded-lg border flex flex-col items-center justify-center gap-1 transition-colors ${
                                captionTemplate === 'none' ? 'bg-viral/15 border-viral/50' : 'border-edge bg-surface2/50 hover:bg-white/5'
                            }`}
                        >
                            <X size={16} className="text-muted" />
                            <span className="text-[10px] text-muted">No caption</span>
                        </button>
                        {CAPTION_TEMPLATES.map((tpl) => (
                            <button
                                key={tpl.id}
                                type="button"
                                onClick={() => pickCaption(tpl)}
                                title={tpl.label}
                                className={`shrink-0 w-24 h-16 px-1 rounded-lg border flex flex-col items-center justify-center gap-1 overflow-hidden transition-colors ${
                                    captionTemplate === tpl.id ? 'bg-viral/15 border-viral/50' : 'border-edge bg-surface2/50 hover:bg-white/5'
                                }`}
                            >
                                <span className="flex items-center justify-center h-7 overflow-hidden">
                                    <CaptionPreview templateId={tpl.id} previewFontPx={15} />
                                </span>
                                <span className="block text-[9px] text-muted truncate max-w-full">{tpl.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

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
                    {transcriptionEngine === 'soniox' && !hasSonioxKey && (
                        <span className="block text-[11px] text-amber-400/90 mt-2">
                            Add your Soniox API key in Settings to use this engine.
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
                        I confirm I own this content or have the rights to process it. I am responsible for any content I submit. See our <a href="/#legal" target="_blank" rel="noopener noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>Terms & Privacy</a>.
                    </span>
                </label>

                <button
                    type="submit"
                    disabled={!acknowledged || sonioxBlocked || (mode === 'url' && !url) || (mode === 'file' && files.length === 0)}
                    className="w-full mt-4 py-3 rounded-lg bg-fg text-[#18181b] font-medium text-sm hover:bg-white active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                    {isProcessing ? (
                        <>
                            Add to processing queue
                        </>
                    ) : (
                        <>
                            {mode === 'file' && files.length > 1 ? `Generate clips for ${files.length} videos` : clipMode === 'none' ? 'Process video' : 'Generate clips'}
                        </>
                    )}
                </button>
            </form>
        </div>
    );
}
