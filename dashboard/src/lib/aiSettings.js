// Which AI answers the text prompts (clip finding, trailer, captions, b-roll).
// Gemini keeps its own storage ('gemini_key' / 'gemini_model') because
// thumbnails always use it; other providers live in one encrypted blob.
import { encrypt, decrypt } from './secretBox';
import { GEMINI_MODEL_STORAGE_KEY, getStoredGeminiModel } from './geminiModels';

const PROVIDER_KEY = 'ai_provider';
const CONFIG_KEY = 'ai_providers_v1';
export const AI_SETTINGS_EVENT = 'ai-settings-changed';

// Must match PROVIDERS in llm.py.
export const AI_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini', help: 'Default. Free key available.', keyUrl: 'https://aistudio.google.com/app/apikey' },
  { id: 'openrouter', label: 'OpenRouter', help: 'One key for Claude, GPT, Grok, DeepSeek, MiMo and more.', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', keyUrl: 'https://console.x.ai' },
  { id: 'mimo', label: 'Xiaomi MiMo', keyUrl: 'https://platform.xiaomimimo.com' },
  { id: 'custom', label: 'Custom', help: 'Any OpenAI-compatible API: Qwen, Kimi, GLM, Ollama, LM Studio…' },
];

export const getAiProvider = () => {
  const stored = localStorage.getItem(PROVIDER_KEY);
  return AI_PROVIDERS.some((p) => p.id === stored) ? stored : 'gemini';
};

const readConfigs = () => {
  try {
    return JSON.parse(decrypt(localStorage.getItem(CONFIG_KEY) || '') || '{}');
  } catch {
    return {};
  }
};

// { key, model, baseUrl } for one provider.
export const getProviderConfig = (provider) => {
  if (provider === 'gemini') {
    return { key: localStorage.getItem('gemini_key') || '', model: getStoredGeminiModel(), baseUrl: '' };
  }
  return { key: '', model: '', baseUrl: '', ...(readConfigs()[provider] || {}) };
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
    localStorage.setItem(CONFIG_KEY, encrypt(JSON.stringify(all)));
  }
  changed();
};

// Custom local servers (Ollama, LM Studio) run without a key.
export const hasAiKey = () => {
  const provider = getAiProvider();
  const { key, baseUrl } = getProviderConfig(provider);
  return provider === 'custom' ? !!baseUrl : !!key;
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

export const providerHeaders = (provider, { key, model, baseUrl }) => ({
  'X-AI-Provider': provider,
  ...(key ? { 'X-AI-Key': key } : {}),
  ...(model ? { 'X-AI-Model': model } : {}),
  ...(baseUrl ? { 'X-AI-Base-Url': baseUrl } : {}),
});
