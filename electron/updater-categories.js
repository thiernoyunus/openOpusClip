const UPDATER_ERROR_CATEGORIES = Object.freeze({
  NETWORK: 'updater_network',
  RATE_LIMITED: 'updater_rate_limited',
  HTTP: 'updater_http',
  NOT_FOUND: 'updater_not_found',
  SIGNATURE: 'updater_signature',
  UNKNOWN: 'updater_error',
});

// Many providers (GitHub, S3, Azure) attach rate-limit headers to the
// underlying error.response. electron-updater 6.8.9 doesn't expose response
// headers directly, so this is a best-effort pass over the common locations.
function errorHeadersInclude(err, header) {
  if (!err || typeof err !== 'object') return false;
  const key = header.toLowerCase();
  const candidates = [err.headers, err.response && err.response.headers, err.context && err.context.headers];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c.get === 'function' && c.get(header) != null) return true;
    if (typeof c === 'object' && Object.keys(c).some((k) => k.toLowerCase() === key && c[k] != null)) return true;
  }
  return false;
}

// Bucket an updater error into a small, PII-free set of categories so failures
// can actually be told apart (offline vs GitHub rate-limit vs a broken
// release) instead of collapsing into one opaque "updater_error". Only the
// bucket and a sanitized code are ever sent — never the raw message, which can
// embed the user's home-directory path.
function categorizeUpdaterError(err) {
  const status = err && (err.statusCode != null ? err.statusCode : err.status);
  const code = String((err && (err.code || err.name)) || '');
  const msg = String((err && err.message) || '');
  const haystack = `${code} ${msg}`;
  if (/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|ENETUNREACH|getaddrinfo|network/i.test(haystack)) {
    return UPDATER_ERROR_CATEGORIES.NETWORK;
  }
  // 429 is the unambiguous "rate limited" status. 403 is GitHub's catch-all
  // (auth, private-repo, redirect-with-Authorization-stripped, rate-limit) —
  // only bucket it as rate-limited when there's actual evidence in the message
  // OR when GitHub's rate-limit headers survived onto the error.
  const hasRateLimitMsg = /\brate limit|too many requests\b|abuse detection/i.test(msg);
  const hasRateLimitHeader = errorHeadersInclude(err, 'x-ratelimit-remaining');
  if (status === 429 || (status === 403 && (hasRateLimitMsg || hasRateLimitHeader))) {
    return UPDATER_ERROR_CATEGORIES.RATE_LIMITED;
  }
  if (/signature|sha512|checksum|integrity/i.test(msg)) {
    return UPDATER_ERROR_CATEGORIES.SIGNATURE;
  }
  // Require a release-asset keyword so generic "file not found" messages
  // from the user's filesystem don't get mis-classified as updater failures.
  if (/latest[\w.-]*\.yml|published release|No published release|cannot find (release|asset|asset url)/i.test(msg)) {
    return UPDATER_ERROR_CATEGORIES.NOT_FOUND;
  }
  if (Number.isInteger(status) || /HTTPError|status code|\b40\d\b|\b50\d\b/i.test(haystack)) {
    return UPDATER_ERROR_CATEGORIES.HTTP;
  }
  return UPDATER_ERROR_CATEGORIES.UNKNOWN;
}

module.exports = { UPDATER_ERROR_CATEGORIES, categorizeUpdaterError };
