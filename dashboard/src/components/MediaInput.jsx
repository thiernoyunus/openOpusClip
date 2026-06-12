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
    const [file, setFile] = useState(null);
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
        } else if (mode === 'file' && file) {
            onProcess({ type: 'file', payload: file, acknowledged: true, whisperModel });
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
            setMode('file');
        }
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
                        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${file ? 'border-primary/50 bg-primary/5' : 'border-zinc-700 hover:border-zinc-500 bg-white/5'
                            }`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {file ? (
                            <div className="flex items-center justify-center gap-3 text-white">
                                <FileVideo className="text-primary" />
                                <span className="font-medium">{file.name}</span>
                                <button
                                    type="button"
                                    onClick={() => setFile(null)}
                                    className="p-1 hover:bg-white/10 rounded-full"
                                >
                                    <X size={16} />
                                </button>
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
                                <p className="text-zinc-400">Click to upload or drag and drop</p>
                                <p className="text-xs text-zinc-600 mt-1">MP4, MOV up to 500MB</p>
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
                    disabled={isProcessing || !acknowledged || (mode === 'url' && !url) || (mode === 'file' && !file)}
                    className="w-full mt-4 py-3 rounded-lg bg-fg text-[#18181b] font-medium text-sm hover:bg-white active:scale-[0.99] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                    {isProcessing ? (
                        <>
                            <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            Processing video...
                        </>
                    ) : (
                        <>
                            Generate clips
                        </>
                    )}
                </button>
            </form>
        </div>
    );
}
