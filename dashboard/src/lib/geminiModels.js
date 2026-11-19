export const GEMINI_MODEL_STORAGE_KEY = 'gemini_model';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export const GEMINI_MODELS = [
  { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', help: 'Latest stable model' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', help: 'Recommended default' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', help: 'Stable, higher quality' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', help: 'Faster and more economical' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', help: 'Lowest-cost stable option' },
];

// Settings lists Google's live models, so any stored id is kept; GEMINI_MODELS
// is only the fallback when that list can't be loaded.
export const getStoredGeminiModel = () =>
  localStorage.getItem(GEMINI_MODEL_STORAGE_KEY) || DEFAULT_GEMINI_MODEL;
