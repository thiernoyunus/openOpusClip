import assert from 'node:assert/strict';
import { sanitizeExceptionList, sanitizeStacktrace, scrubText } from './analyticsSanitizer.js';

const [exception] = sanitizeExceptionList([{
  type: 'Error',
  value: 'upload failed in /Users/alice/video.mp4',
  stacktrace: {
    type: 'raw',
    frames: [{
      platform: 'web:javascript',
      filename: '/Users/alice/src/app.js',
      abs_path: 'C:\\Users\\alice\\video.mp4',
      function: 'handleUpload',
      lineno: 42,
      colno: 7,
      in_app: true,
      chunk_id: 'main-chunk-42',
      context_line: 'private user text',
      vars: { apiKey: 'secret' },
    }],
  },
  mechanism: {
    handled: false,
    synthetic: false,
    type: 'onerror',
    data: { apiKey: 'secret', userText: 'private user text' },
  },
}]);

assert.equal(exception.type, 'Error');
assert.match(exception.value, /\[redacted-path\]|\[redacted-filename\]/);
assert.equal(exception.stacktrace.type, 'raw');
assert.deepEqual(exception.stacktrace.frames[0], {
  filename: '[redacted-path]',
  abs_path: '[redacted-path]',
  platform: 'web:javascript',
  function: 'handleUpload',
  lineno: 42,
  colno: 7,
  in_app: true,
  chunk_id: 'main-chunk-42',
});
assert.deepEqual(exception.mechanism, {
  handled: false,
  synthetic: false,
  type: 'onerror',
});
assert(!JSON.stringify(exception).includes('private user text'));
assert(!JSON.stringify(exception).includes('secret'));

assert.deepEqual(sanitizeExceptionList([{ type: 'Error', value: 'plain failure' }]), [{
  type: 'Error',
  value: 'plain failure',
}]);
assert.equal(sanitizeExceptionList(Array.from({ length: 7 }, () => ({ type: 'Error' }))).length, 5);
const retainedFrames = sanitizeStacktrace({
  frames: Array.from({ length: 40 }, (_, index) => ({ function: String(index) })),
}).frames;
assert.equal(retainedFrames.length, 30);
assert.equal(retainedFrames[0].function, '10');
assert.equal(retainedFrames.at(-1).function, '39');
assert.equal(
  scrubText('The export button froze. API key: AIza12345678901234567890123456789012345'),
  'The export button froze. [redacted-secret]'
);

console.log('analytics sanitizer self-check passed');
