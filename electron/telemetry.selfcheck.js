const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

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

  const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  let exposedBridge;
  const invocations = [];
  vm.runInNewContext(preloadSource, {
    require(request) {
      assert.equal(request, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'openOpusTelemetry');
            exposedBridge = value;
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
  assert.equal(await exposedBridge.captureFeedback({
    category: 'bug',
    detail: 'Bridge check',
    sessionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc7',
    submissionId: '019fdfec-e7a0-7230-bf66-23721d3d8bc8',
  }), true);
  assert.equal(invocations[0].channel, 'open-opus-telemetry:capture-feedback');
  assert.equal(invocations[0].payload.detail, 'Bridge check');
  assert.equal(invocations[0].payload.sessionId, '019fdfec-e7a0-7230-bf66-23721d3d8bc7');
  assert.equal(invocations[0].payload.submissionId, '019fdfec-e7a0-7230-bf66-23721d3d8bc8');

  await telemetry.shutdown();
  fs.rmSync(userData, { recursive: true, force: true });
  console.log('telemetry self-check passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
