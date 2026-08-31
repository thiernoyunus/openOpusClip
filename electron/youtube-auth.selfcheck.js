const assert = require('node:assert/strict');
const { cookieFilePath, hasAuthCookie, toNetscape } = require('./youtube-auth');

assert.equal(hasAuthCookie([{ name: 'SID' }]), true);
assert.equal(hasAuthCookie([{ name: 'YSC' }]), false);
assert.equal(cookieFilePath('/tmp/openopusclip'), '/tmp/openopusclip/youtube-cookies.txt');

const jar = toNetscape([{
  domain: '.youtube.com',
  path: '/',
  secure: true,
  expirationDate: 123.9,
  name: 'SID',
  value: 'redacted-test-value',
}]);
assert.match(jar, /^# Netscape HTTP Cookie File/);
assert.match(jar, /\.youtube\.com\tTRUE\t\/\tTRUE\t123\tSID\tredacted-test-value/);

console.log('youtube auth self-check passed');
