import React, { useState, useEffect } from 'react';
import { Youtube, Upload, FileVideo, X } from 'lucide-react';
import { getApiUrl } from '../config';

const WHISPER_MODELS = [
    { value: 'tiny', label: 'Tiny', help: 'Fastest, lowest accuracy' },
    { value: 'base', label: 'Base', help: 'Current default' },
    { value: 'small', label: 'Small', help: 'Better accuracy, slower' },
    { value: 'medium', label: 'Medium', help: 'Strong accuracy, much slower' },
    { value: 'large-v3', label: 'Large v3', help: 'Best accuracy, slowest' },
];

export default function MediaInput({ onProcess, isProcessing }) {
    const [youtubeUrlEnabled, setYoutubeUrlEnabled] = useState(true);
    const [mode, setMode] = useState('url'); // 'url' | 'file'
    const [url, setUrl] = useState('');
    const [files, setFiles] = useState([]);
    const [acknowledged, setAcknowledged] = useState(false);
    const [whisperModel, setWhisperModel] = useState('base');

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

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!acknowledged) return;
        if (mode === 'url' && url) {
            onProcess({ type: 'url', payload: url, acknowledged: true, whisperModel });
        } else if (mode === 'file' && files.length > 0) {
            onProcess({ type: 'files', payload: files, acknowledged: true, whisperModel });
            setFiles([]);
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

                <label className="block mt-5">
                    <span className="block text-xs font-medium text-zinc-400 mb-2">Whisper model</span>
                    <select
                        value={whisperModel}
                        onChange={(e) => setWhisperModel(e.target.value)}
                        className="input-field cursor-pointer"
                    >
                        {WHISPER_MODELS.map((model) => (
                            <option key={model.value} value={model.value}>
                                {model.label} - {model.help}
                            </option>
                        ))}
                    </select>
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
                    disabled={!acknowledged || (mode === 'url' && !url) || (mode === 'file' && files.length === 0)}
                    className="w-full mt-4 py-3 rounded-lg bg-fg text-[#18181b] font-medium text-sm hover:bg-white active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                    {isProcessing ? (
                        <>
                            Add to processing queue
                        </>
                    ) : (
                        <>
                            {mode === 'file' && files.length > 1 ? `Generate clips for ${files.length} videos` : 'Generate clips'}
                        </>
                    )}
                </button>
            </form>
        </div>
    );
}
