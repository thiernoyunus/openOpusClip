const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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

  function capture(event, details = {}) {
    if (!client || !ALLOWED_EVENTS.has(event)) return;
    const properties = { ...baseProperties };
    if (ALLOWED_STAGES.has(details.stage)) properties.stage = details.stage;
    if (ALLOWED_ERROR_CATEGORIES.has(details.errorCategory)) {
      properties.error_category = details.errorCategory;
    }
    const exitCode = safeExitCode(details.exitCode);
    if (exitCode !== undefined) properties.exit_code = exitCode;
    if (ALLOWED_SIGNALS.has(details.signal)) properties.signal = details.signal;

    try {
      client.capture({
        distinctId,
        event,
        properties,
        disableGeoip: true,
      });
    } catch (_) {
      // Sending telemetry is always best-effort.
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
