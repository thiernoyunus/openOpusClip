const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { UPDATER_ERROR_CATEGORIES } = require('./updater-categories');
let PostHog = null;
try {
  ({ PostHog } = require('posthog-node'));
} catch (_) {
  // A missing or damaged optional telemetry dependency must not stop the app.
}

// PostHog project: OpenOpusClips (528420).
const POSTHOG_TOKEN = 'phc_kUQRck5LKwiSJJC2Zv8H8xxFbGksCtmuxdV5Uw7pTpne';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const INSTALLATION_ID_FILE = 'anonymous-installation-id';
const DEV_OPT_IN_ENV = 'OPENSHORTS_TELEMETRY_OPT_IN';
const FEEDBACK_CATEGORIES = new Set(['bug', 'confusing', 'feature', 'other']);
const FEEDBACK_SURVEY_ID = '019f9b37-0d93-0000-f07e-c4f19c01caa8';
const FEEDBACK_SURVEY_NAME = 'OpenOpusClips in-app feedback';
const FEEDBACK_CATEGORY_QUESTION_ID = '7b090021-a54b-46c7-bb6e-b63344919e93';
const FEEDBACK_DETAIL_QUESTION_ID = 'c05020a8-b34e-4da3-b246-14261967456e';
const FEEDBACK_CATEGORY_LABELS = Object.freeze({
  bug: 'Something broke',
  confusing: 'Something was confusing',
  feature: 'Feature request',
  other: 'Other',
});
const API_KEY_TEXT = /\b(?:phc|sk|zern|soniox)[_-][A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\b(?:api[_ -]?key|token|secret|bearer)\s*[:= ]\s*[A-Za-z0-9_.-]{12,}\b/gi;

function telemetryDisabled(packaged) {
  // Packaged builds always opt in. Development builds (npm start from a source
  // checkout) stay silent unless the developer explicitly sets the opt-in env.
  if (packaged) return false;
  const raw = (process.env[DEV_OPT_IN_ENV] || '').trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on');
}

const ALLOWED_EVENTS = new Set([
  'desktop_app_started',
  'desktop_stack_startup_failed',
  'desktop_backend_startup_failed',
  'desktop_backend_exited',
  'desktop_render_service_startup_failed',
  'desktop_render_service_exited',
  'desktop_render_process_gone',
  'desktop_main_unhandled_rejection',
  'desktop_main_uncaught_exception',
  'desktop_updater_failed',
  'feedback_submitted',
  'survey sent',
]);

const ALLOWED_STAGES = new Set([
  'application',
  'preflight',
  'stack',
  'backend_spawn',
  'backend_healthcheck',
  'backend_runtime',
  'render_service_spawn',
  'render_service_runtime',
  'renderer_process',
  'main_process',
  'updater_check',
  'updater_download',
  'updater_install',
  'updater_event',
]);

const ALLOWED_ERROR_CATEGORIES = new Set([
  'missing_backend_bundle',
  'missing_python_runtime',
  'missing_python_environment',
  'missing_dashboard_build',
  'missing_executable',
  'permission_denied',
  'address_in_use',
  'process_launch_failed',
  'health_check_timeout',
  'nonzero_exit',
  'fault_signal',
  'process_crashed',
  'process_killed',
  'out_of_memory',
  'launch_failed',
  'integrity_failure',
  'unresponsive',
  'error',
  'non_error_rejection',
  'updater_error',
  'stack_setup_failed',
  'unknown',
  ...Object.values(UPDATER_ERROR_CATEGORIES),
]);

const ALLOWED_SIGNALS = new Set([
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGILL',
  'SIGKILL',
  'SIGSEGV',
  'SIGSYS',
  'SIGTRAP',
]);

function loadOrCreateDistinctId(userData) {
  const idPath = path.join(userData, INSTALLATION_ID_FILE);
  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  } catch (_) {
    // First launch, or an unreadable file. A new anonymous ID is safe here.
  }

  const distinctId = crypto.randomUUID();
  try {
    fs.mkdirSync(userData, { recursive: true });
    const temporaryPath = idPath + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporaryPath, distinctId + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, idPath);
  } catch (_) {
    // Telemetry must never prevent the desktop app from starting. If storage is
    // unavailable, the ID remains stable for this process and is simply renewed
    // next launch.
  }
  return distinctId;
}

function safeExitCode(value) {
  return Number.isInteger(value) ? value : undefined;
}

function safeFeedbackDetail(value) {
  if (typeof value !== 'string') return undefined;
  const safe = value.trim().replace(API_KEY_TEXT, '[redacted-secret]').slice(0, 2000);
  return safe || undefined;
}

function safeUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function safeSessionId(value) {
  return safeUuid(value);
}

// A short, PII-free identifier for an error: its HTTP status (in the valid
// 100-599 range), or its Node/electron-updater code (e.g. ENOTFOUND,
// ERR_UPDATER_LATEST_VERSION_NOT_FOUND). Never the message — updater error
// messages routinely embed the user's home-directory path, so anything free-form
// is rejected by the strict shape check below.
function safeErrorCode(error) {
  if (!error || typeof error !== 'object') return undefined;
  const status = error.statusCode != null ? error.statusCode : error.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return String(status);
  }
  const raw = String(error.code || error.name || '').trim();
  // 1-64 chars, leading letter, then letters/digits/underscores. Length
  // check is a separate guard so the upper bound is unambiguous in the source
  // (the {0,63} quantifier alone leaves room for 64-char codes that we don't want).
  if (raw.length < 1 || raw.length > 64) return undefined;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(raw) ? raw : undefined;
}

function createTelemetry({ userData, appVersion, platform, arch, packaged }) {
  const distinctId = loadOrCreateDistinctId(userData);
  const context = Object.freeze({ distinctId, appVersion, platform, arch, packaged });
  const baseProperties = Object.freeze({
    app_version: appVersion,
    platform,
    arch,
    packaged,
  });

  let client = null;
  if (telemetryDisabled(packaged)) {
    // No-op client: dev builds stay silent unless OPENSHORTS_TELEMETRY_OPT_IN
    // is set explicitly. The packaged app is always allowed.
  } else {
    try {
      if (!PostHog) throw new Error('PostHog unavailable');
      client = new PostHog(POSTHOG_TOKEN, {
        host: POSTHOG_HOST,
        flushAt: 1,
        flushInterval: 10_000,
        enableExceptionAutocapture: false,
      });
    } catch (_) {
      // A telemetry setup problem must not affect app startup.
    }
  }

  // Returns a Promise that resolves when the capture has been handed to the
  // PostHog client AND any pending batch has been flushed. Callers (e.g. the
  // fatal() helper in main.js) can await this before exiting so a synchronous
  // process.exit() doesn't drop the last telemetry event.
  async function capture(event, details = {}) {
    if (!client || !ALLOWED_EVENTS.has(event)) return false;
    const properties = { ...baseProperties };
    if (ALLOWED_STAGES.has(details.stage)) properties.stage = details.stage;
    if (ALLOWED_ERROR_CATEGORIES.has(details.errorCategory)) {
      properties.error_category = details.errorCategory;
    }
    const exitCode = safeExitCode(details.exitCode);
    if (exitCode !== undefined) properties.exit_code = exitCode;
    if (ALLOWED_SIGNALS.has(details.signal)) properties.signal = details.signal;
    const errorCode = safeErrorCode(details.error);
    if (errorCode !== undefined) properties.error_code = errorCode;
    if (event === 'feedback_submitted') {
      if (!FEEDBACK_CATEGORIES.has(details.category)) return false;
      properties.category = details.category;
      const detail = safeFeedbackDetail(details.detail);
      if (detail) properties.detail = detail;
      properties.runtime = 'desktop';
    }
    if (event === 'survey sent') {
      if (!FEEDBACK_CATEGORIES.has(details.category)) return false;
      properties.runtime = 'desktop';
      const categoryResponse = FEEDBACK_CATEGORY_LABELS[details.category];
      const detail = safeFeedbackDetail(details.detail) || '';
      properties.$survey_id = FEEDBACK_SURVEY_ID;
      properties.$survey_name = FEEDBACK_SURVEY_NAME;
      properties.$survey_submission_id = safeUuid(details.submissionId) || crypto.randomUUID();
      properties.$survey_questions = [
        { id: FEEDBACK_CATEGORY_QUESTION_ID, question: 'What best describes your feedback?', response: categoryResponse },
        { id: FEEDBACK_DETAIL_QUESTION_ID, question: 'What were you trying to do, and what happened instead?', response: detail },
      ];
      properties[`$survey_response_${FEEDBACK_CATEGORY_QUESTION_ID}`] = categoryResponse;
      properties[`$survey_response_${FEEDBACK_DETAIL_QUESTION_ID}`] = detail;
      properties.$survey_completed = true;
      const sessionId = safeSessionId(details.sessionId);
      if (sessionId) properties.$session_id = sessionId;
    }

    try {
      client.capture({
        distinctId,
        event,
        properties,
        disableGeoip: true,
      });
      // flushAt:1 schedules a flush on the next tick; await a short window so
      // the queued HTTP request has actually left the process before the
      // caller (potentially) exits.
      if (typeof client.flush === 'function') {
        // Bound best-effort telemetry so a dead PostHog endpoint cannot hold
        // a fatal startup exit for the SDK's full retry window.
        try {
          return await Promise.race([
            client.flush().then(() => true, () => false),
            new Promise((resolve) => setTimeout(
              () => resolve(false),
              event === 'feedback_submitted' || event === 'survey sent' ? 5000 : 750
            )),
          ]);
        } catch (_) {
          return false;
        }
      }
      return true;
    } catch (_) {
      // Sending telemetry is always best-effort.
      return false;
    }
  }

  async function shutdown(timeoutMs = 750) {
    if (!client) return;
    const closingClient = client;
    client = null;
    try {
      await closingClient.shutdown(timeoutMs);
    } catch (_) {
      // Shutdown continues even if PostHog is offline or times out.
    }
  }

  return {
    capture,
    getContext: () => ({ ...context }),
    shutdown,
  };
}

module.exports = { createTelemetry };
