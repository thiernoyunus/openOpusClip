// Which AI answers the text prompts (clip finding, trailer, captions, b-roll).
// Gemini keeps its own storage ('gemini_key' / 'gemini_model') because
// thumbnails always use it; other providers live in one encrypted blob.
import { encrypt, decrypt } from './secretBox';
import { GEMINI_MODEL_STORAGE_KEY, getStoredGeminiModel } from './geminiModels';

const PROVIDER_KEY = 'ai_provider';
const CONFIG_KEY = 'ai_providers_v1';
export const AI_SETTINGS_EVENT = 'ai-settings-changed';

// Built-in providers. Must match PROVIDERS in llm.py.
export const AI_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', help: 'Default. Free key available.', keyUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'chatgpt', label: 'ChatGPT (sign in)', help: 'Use your ChatGPT plan instead of an API key. Sign in with your ChatGPT account.' },
  { id: 'openrouter', label: 'OpenRouter', help: 'One key for Claude, GPT, Grok, DeepSeek, MiMo and more.', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', keyUrl: 'https://console.x.ai' },
  { id: 'mimo', label: 'Xiaomi MiMo', keyUrl: 'https://platform.xiaomimimo.com' },
];

// The wire format a custom provider speaks. Must match API_FORMATS in llm.py.
export const API_FORMATS = [
  { id: 'openai', label: 'Chat completions (/chat/completions)' },
  { id: 'anthropic', label: 'Anthropic messages (/v1/messages)' },
  { id: 'responses', label: 'Responses (/responses)' },
];

// Custom providers the user added: ids 'custom:<n>'. 'custom' is the single
// unnamed one from before they had names.
export const isCustomProvider = (id) => id === 'custom' || String(id).startsWith('custom:');

const readConfigs = () => {
  try {
    return JSON.parse(decrypt(localStorage.getItem(CONFIG_KEY) || '') || '{}');
  } catch {
    return {};
  }
};

const writeConfigs = (all) => localStorage.setItem(CONFIG_KEY, encrypt(JSON.stringify(all)));

export const getCustomProviders = () => Object.entries(readConfigs())
  .filter(([id, cfg]) => isCustomProvider(id) && cfg?.baseUrl)
  .map(([id, cfg]) => ({ id, label: cfg.name || 'Custom', custom: true }));

export const listProviders = () => [...AI_PROVIDERS, ...getCustomProviders()];

export const getAiProvider = () => {
  const stored = localStorage.getItem(PROVIDER_KEY);
  return listProviders().some((p) => p.id === stored) ? stored : 'gemini';
};

// { key, model, baseUrl, ... } for one provider. Custom ones also carry
// name, format and models (the ones typed in by hand).
export const getProviderConfig = (provider) => {
  if (provider === 'gemini') {
    return { key: localStorage.getItem('gemini_key') || '', model: getStoredGeminiModel(), baseUrl: '' };
  }
  const base = { key: '', model: '', baseUrl: '' };
  if (isCustomProvider(provider)) Object.assign(base, { name: 'Custom', format: 'openai', models: [] });
  return { ...base, ...(readConfigs()[provider] || {}) };
};

const changed = () => window.dispatchEvent(new Event(AI_SETTINGS_EVENT));

export const setAiProvider = (provider) => {
  localStorage.setItem(PROVIDER_KEY, provider);
  changed();
};

export const saveProviderConfig = (provider, patch) => {
  if (provider === 'gemini') {
    if (patch.key !== undefined) localStorage.setItem('gemini_key', patch.key);
    if (patch.model !== undefined) localStorage.setItem(GEMINI_MODEL_STORAGE_KEY, patch.model);
  } else {
    const all = readConfigs();
    all[provider] = { ...getProviderConfig(provider), ...patch };
    writeConfigs(all);
  }
  changed();
};

// Add (no id) or edit a custom provider. Returns its id.
export const saveCustomProvider = (id, fields) => {
  const all = readConfigs();
  const newId = id || `custom:${Date.now().toString(36)}`;
  all[newId] = { ...(all[newId] || {}), ...fields };
  writeConfigs(all);
  changed();
  return newId;
};

export const deleteCustomProvider = (id) => {
  const all = readConfigs();
  delete all[id];
  writeConfigs(all);
  if (localStorage.getItem(PROVIDER_KEY) === id) localStorage.setItem(PROVIDER_KEY, 'gemini');
  changed();
};

// Custom local servers (Ollama, LM Studio) run without a key. ChatGPT signs in
// instead; the backend keeps the tokens and Settings records that it worked.
export const hasAiKey = () => {
  const provider = getAiProvider();
  const { key, baseUrl, signedIn } = getProviderConfig(provider);
  if (provider === 'chatgpt') return !!signedIn;
  return isCustomProvider(provider) ? !!baseUrl : !!key;
};

// Headers for any endpoint that runs a text prompt. The Gemini ones always
// ride along for Gemini-only steps and older servers.
export const aiHeaders = () => {
  const gemini = {
    'X-Gemini-Key': localStorage.getItem('gemini_key') || '',
    'X-Gemini-Model': getStoredGeminiModel(),
  };
  const provider = getAiProvider();
  if (provider === 'gemini') return gemini;
  return { ...gemini, ...providerHeaders(provider, getProviderConfig(provider)) };
};

export const providerHeaders = (provider, { key, model, baseUrl, format, name }) => ({
  'X-AI-Provider': isCustomProvider(provider) ? 'custom' : provider,
  ...(key ? { 'X-AI-Key': key } : {}),
  ...(model ? { 'X-AI-Model': model } : {}),
  ...(baseUrl ? { 'X-AI-Base-Url': baseUrl } : {}),
  ...(isCustomProvider(provider) && format ? { 'X-AI-Format': format } : {}),
  // Header values must be plain ASCII; the name is only a label.
  ...(isCustomProvider(provider) && name ? { 'X-AI-Name': name.replace(/[^\x20-\x7E]/g, '') } : {}),
});
