/**
 * Helpers for privacy-safe logging. Logs may carry correlation ids, coarse
 * reason codes, counts and sizes — never email addresses, URLs (signed or not),
 * tokens, transcript/prompt text, person or document names, or biometric scores.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// JWT-looking (three base64url segments) and long opaque tokens.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const LONG_SECRET_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Strips emails, URLs, bearer/JWT tokens and long opaque secrets from free text. */
export function redactText(input: unknown): string {
  return String(input ?? '')
    .replace(BEARER_RE, '[token]')
    .replace(JWT_RE, '[token]')
    .replace(EMAIL_RE, '[email]')
    .replace(URL_RE, '[url]')
    .replace(LONG_SECRET_RE, '[redacted]');
}

/**
 * A log-safe one-line description of an error: its class, any code/status, and
 * a redacted, length-capped message. Provider/SDK errors routinely echo the
 * recipient address, request URL or response body, so never log them raw.
 */
export function describeError(err: unknown, maxLength = 200): string {
  if (err === null || err === undefined) return 'unknown error';
  const e = err as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const parts: string[] = [typeof e.name === 'string' && e.name ? e.name : typeof err];
  const code = e.code ?? undefined;
  const status = e.statusCode ?? e.status ?? undefined;
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code=${redactText(code)}`);
  if (typeof status === 'number') parts.push(`status=${status}`);
  const message = redactText(typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '').replace(/\s+/g, ' ').trim();
  const head = parts.join(' ');
  const full = message ? `${head}: ${message}` : head;
  return full.length > maxLength ? `${full.slice(0, maxLength)}…` : full;
}

/** Word count without keeping the words. */
export function countWords(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** The path of a request URL without query string or fragment (queries can carry tokens or ids). */
export function safePath(url: unknown, maxLength = 120): string {
  const path = String(url ?? '').split(/[?#]/)[0];
  return path.length > maxLength ? `${path.slice(0, maxLength)}…` : path;
}

/** Only the host of a user-supplied URL — the path/query may be private or signed. */
export function safeHost(url: unknown): string {
  try {
    return new URL(String(url ?? '')).host || 'unknown-host';
  } catch {
    return 'invalid-url';
  }
}
