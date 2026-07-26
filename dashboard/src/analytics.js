import posthog from 'posthog-js';

const POSTHOG_TOKEN = 'phc_kUQRck5LKwiSJJC2Zv8H8xxFbGksCtmuxdV5Uw7pTpne';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SAFE_APP_URL = 'desktop://app';
const DEV_OPT_IN = import.meta.env.VITE_POSTHOG_DEV === 'true';

const SENSITIVE_PROPERTY = /(?:api[_-]?key|authorization|password|secret|token|prompt|transcript|caption|media|file(?:name)?|title|job[_-]?id|raw[_-]?logs?|social[_-]?(?:user)?name|request[_-]?(?:headers?|bod(?:y|ies))|response[_-]?(?:headers?|bod(?:y|ies)))/i;
const URL_PROPERTY = /(?:^|[_$])(?:current_)?url$|referrer|referring_domain|pathname|host$|^(?:href|src|action|poster)$/i;
const URL_TEXT = /(?:https?|file|blob):\/\/[^\s)\]}>'"]+/gi;
const LOCAL_PATH = /(?:\/[A-Za-z0-9._ -]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g;
const API_KEY_TEXT = /\b(?:phc|sk|zern|soniox)[_-][A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\b(?:api[_ -]?key|token|secret|bearer)\s*[:= ]\s*[A-Za-z0-9_-]{12,}\b/gi;
const FILENAME_TEXT = /\b[\w .-]+\.(?:mp4|mov|mkv|webm|avi|mp3|wav|m4a|png|jpe?g|gif|webp|srt|vtt|txt|log|json|jsx?|tsx?|py)\b/gi;
const SAFE_CONTEXT_VALUE = /[^a-zA-Z0-9._-]/g;

let initialized = false;
let desktopRuntime = false;
const capturedErrors = new WeakSet();
const recentErrorFingerprints = new Map();

function scrubText(value) {
  return String(value)
    .replace(URL_TEXT, '[redacted-url]')
    .replace(LOCAL_PATH, '[redacted-path]')
    .replace(FILENAME_TEXT, '[redacted-filename]')
    .replace(API_KEY_TEXT, '[redacted-secret]')
    .slice(0, 500);
}

function safeContextValue(value, fallback = 'unknown') {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback;
  const safe = String(value).replace(SAFE_CONTEXT_VALUE, '').slice(0, 40);
  return safe || fallback;
}

function sanitizeExceptionList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 5).map((exception) => ({
    type: safeContextValue(exception?.type || exception?.name || 'Error'),
    value: scrubText(exception?.value || exception?.message || 'An error occurred'),
  }));
}

function sanitizeNested(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeNested(item, seen));

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    sanitized[key] = sanitizeNested(nestedValue, seen);
  }
  return sanitized;
}

function beforeSend(event) {
  if (!event?.properties) return event;

  const properties = {};
  for (const [key, value] of Object.entries(event.properties)) {
    if (key === '$exception_list') {
      const exceptionList = sanitizeExceptionList(value);
      if (exceptionList?.length) properties[key] = exceptionList;
      continue;
    }
    if (key.startsWith('$exception_')) continue;
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    properties[key] = key === '$snapshot_data' ? sanitizeNested(value) : typeof value === 'string' ? scrubText(value) : value;
  }

  properties.$current_url = SAFE_APP_URL;
  properties.$pathname = '/app';
  properties.$host = 'app';
  properties.$referrer = '';
  properties.$initial_referrer = '';
  properties.$referring_domain = '';

  return { ...event, properties };
}

function wasRecentlyCaptured(fingerprint) {
  const now = Date.now();
  const last = recentErrorFingerprints.get(fingerprint);
  recentErrorFingerprints.set(fingerprint, now);
  for (const [key, timestamp] of recentErrorFingerprints) {
    if (now - timestamp > 5000) recentErrorFingerprints.delete(key);
  }
  return last !== undefined && now - last < 5000;
}

export async function initAnalytics() {
  if (initialized || (!import.meta.env.PROD && !DEV_OPT_IN)) return initialized;

  let context = null;
  if (window.openOpusTelemetry?.getContext) {
    try {
      context = await window.openOpusTelemetry.getContext();
      desktopRuntime = true;
    } catch {
      // Fall back to PostHog's anonymous localStorage identity.
    }
  }

  const bootstrap = context?.distinctId
    ? { distinctID: context.distinctId, isIdentifiedID: false }
    : undefined;

  posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    ui_host: 'https://us.posthog.com',
    person_profiles: 'identified_only',
    // Disable PostHog's built-in surveys — feedback uses a custom native modal
    surveys: false,
    disable_surveys_automatic_display: true,
    persistence: 'localStorage',
    bootstrap,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_performance: false,
    enable_recording_console_log: false,
    get_current_url: () => SAFE_APP_URL,
    before_send: beforeSend,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: 'body',
      blockSelector: 'video, audio, canvas, img, [data-posthog-block]',
      recordHeaders: false,
      recordBody: false,
      collectFonts: false,
      captureCanvas: { recordCanvas: false },
      maskCapturedNetworkRequestFn: () => null,
    },
  });

  posthog.register(context ? {
    app_version: safeContextValue(context.appVersion),
    platform: safeContextValue(context.platform),
    architecture: safeContextValue(context.arch),
    packaged: Boolean(context.packaged),
    runtime: 'desktop',
  } : { runtime: 'web' });

  initialized = true;
  return true;
}

export function track(eventName, properties = {}) {
  if (!initialized) return;
  const safeProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      safeProperties[key] = typeof value === 'string' ? safeContextValue(value) : value;
    }
  }
  posthog.capture(eventName, safeProperties);
}

export function captureError(error, { area = 'renderer' } = {}) {
  if (!initialized) return;
  if (error && typeof error === 'object') {
    if (capturedErrors.has(error)) return;
    capturedErrors.add(error);
  }
  const safeArea = safeContextValue(area);
  const fingerprint = `${safeArea}:${safeContextValue(error?.name || 'Error')}:${scrubText(error?.message || error || 'Error')}`;
  if (wasRecentlyCaptured(fingerprint)) return;
  posthog.captureException(error, { area: safeArea });
}

export function analyticsEnabled() {
  return initialized;
}

export function analyticsRuntime() {
  return desktopRuntime ? 'desktop' : 'web';
}

export { posthog as analyticsClient };
