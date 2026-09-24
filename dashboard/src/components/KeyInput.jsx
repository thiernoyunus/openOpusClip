import React, { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, Check } from 'lucide-react';
import { getApiUrl } from '../config';
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS } from '../lib/geminiModels';
import {
    AI_PROVIDERS, getAiProvider, setAiProvider, getProviderConfig, saveProviderConfig, providerHeaders,
} from '../lib/aiSettings';

const TYPE_OWN = '__type_own__';

function SecretField({ savedValue, onSave, placeholder, dataTour }) {
    const [value, setValue] = useState(savedValue || '');
    const [isVisible, setIsVisible] = useState(false);
    const [isSaved, setIsSaved] = useState(!!savedValue);

    const handleSave = () => {
        if (value.trim().length > 0) {
            onSave(value.trim());
            setIsSaved(true);
        }
    };

    return (
        <div className="flex gap-3">
            <div className="relative flex-1">
                <input
                    type={isVisible ? "text" : "password"}
                    value={value}
                    data-tour={dataTour}
                    data-posthog-sensitive="true"
                    onChange={(e) => {
                        setValue(e.target.value);
                        setIsSaved(false);
                    }}
                    placeholder={placeholder}
                    className="input-field pr-12 font-mono"
                />
                <button
                    onClick={() => setIsVisible(!isVisible)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white transition-colors"
                >
                    {isVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
            </div>
            <button
                onClick={handleSave}
                disabled={!value || isSaved}
                className={`px-6 rounded-xl font-medium transition-all flex items-center gap-2 ${isSaved
                    ? 'bg-green-500/20 text-green-400 cursor-default'
                    : 'bg-primary hover:bg-blue-600 text-white shadow-lg shadow-primary/20'
                    }`}
            >
                {isSaved ? <><Check size={18} /> Ready</> : 'Set Key'}
            </button>
        </div>
    );
}

// Live model list for one provider. null = not loaded (no key yet, or failed).
function useProviderModels(provider, key, baseUrl) {
    // OpenRouter lists models without a key; custom local servers may not need one.
    const canList = key || provider === 'openrouter' || (provider === 'custom' && baseUrl);
    const request = canList ? JSON.stringify([provider, key, baseUrl]) : '';
    const [result, setResult] = useState({ request: '', models: null, error: '' });

    useEffect(() => {
        if (!request) return undefined;
        let cancelled = false;
        const [p, k, b] = JSON.parse(request);
        fetch(getApiUrl('/api/ai/models'), { headers: providerHeaders(p, { key: k, baseUrl: b }) })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.detail || `Could not load models (${res.status})`);
                if (!cancelled) setResult({ request, models: data.models || [], error: '' });
            })
            .catch((e) => { if (!cancelled) setResult({ request, models: null, error: e.message }); });
        return () => { cancelled = true; };
    }, [request]);

    // Ignore a result from a previous provider/key.
    return request && result.request === request ? result : { models: null, error: '' };
}

export default function KeyInput({ onKeySet, savedKey, savedModel = DEFAULT_GEMINI_MODEL, onModelChange }) {
    const [provider, setProvider] = useState(getAiProvider);
    const [config, setConfig] = useState(() => getProviderConfig(getAiProvider()));
    const [typingModel, setTypingModel] = useState(false);
    const isGemini = provider === 'gemini';
    const info = AI_PROVIDERS.find((p) => p.id === provider);

    const key = isGemini ? savedKey : config.key;
    const model = isGemini ? savedModel : config.model;
    const { models, error } = useProviderModels(provider, key, config.baseUrl);

    // Before the live list loads, Gemini still shows its known models.
    const shown = models || (isGemini
        ? GEMINI_MODELS.map((m) => ({ id: m.value, label: m.label, recommended: false, free: true }))
        : []);

    const setModel = (value) => {
        if (isGemini) onModelChange?.(value);
        else updateConfig({ model: value });
    };
    const updateConfig = (patch) => {
        saveProviderConfig(provider, patch);
        setConfig(getProviderConfig(provider));
    };

    // A provider with no model picked yet gets the top of its list (recommended first).
    useEffect(() => {
        if (!model && models?.length) setModel(models[0].id);
    }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

    const changeProvider = (next) => {
        setAiProvider(next);
        setProvider(next);
        setConfig(getProviderConfig(next));
        setTypingModel(false);
    };

    const geminiKeyBlock = (
        <div>
            <label className="block text-sm text-zinc-300 mb-2">Gemini API key</label>
            <SecretField savedValue={savedKey} onSave={onKeySet} placeholder="AIzaSy..." dataTour="gemini-key-input" />
        </div>
    );

    const inList = shown.some((m) => m.id === model);
    // The typed-name box sits under the dropdown, so the list is always one click away.
    const customModel = typingModel || (!!model && !inList);

    return (
        <div data-tour="settings-page" className="bg-surface border border-white/5 rounded-2xl p-6 mb-8 animate-[fadeIn_0.5s_ease-out]">
            <div className="flex items-center gap-3 mb-4">
                <div className="p-2 bg-accent/20 rounded-lg text-accent">
                    <Key size={20} />
                </div>
                <h2 className="text-lg font-semibold">AI Model</h2>
            </div>
            <p className="text-sm text-zinc-400 mb-4 -mt-2">
                The AI that reads your video and finds the best moments — required to make clips.
            </p>

            <label htmlFor="ai-provider" className="block text-sm text-zinc-300 mb-2">Provider</label>
            <select
                id="ai-provider"
                value={provider}
                onChange={(e) => changeProvider(e.target.value)}
                className="input-field w-full"
            >
                {AI_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                ))}
            </select>
            {info?.help && <p className="mt-2 text-xs text-zinc-500">{info.help}</p>}

            <div className="mt-6">
                {isGemini ? geminiKeyBlock : (
                    <>
                        {provider === 'custom' && (
                            <div className="mb-4">
                                <label htmlFor="ai-base-url" className="block text-sm text-zinc-300 mb-2">API address</label>
                                <input
                                    id="ai-base-url"
                                    defaultValue={config.baseUrl}
                                    onBlur={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
                                    placeholder="http://localhost:11434/v1"
                                    className="input-field w-full font-mono"
                                />
                            </div>
                        )}
                        <label className="block text-sm text-zinc-300 mb-2">
                            {info.label} API key{provider === 'custom' ? ' (if it needs one)' : ''}
                        </label>
                        <SecretField
                            key={provider}
                            savedValue={config.key}
                            onSave={(value) => updateConfig({ key: value })}
                            placeholder="Paste your key"
                        />
                    </>
                )}
            </div>

            <div className="mt-6">
                <label htmlFor="ai-model" className="block text-sm text-zinc-300 mb-2">Model</label>
                <select
                    id="ai-model"
                    value={customModel ? TYPE_OWN : model}
                    onChange={(e) => {
                        const value = e.target.value;
                        setTypingModel(value === TYPE_OWN);
                        if (value !== TYPE_OWN) setModel(value);
                    }}
                    className="input-field w-full"
                >
                    {!shown.length && (
                        <option value="" disabled>{key ? 'Loading models…' : 'Add your key to load models'}</option>
                    )}
                    {shown.map((m) => (
                        <option key={m.id} value={m.id}>
                            {m.recommended ? '★ ' : ''}{m.label}{m.free ? ' · Free' : ''}
                        </option>
                    ))}
                    <option value={TYPE_OWN}>Custom model name…</option>
                </select>
                {customModel && (
                    <input
                        key={provider}
                        aria-label="Custom model name"
                        defaultValue={inList ? '' : model}
                        onBlur={(e) => e.target.value.trim() && setModel(e.target.value.trim())}
                        placeholder={isGemini ? DEFAULT_GEMINI_MODEL : 'Type the exact model name, e.g. deepseek-v4-pro'}
                        className="input-field w-full font-mono mt-3"
                    />
                )}
                {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
                <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
                    The list comes live from {info.label}, so new models show up on their own. ★ marks our picks; Free means it works on a free key.
                    This model handles clip detection, trailers, captions and b-roll.
                </p>
            </div>

            <p className="mt-3 text-sm text-zinc-400">
                Your keys stay local. The app stores them in the browser{isGemini ? ' and syncs the Gemini key to your OS keychain for the local MCP' : ''}.
                {info?.keyUrl && (
                    <>
                        <br />
                        <a
                            href={info.keyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-tour={isGemini ? 'gemini-key-link' : undefined}
                            className="text-primary hover:underline mt-1 inline-block"
                        >
                            {isGemini ? 'Get your free Gemini API Key here →' : `Get your ${info.label} key here →`}
                        </a>
                    </>
                )}
                {isGemini && (
                    <>
                        <br />
                        <a
                            href="https://www.youtube.com/watch?v=YdalQ8UqMR4"
                            target="_blank"
                            rel="noopener noreferrer"
                            data-tour="gemini-key-video"
                            className="text-primary hover:underline mt-1 inline-block"
                        >
                            Watch a video tutorial on getting your key →
                        </a>
                    </>
                )}
            </p>
        </div>
    );
}
