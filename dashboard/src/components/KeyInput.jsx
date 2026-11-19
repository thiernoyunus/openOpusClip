import React, { useState, useEffect, useRef } from 'react';
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

const MANAGE_USAGE_URL = 'https://chatgpt.com/#settings';
const WELCOME_SEEN_KEY = 'chatgpt_plan_welcome_seen';

// Sign in with ChatGPT. The backend runs the sign-in and keeps the tokens in a
// private file on this computer; here we only start it and watch its status.
function ChatGPTSignIn({ onStatus }) {
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [welcomeSeen, setWelcomeSeen] = useState(() => {
        try { return localStorage.getItem(WELCOME_SEEN_KEY) === '1'; } catch { return true; }
    });
    const pollRef = useRef(null);
    const onStatusRef = useRef(onStatus);
    useEffect(() => { onStatusRef.current = onStatus; });

    const load = async () => {
        const res = await fetch(getApiUrl('/api/ai/chatgpt/status'));
        if (!res.ok) throw new Error(`Couldn't check ChatGPT sign-in (${res.status})`);
        const data = await res.json();
        setStatus(data);
        onStatusRef.current?.(data);
        return data;
    };

    const stopPolling = () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
    };

    useEffect(() => {
        let cancelled = false;
        fetch(getApiUrl('/api/ai/chatgpt/status'))
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Couldn't check ChatGPT sign-in (${res.status})`))))
            .then((data) => {
                if (cancelled) return;
                setStatus(data);
                onStatusRef.current?.(data);
            })
            .catch((e) => { if (!cancelled) setError(e.message); });
        return () => {
            cancelled = true;
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    const signIn = async () => {
        setBusy(true);
        setError('');
        // Open the tab first, in the click itself, so popup blockers allow it.
        const tab = window.open('about:blank', '_blank');
        try {
            const res = await fetch(getApiUrl('/api/ai/chatgpt/login'), { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || `Couldn't start sign-in (${res.status})`);
            if (tab && !tab.closed) tab.location.href = data.url;
            else window.open(data.url, '_blank');
            stopPolling();
            const started = Date.now();
            pollRef.current = setInterval(async () => {
                try {
                    const s = await load();
                    if (s.signed_in || s.error || (!s.pending && Date.now() - started > 5000)) {
                        stopPolling();
                        setBusy(false);
                        if (s.error) setError(s.error);
                    }
                } catch (e) {
                    stopPolling();
                    setBusy(false);
                    setError(e.message);
                }
            }, 2000);
        } catch (e) {
            if (tab && !tab.closed) tab.close();
            setBusy(false);
            setError(e.message);
        }
    };

    const signOut = async () => {
        stopPolling();
        setBusy(true);
        try {
            const res = await fetch(getApiUrl('/api/ai/chatgpt/logout'), { method: 'POST' });
            if (!res.ok) throw new Error(`Couldn't sign out (${res.status})`);
            await load();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };

    const signedIn = status?.signed_in;
    const planOk = status?.plan_usage;

    return (
        <div>
            {signedIn ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-4 py-3">
                    <div className="text-sm">
                        <div className="text-zinc-200 flex items-center gap-2">
                            <Check size={16} className="text-green-400" />
                            Signed in{status.email ? ` as ${status.email}` : ''}
                        </div>
                        {!planOk && (
                            <div className="text-xs text-amber-400 mt-1">
                                You didn&apos;t allow &quot;Use your ChatGPT plan&quot;. Sign out and sign in again to allow it.
                            </div>
                        )}
                    </div>
                    <button onClick={signOut} disabled={busy} className="text-sm text-zinc-400 hover:text-white">
                        Sign out
                    </button>
                </div>
            ) : (
                <button
                    onClick={signIn}
                    disabled={busy}
                    className="w-full px-6 py-3 rounded-xl font-medium bg-white text-black hover:bg-zinc-200 transition-all disabled:opacity-60"
                >
                    {busy ? 'Waiting for ChatGPT sign-in…' : 'Continue with ChatGPT'}
                </button>
            )}
            {busy && !signedIn && (
                <p className="mt-2 text-xs text-zinc-500">Finish signing in on the ChatGPT page that just opened, then come back here.</p>
            )}
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
            {signedIn && planOk && !welcomeSeen && (
                <div className="mt-3 rounded-xl bg-primary/10 border border-primary/20 p-3 text-sm text-zinc-300">
                    You&apos;re using your ChatGPT plan. Clip finding, trailers, captions and b-roll count against your
                    plan&apos;s usage limits instead of an API bill.
                    <button
                        onClick={() => {
                            try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* private window */ }
                            setWelcomeSeen(true);
                        }}
                        className="ml-2 text-primary hover:underline"
                    >
                        Got it
                    </button>
                </div>
            )}
            <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
                Works with an eligible ChatGPT plan (Plus or Pro). Requests share your plan&apos;s limits with ChatGPT and other apps.
            </p>
        </div>
    );
}

// Live model list for one provider. null = not loaded (no key yet, or failed).
function useProviderModels(provider, key, baseUrl, signedIn) {
    // OpenRouter lists models without a key; custom local servers may not need one.
    // ChatGPT lists the signed-in plan's models (key stands in for the account).
    const canList = provider === 'chatgpt' ? signedIn
        : key || provider === 'openrouter' || (provider === 'custom' && baseUrl);
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
    const isChatGPT = provider === 'chatgpt';
    const info = AI_PROVIDERS.find((p) => p.id === provider);

    const key = isGemini ? savedKey : config.key;
    const model = isGemini ? savedModel : config.model;
    const { models, error } = useProviderModels(
        provider, isChatGPT ? config.account || '' : key, config.baseUrl, isChatGPT && !!config.signedIn);

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

    const chatgptStatus = (s) => {
        const signedIn = !!(s.signed_in && s.plan_usage);
        const account = s.email || '';
        if (signedIn !== !!config.signedIn || account !== (config.account || '')) {
            updateConfig({ signedIn, account });
        }
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
                {isGemini ? geminiKeyBlock : isChatGPT ? (
                    <ChatGPTSignIn key="chatgpt" onStatus={chatgptStatus} />
                ) : (
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
                        <option value="" disabled>
                            {isChatGPT
                                ? (config.signedIn ? 'Loading models…' : 'Sign in to load models')
                                : (key ? 'Loading models…' : 'Add your key to load models')}
                        </option>
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
                {isChatGPT && config.signedIn && (
                    <p className="mt-2 text-xs text-zinc-300">
                        Using ChatGPT plan ·{' '}
                        <a href={MANAGE_USAGE_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Manage usage
                        </a>
                    </p>
                )}
                <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
                    The list comes live from {info.label}, so new models show up on their own. ★ marks our picks; Free means it works on a free key.
                    This model handles clip detection, trailers, captions and b-roll.
                </p>
            </div>

            <p className="mt-3 text-sm text-zinc-400">
                {isChatGPT
                    ? 'Your ChatGPT sign-in stays on this computer, in a private file only the app reads. It never goes into the browser.'
                    : <>Your keys stay local. The app stores them in the browser{isGemini ? ' and syncs the Gemini key to your OS keychain for the local MCP' : ''}.</>}
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
