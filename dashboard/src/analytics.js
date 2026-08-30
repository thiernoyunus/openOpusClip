// Bundle the recorder with the desktop dashboard. Loading recorder.js later
// from a CDN is fragile inside packaged Electron apps and previously left the
// project with normal events but zero replay snapshots.
import posthog from 'posthog-js/dist/module.full.no-external.js';
import {
  SENSITIVE_PROPERTY,
  URL_PROPERTY,
  scrubText,
  safeContextValue,
  buildExceptionFingerprint,
  sanitizeNested,
  sanitizeExceptionList,
} from './analyticsSanitizer.js';

const POSTHOG_TOKEN = 'phc_kUQRck5LKwiSJJC2Zv8H8xxFbGksCtmuxdV5Uw7pTpne';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const SAFE_APP_URL = 'desktop://app';
const DEV_OPT_IN = import.meta.env.VITE_POSTHOG_DEV === 'true';
const FEEDBACK_SURVEY_ID = '019f9b37-0d93-0000-f07e-c4f19c01caa8';
const FEEDBACK_SURVEY_NAME = 'OpenOpusClips in-app feedback';
const FEEDBACK_CATEGORY_QUESTION_ID = '7b090021-a54b-46c7-bb6e-b63344919e93';
const FEEDBACK_DETAIL_QUESTION_ID = 'c05020a8-b34e-4da3-b246-14261967456e';
const FEEDBACK_CATEGORY_LABELS = {
  bug: 'Something broke',
  confusing: 'Something was confusing',
  feature: 'Feature request',
  other: 'Other',
};

// Per-event numeric overrides: keys that match SENSITIVE_PROPERTY (because the
// regex contains a broad substring like "token") but are safe to send when the
// value is a finite number.  Only listed events pass these through; every other
// event still blocks them globally.
const EVENT_NUMERIC_OVERRIDES = Object.freeze({
  process_completed: new Set(['input_tokens', 'output_tokens']),
});

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
  '$exception_fingerprint',
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
    const overridden = EVENT_NUMERIC_OVERRIDES[event.event]?.has(key)
      && typeof value === 'number' && Number.isFinite(value);
    if (!overridden && (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key))) continue;
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
      // Keep replay readable for debugging. API-key/password inputs are the
      // only values masked by maskInputFn; normal form text remains visible.
      maskAllInputs: true,
      maskInputOptions: {
        password: true,
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
      // Existing `ph-mask` labels mark useful debugging content in this app;
      // use opt-in selectors for any future truly private non-input content.
      maskTextClass: 'ph-api-key-mask',
      maskTextSelector: '[data-posthog-mask]',
      blockSelector: '[data-posthog-block]',
      recordHeaders: false,
      recordBody: false,
      collectFonts: false,
      captureCanvas: { recordCanvas: false },
      // Keep replay's initial Meta event playable while hiding the local
      // backend URL. Returning null here drops that event and leaves a blank
      // recording in PostHog.
      maskCapturedNetworkRequestFn: (request) => request
        ? { ...request, name: SAFE_APP_URL }
        : undefined,
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
    // Event-scoped numeric overrides: allow a handful of keys that match
    // SENSITIVE_PROPERTY (e.g. "token" in input_tokens) ONLY when the event
    // explicitly opts in AND the value is a finite number.  Every other event
    // and every non-numeric value still hits the global block.
    const overridden = EVENT_NUMERIC_OVERRIDES[eventName]?.has(key)
      && typeof value === 'number' && Number.isFinite(value);
    if (!overridden && (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key))) continue;
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
  const categoryResponse = FEEDBACK_CATEGORY_LABELS[category] || category;
  const submissionId = crypto.randomUUID();
  const surveyProperties = {
    $survey_name: FEEDBACK_SURVEY_NAME,
    $survey_id: FEEDBACK_SURVEY_ID,
    $survey_submission_id: submissionId,
    $survey_questions: [
      { id: FEEDBACK_CATEGORY_QUESTION_ID, question: 'What best describes your feedback?', response: categoryResponse },
      { id: FEEDBACK_DETAIL_QUESTION_ID, question: 'What were you trying to do, and what happened instead?', response: detail },
    ],
    [`$survey_response_${FEEDBACK_CATEGORY_QUESTION_ID}`]: categoryResponse,
    [`$survey_response_${FEEDBACK_DETAIL_QUESTION_ID}`]: detail,
    $survey_completed: true,
  };

  // The desktop main process already delivers startup and failure events
  // reliably. Use that same route for feedback and wait for its result so the
  // modal never claims success for a request that was dropped.
  if (desktopRuntime && window.openOpusTelemetry?.captureFeedback) {
    try {
      return await window.openOpusTelemetry.captureFeedback({
        category,
        detail,
        sessionId: posthog.get_session_id(),
        submissionId,
      });
    } catch {
      return false;
    }
  }

  // Web builds have no Electron bridge. The browser SDK adds its current
  // session ID automatically, so the response stays linked to its replay.
  return Boolean(posthog.capture('survey sent', surveyProperties, {
    send_instantly: true,
    $set: { [`$survey_responded/${FEEDBACK_SURVEY_ID}`]: true },
  }));
}

export function captureError(error, { area = 'renderer', fingerprint, ...context } = {}) {
  if (!initialized) return;
  if (error && typeof error === 'object') {
    if (capturedErrors.has(error)) return;
    capturedErrors.add(error);
  }
  const safeArea = safeContextValue(area);
  const issueFingerprint = Array.isArray(fingerprint) ? buildExceptionFingerprint(fingerprint) : null;
  const dedupeKey = issueFingerprint || `${safeArea}:${safeContextValue(error?.name || 'Error')}:${scrubText(error?.message || error || 'Error')}`;
  if (wasRecentlyCaptured(dedupeKey)) return;
  // Forward any extra context (e.g. an upstream error `code`) so a captured
  // exception carries its cause instead of collapsing into one fingerprint.
  // beforeSend still scrubs every value before it leaves the app.
  const properties = { area: safeArea };
  if (issueFingerprint) properties.$exception_fingerprint = issueFingerprint;
  for (const [key, value] of Object.entries(context)) {
    if (value == null) continue;
    properties[safeContextValue(key)] = safeContextValue(value);
  }
  posthog.captureException(error, properties);
}

export function analyticsEnabled() {
  return initialized;
}

export function analyticsRuntime() {
  return desktopRuntime ? 'desktop' : 'web';
}

export { posthog as analyticsClient };
