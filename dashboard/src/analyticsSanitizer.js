const SENSITIVE_PROPERTY = /(?:api[_-]?key|authorization|password|secret|token|prompt|transcript|caption|media|file(?:name)?|title|job[_-]?id|raw[_-]?logs?|social[_-]?(?:user)?name|request[_-]?(?:headers?|bod(?:y|ies))|response[_-]?(?:headers?|bod(?:y|ies)))/i;
const URL_PROPERTY = /(?:^|[_$])(?:current_)?url$|referrer|referring_domain|pathname|host$|^(?:href|src|action|poster)$/i;
const URL_TEXT = /(?:https?|file|blob):\/\/[^\s)\]}>'"]+/gi;
const LOCAL_PATH = /(?:\/[A-Za-z0-9._ -]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/g;
const API_KEY_TEXT = /\b(?:phc|sk|zern|soniox)[_-][A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\b(?:api[_ -]?key|token|secret|bearer)\s*[:= ]\s*[A-Za-z0-9_-]{12,}\b/gi;
const FILENAME_TEXT = /\b[\w .-]+\.(?:mp4|mov|mkv|webm|avi|mp3|wav|m4a|png|jpe?g|gif|webp|srt|vtt|txt|log|json|jsx?|tsx?|py)\b/gi;
const SAFE_CONTEXT_VALUE = /[^a-zA-Z0-9._-]/g;
const SAFE_STACK_FRAME_PLATFORMS = new Set(['node:javascript', 'web:javascript', 'hermes']);

export function scrubText(value) {
  return String(value)
    .replace(URL_TEXT, '[redacted-url]')
    .replace(LOCAL_PATH, '[redacted-path]')
    .replace(FILENAME_TEXT, '[redacted-filename]')
    .replace(API_KEY_TEXT, '[redacted-secret]')
    .slice(0, 500);
}

export function safeContextValue(value, fallback = 'unknown') {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback;
  const safe = String(value).replace(SAFE_CONTEXT_VALUE, '').slice(0, 40);
  return safe || fallback;
}

export function buildExceptionFingerprint(parts) {
  return parts.map((part) => safeContextValue(part)).join(':');
}

function sanitizeStackFrame(frame) {
  if (!frame || typeof frame !== 'object') return undefined;

  const sanitized = {};
  if (SAFE_STACK_FRAME_PLATFORMS.has(frame.platform)) sanitized.platform = frame.platform;
  for (const key of ['filename', 'abs_path', 'module', 'function']) {
    if (typeof frame[key] === 'string') sanitized[key] = scrubText(frame[key]).slice(0, 200);
  }
  for (const key of ['lineno', 'colno']) {
    if (typeof frame[key] === 'number' && Number.isFinite(frame[key])) sanitized[key] = frame[key];
  }
  if (typeof frame.in_app === 'boolean') sanitized.in_app = frame.in_app;
  if (typeof frame.chunk_id === 'string') sanitized.chunk_id = scrubText(frame.chunk_id).slice(0, 200);
  return sanitized;
}

export function sanitizeStacktrace(stacktrace) {
  if (!stacktrace || typeof stacktrace !== 'object') return undefined;

  const sanitized = {};
  if (typeof stacktrace.type === 'string') sanitized.type = safeContextValue(stacktrace.type);
  sanitized.frames = Array.isArray(stacktrace.frames)
    ? stacktrace.frames.slice(-30).map(sanitizeStackFrame).filter(Boolean)
    : [];
  return sanitized;
}

function sanitizeMechanism(mechanism) {
  if (!mechanism || typeof mechanism !== 'object') return undefined;

  const sanitized = {};
  if (typeof mechanism.handled === 'boolean') sanitized.handled = mechanism.handled;
  if (typeof mechanism.synthetic === 'boolean') sanitized.synthetic = mechanism.synthetic;
  if (typeof mechanism.type === 'string') sanitized.type = safeContextValue(mechanism.type);
  return Object.keys(sanitized).length ? sanitized : undefined;
}

export function sanitizeExceptionList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 5).map((exception) => {
    const sanitized = {
      type: safeContextValue(exception?.type || exception?.name || 'Error'),
      value: scrubText(exception?.value || exception?.message || 'An error occurred'),
    };
    const stacktrace = typeof exception?.stacktrace === 'string'
      ? scrubText(exception.stacktrace)
      : sanitizeStacktrace(exception?.stacktrace);
    if (stacktrace) sanitized.stacktrace = stacktrace;
    const mechanism = sanitizeMechanism(exception?.mechanism);
    if (mechanism) sanitized.mechanism = mechanism;
    return sanitized;
  });
}

export function sanitizeNested(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeNested(item, seen));

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SENSITIVE_PROPERTY.test(key) || URL_PROPERTY.test(key)) continue;
    sanitized[key] = sanitizeNested(nestedValue, seen);
  }
  return sanitized;
}

export { SENSITIVE_PROPERTY, URL_PROPERTY };
