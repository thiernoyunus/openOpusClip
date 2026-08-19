// Bundle the recorder with the desktop dashboard. Loading recorder.js later
// from a CDN is fragile inside packaged Electron apps and previously left the
// project with normal events but zero replay snapshots.
import posthog from 'posthog-js/dist/module.full.no-external.js';
import {
  SENSITIVE_PROPERTY,
  URL_PROPERTY,
  scrubText,
  safeContextValue,
  sanitizeNested,
  sanitizeExceptionList,
} from './analyticsSanitizer.js';

const POSTHOG_TOKEN = 'phc_kUQRck5LKwiSJJC2Zv8H8xxFbGksCtmuxdV5Uw7pTpne';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SAFE_APP_URL = 'desktop://app';
const DEV_OPT_IN = import.meta.env.VITE_POSTHOG_DEV === 'true';

// Top-level `$exception_*` keys that describe where a crash happened, not what
// the user was doing. They stay diagnostic once scrubText redacts any path or
// filename, so let them through instead of dropping the whole prefix.
const DIAGNOSTIC_EXCEPTION_KEYS = new Set([
  '$exception_level',
  '$exception_handled',
  '$exception_type',
  '$exception_types',
  '$exception_message',
  '$exception_values',
  '$exception_source',
  '$exception_sources',
  '$exception_functions',
  '$exception_line',
  '$exception_colno',
]);
const SENSITIVE_INPUT = /(?:api[\s_-]?(?:key|token)|password|secret|credential)/i;
const API_KEY_VALUE = /\b(?:phc|sk|zern|soniox)[_-][A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{30,}\b/i;

let initialized = false;
let desktopRuntime = false;
const capturedErrors = new WeakSet();
const recentErrorFingerprints = new Map();

function beforeSend(event) {
  if (!event?.properties) return event;

  const properties = {};
  for (const [key, value] of Object.entries(event.properties)) {
    if (key === '$exception_list') {
      const exceptionList = sanitizeExceptionList(value);
      if (exceptionList?.length) properties[key] = exceptionList;
      continue;
    }
    if (key.startsWith('$exception_')) {
      if (!DIAGNOSTIC_EXCEPTION_KEYS.has(key)) continue;
      properties[key] = typeof value === 'string'
        ? scrubText(value)
        : value && typeof value === 'object'
          ? sanitizeNested(value)
          : value;
      continue;
    }
    // PostHog adds its required `token` field before this hook. Preserve that
    // exact value for authentication; user-provided token values are still
    // removed by track() before this hook runs.
    if (key === 'token') {
      properties[key] = value;
      continue;
    }
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    // Replay snapshots are already masked by the recorder below. They are an
    // encoded protocol payload, not ordinary text: scrubbing/truncating them
    // corrupts the recording and makes it unplayable.
    if (key === '$snapshot_data') {
      properties[key] = value;
      continue;
    }
    properties[key] = typeof value === 'string' ? scrubText(value) : value;
  }

  // Desktop navigation is virtual. Fold each pageview's view into a stable,
  // non-sensitive path so web analytics and paths read the in-app screens
  // without exposing a real URL or filesystem location.
  const view = event.event === '$pageview' && typeof event.properties.view === 'string'
    ? safeContextValue(event.properties.view)
    : null;
  properties.$current_url = view ? `${SAFE_APP_URL}/${view}` : SAFE_APP_URL;
  properties.$pathname = view ? `/app/${view}` : '/app';
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
  if (initialized) return initialized;

  let context = null;
  const hasElectronBridge = Boolean(window.openOpusTelemetry?.getContext);
  if (hasElectronBridge) {
    try {
      context = await window.openOpusTelemetry.getContext();
      desktopRuntime = true;
    } catch {
      // An Electron bridge failure must not look like a production web app.
      if (!DEV_OPT_IN) return false;
    }
  }

  // Honor the same packaged/opt-in gate as telemetry.js: dev builds of the
  // Electron app stay silent unless VITE_POSTHOG_DEV=true. Web builds (no
  // Electron context) opt in only when the production bundle is loaded.
  const desktopDev = context && context.packaged === false;
  if (desktopDev && !DEV_OPT_IN) return false;
  if (!desktopRuntime && !import.meta.env.PROD && !DEV_OPT_IN) return false;

  const bootstrap = context?.distinctId
    ? { distinctID: context.distinctId, isIdentifiedID: false }
    : undefined;

  posthog.init(POSTHOG_TOKEN, {
    api_host: POSTHOG_HOST,
    ui_host: 'https://us.posthog.com',
    debug: DEV_OPT_IN,
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
      capture_console_errors: true,
    },
    capture_heatmaps: false,
    capture_dead_clicks: false,
    capture_performance: false,
    enable_recording_console_log: false,
    get_current_url: () => SAFE_APP_URL,
    before_send: beforeSend,
    session_recording: {
      // Show form values so replay can reveal the exact bug report and state.
      // Only password/API-key fields are masked; add `ph-mask` to private
      // non-input text that should stay hidden.
      maskAllInputs: false,
      maskInputOptions: {
        text: true,
        textarea: true,
        password: true,
        url: true,
      },
      maskInputFn: (value, element) => {
        const context = [
          element?.type,
          element?.name,
          element?.id,
          element?.placeholder,
          element?.getAttribute?.('aria-label'),
        ].filter(Boolean).join(' ');
        const markedSensitive = element?.getAttribute?.('data-posthog-sensitive') === 'true';
        return markedSensitive || element?.type === 'password' || SENSITIVE_INPUT.test(context) || API_KEY_VALUE.test(value)
          ? '*'.repeat(value.length)
          : value;
      },
      sampleRate: 1,
      maskTextSelector: '.ph-mask',
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

  // The beta needs a recording from every test session. This also overrides a
  // stale 20% sampling decision already stored for the current browser session.
  posthog.startSessionRecording({ sampling: true });

  setTimeout(() => {
    track('analytics_health_checked', {
      recording_status: posthog.sessionRecording?.status || 'unknown',
      recording_started: Boolean(posthog.sessionRecording?.started),
    });
  }, 3000);

  initialized = true;
  return true;
}

export function track(eventName, properties = {}) {
  if (!initialized) return false;
  const safeProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      safeProperties[key] = value;
    } else if (typeof value === 'string') {
      safeProperties[key] = key === 'detail' || value.length > 40
        ? scrubText(value)
        : safeContextValue(value);
    }
  }
  return Boolean(posthog.capture(eventName, safeProperties, { send_instantly: true }));
}

// Emit a real `$pageview` for each in-app navigation. `autocapture` and
// `capture_pageview` stay off, so this is the only source of pageviews and web
// analytics, paths, and the health check now read the desktop app as active.
export function trackPageview(view) {
  if (!initialized) return false;
  return Boolean(posthog.capture('$pageview', { view: safeContextValue(view) }, { send_instantly: true }));
}

export async function submitFeedback(properties = {}) {
  if (!initialized) return false;
  const category = safeContextValue(properties.category);
  const detail = scrubText(properties.detail || '');

  // The desktop main process already delivers startup and failure events
  // reliably. Use that same route for feedback and wait for its result so the
  // modal never claims success for a request that was dropped.
  if (desktopRuntime && window.openOpusTelemetry?.captureFeedback) {
    try {
      return await window.openOpusTelemetry.captureFeedback({ category, detail });
    } catch {
      return false;
    }
  }

  // Web builds have no Electron bridge. A capture result means the browser
  // SDK accepted the event into its immediate delivery queue.
  return track('feedback_submitted', { category, detail });
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
