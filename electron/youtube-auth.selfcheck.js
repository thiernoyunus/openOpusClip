const assert = require('node:assert/strict');
const path = require('node:path');
const { cookieFilePath, hasAuthCookie, toNetscape } = require('./youtube-auth');

assert.equal(hasAuthCookie([{ name: 'SID' }]), false);
assert.equal(hasAuthCookie([{ name: 'LOGIN_INFO' }]), false);
assert.equal(hasAuthCookie([{ name: 'LOGIN_INFO' }, { name: 'SAPISID' }]), true);
assert.equal(hasAuthCookie([{ name: 'YSC' }]), false);
assert.equal(
  cookieFilePath(path.join('/tmp', 'openopusclip')),
  path.join('/tmp', 'openopusclip', 'youtube-cookies.txt'),
);

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
