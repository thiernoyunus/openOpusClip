export const GEMINI_MODEL_STORAGE_KEY = 'gemini_model';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export const GEMINI_MODELS = [
  { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', help: 'Latest stable model' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', help: 'Recommended default' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', help: 'Stable, higher quality' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', help: 'Faster and more economical' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', help: 'Lowest-cost stable option' },
];

export const getStoredGeminiModel = () => {
  const stored = localStorage.getItem(GEMINI_MODEL_STORAGE_KEY);
  return GEMINI_MODELS.some((model) => model.value === stored)
    ? stored
    : DEFAULT_GEMINI_MODEL;
};
