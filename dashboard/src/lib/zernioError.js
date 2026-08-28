// The backend passes Zernio's error body through verbatim inside FastAPI's
// `detail` string ("Zernio API error: {...}"), so the raw JSON has to be dug
// back out here to say what actually went wrong.
export function readZernioError(detail, platform) {
  const start = typeof detail === 'string' ? detail.indexOf('{') : -1;
  let body = null;
  if (start !== -1) {
    try { body = JSON.parse(detail.slice(start)); } catch { /* not JSON, fall through */ }
  }

  if (body?.code === 'PAYMENT_REQUIRED') {
    const limit = body.details?.free_tier_account_limit ?? 2;
    const current = body.details?.current_account_count ?? limit;
    return {
      message: `Zernio's free plan allows ${limit} connected accounts, and you already have ${current}. Add a payment method on Zernio to connect more.`,
      link: body.dashboard_url || 'https://zernio.com/dashboard/billing',
      linkLabel: 'Upgrade on Zernio',
    };
  }

  return {
    message: body?.error || `Could not start the ${platform} connection. ${detail || ''}`.trim(),
    link: null,
  };
}

// ponytail: self-check instead of a test framework — `node src/lib/zernioError.js`
if (import.meta.url === `file://${globalThis.process?.argv?.[1]}`) {
  const assert = (cond, label) => { if (!cond) throw new Error(`FAIL: ${label}`); };

  const paid = readZernioError(
    'Zernio API error: {"error":"Add a payment method to connect more than 2 accounts.","code":"PAYMENT_REQUIRED","reason":"free_tier_exceeded","dashboard_url":"https://zernio.com/dashboard/billing","details":{"free_tier_account_limit":2,"current_account_count":2,"has_payment_method":false}}',
    'youtube',
  );
  assert(paid.message.includes('free plan allows 2'), 'states the limit');
  assert(!paid.message.includes('{'), 'no raw JSON leaks through');
  assert(paid.link === 'https://zernio.com/dashboard/billing', 'links to billing');

  const plain = readZernioError('Zernio API error: {"error":"Invalid API key"}', 'tiktok');
  assert(plain.message === 'Invalid API key', 'uses Zernio wording when there is no code');
  assert(plain.link === null, 'no upgrade link for unrelated errors');

  const junk = readZernioError('Service unavailable', 'facebook');
  assert(junk.message.includes('facebook'), 'falls back to a readable sentence');

  const missing = readZernioError(undefined, 'threads');
  assert(missing.message.includes('threads'), 'survives a missing detail');

  console.log('zernioError self-check passed');
}
