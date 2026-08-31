const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { UPDATER_ERROR_CATEGORIES, categorizeUpdaterError } = require('./updater-categories');
const { files: packagedShellFiles } = require('./electron-builder');

for (const file of ['main.js', 'preload.js', 'telemetry.js', 'updater-categories.js', 'youtube-auth.js']) {
  assert.ok(packagedShellFiles.includes(file), `${file} must be included in the packaged desktop shell`);
}

const captured = [];
let flushes = 0;

class FakePostHog {
  async capture(payload) {
    captured.push(payload);
  }

  async flush() {
    flushes += 1;
  }

  async shutdown() {}
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'posthog-node') return { PostHog: FakePostHog };
  return originalLoad.call(this, request, parent, isMain);
};

const { createTelemetry } = require('./telemetry');
Module._load = originalLoad;

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openopusclip-telemetry-'));
  const telemetry = createTelemetry({
    userData,
    appVersion: 'test',
    platform: 'darwin',
    arch: 'arm64',
    packaged: true,
  });

  const delivered = await telemetry.capture('survey sent', {
    category: 'bug',
    detail: 'Export freezes after clicking save. API key: AIza12345678901234567890123456789012345',
    sessionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc7',
    submissionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc8',
  });

  assert.equal(delivered, true, 'feedback delivery must be acknowledged');
  assert.equal(captured.length, 1, 'feedback must use the proven Electron telemetry transport');
  assert.equal(captured[0].event, 'survey sent');
  assert.equal(captured[0].properties.$survey_id, '019f9b37-0d93-0000-f07e-c4f19c01caa8');
  assert.equal(captured[0].properties.$survey_submission_id, '019fdfec-e7a0-7230-bf66-23721d3d8bc8');
  assert.equal(captured[0].properties['$survey_response_7b090021-a54b-46c7-bb6e-b63344919e93'], 'Something broke');
  assert.match(captured[0].properties['$survey_response_c05020a8-b34e-4da3-b246-14261967456e'], /Export freezes after clicking save/);
  assert.doesNotMatch(captured[0].properties['$survey_response_c05020a8-b34e-4da3-b246-14261967456e'], /AIza/);
  assert.match(captured[0].properties['$survey_response_c05020a8-b34e-4da3-b246-14261967456e'], /\[redacted-secret\]/);
  assert.equal(captured[0].properties.$survey_questions[0].response, 'Something broke');
  assert.equal(captured[0].properties.$session_id, '019fdfec-e7a0-7230-bf66-23721d3d8bc7');
  assert.equal(flushes, 1, 'feedback must be flushed before success is shown');

  assert.equal(await telemetry.capture('not_allowed', {}), false);

  // Every bucket categorizeUpdaterError() can return must survive capture, or
  // an updater failure reaches PostHog with a null error_category and stays
  // undiagnosable — the exact gap behind the updater relapse.
  const updaterFailures = [
    { error: { code: 'ENOTFOUND' }, expectedCategory: UPDATER_ERROR_CATEGORIES.NETWORK, expectedCode: 'ENOTFOUND' },
    { error: { statusCode: 429 }, expectedCategory: UPDATER_ERROR_CATEGORIES.RATE_LIMITED, expectedCode: '429' },
    { error: { statusCode: 500 }, expectedCategory: UPDATER_ERROR_CATEGORIES.HTTP, expectedCode: '500' },
    { error: { message: 'latest-mac.yml was not found' }, expectedCategory: UPDATER_ERROR_CATEGORIES.NOT_FOUND },
    { error: { message: 'sha512 checksum mismatch' }, expectedCategory: UPDATER_ERROR_CATEGORIES.SIGNATURE },
    { error: { code: 'ERR_UPDATER_UNKNOWN' }, expectedCategory: UPDATER_ERROR_CATEGORIES.UNKNOWN, expectedCode: 'ERR_UPDATER_UNKNOWN' },
  ];
  for (const { error, expectedCategory, expectedCode } of updaterFailures) {
    const errorCategory = categorizeUpdaterError(error);
    assert.equal(errorCategory, expectedCategory);
    captured.length = 0;
    await telemetry.capture('desktop_updater_failed', {
      stage: 'updater_download',
      errorCategory,
      error,
    });
    assert.equal(captured.length, 1, `${errorCategory} must be sent`);
    assert.equal(captured[0].properties.error_category, errorCategory);
    assert.equal(captured[0].properties.stage, 'updater_download');
    assert.equal(captured[0].properties.error_code, expectedCode);
  }

  const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const exposedBridges = {};
  const invocations = [];
  vm.runInNewContext(preloadSource, {
    require(request) {
      assert.equal(request, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            exposedBridges[name] = value;
          },
        },
        ipcRenderer: {
          invoke(channel, payload) {
            invocations.push({ channel, payload });
            return Promise.resolve(true);
          },
        },
      };
    },
    Object,
  });
  assert.equal(await exposedBridges.openOpusTelemetry.captureFeedback({
    category: 'bug',
    detail: 'Bridge check',
    sessionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc7',
    submissionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc8',
  }), true);
  assert.equal(invocations[0].channel, 'open-opus-telemetry:capture-feedback');
  assert.equal(invocations[0].payload.detail, 'Bridge check');
  assert.equal(invocations[0].payload.sessionId, '019fdfec-e7a0-7230-bf66-23721d3d8bc7');
  assert.equal(invocations[0].payload.submissionId, '019fdfec-e7a0-7230-bf66-23721d3d8bc8');

  await exposedBridges.openOpusYouTube.getStatus();
  await exposedBridges.openOpusYouTube.signIn();
  await exposedBridges.openOpusYouTube.signOut();
  assert.deepEqual(invocations.slice(1).map(({ channel }) => channel), [
    'open-opus-youtube:get-status',
    'open-opus-youtube:sign-in',
    'open-opus-youtube:sign-out',
  ]);

  await telemetry.shutdown();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('telemetry self-check passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
