/**
 * `filterResponse` — the view of an upstream response that may be released
 * toward the model (L2·G2; epic invariant 3, redaction in depth).
 *
 * - Headers: an ALLOWLIST. `set-cookie`, auth challenges, echoed credential
 *   headers and anything unknown never pass. `location` is released as origin
 *   + path only: a redirect's query is where codes and tokens travel.
 * - Body: released only when it is text (a JSON/XML/text/form type, or no
 *   type and valid UTF-8); binary is omitted, since a scrub cannot read it.
 * - Scrub: the key in every encoding a site plausibly echoes it (raw,
 *   URL-encoded, base64, base64url, JSON-escaped), then token-shaped values —
 *   bearer tokens, JWTs, provider-prefixed keys, and the values of fields
 *   named like credentials. Scrub BEFORE truncating, so a key straddling the
 *   cut is collapsed whole and no prefix survives.
 *
 * This is a TRIPWIRE, not the boundary. An authorized site can echo a
 * credential in an encoding not listed here, or mint a new one (Λ10, a stated
 * non-guarantee). The boundary is that the executor never hands the model the
 * key. Every pattern is linear (one quantified class per run) so hostile
 * upstream bytes cannot make it backtrack. Pure.
 */
import { REDACTED_VALUE, redactKnownValues } from './redact-known-values';

export type ReleasedResponse = {
  readonly status: number;
  /** Lowercase names, in upstream order, allowlisted and scrubbed. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string | null;
  readonly bodyOmitted: null | 'empty' | 'binary';
  readonly truncated: boolean;
  /** Whether anything was scrubbed — the audit wants to know a site handed a value back. */
  readonly redacted: boolean;
};

const RELEASED_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-language',
  'etag',
  'last-modified',
  'date',
  'cache-control',
  'expires',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-request-id',
  'link',
  'location',
]);

const TEXT_TYPE_RE = /^(text\/[a-z0-9.+-]+|application\/([a-z0-9.-]+\+)?(json|xml)|application\/(x-www-form-urlencoded|javascript|x-ndjson))\s*(;|$)/i;

const BEARER_RE = /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const PREFIXED_KEY_RE = /\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{30,}/g;
// A field whose NAME says it holds a credential: `"access_token": "…"`, `password=…`. Value is one run.
const CREDENTIAL_FIELD_RE = /("?)\b((?:access|refresh|id)_token|api[_-]?key|apikey|client_secret|secret|password|passwd|token|authorization)\1(\s*[:=]\s*)("?)([^\s"&,;}]{1,})\4/gi;

function variantsOf(value: string): readonly string[] {
  const bytes = Buffer.from(value, 'utf8');
  return [value, encodeURIComponent(value), bytes.toString('base64'), bytes.toString('base64url'), JSON.stringify(value).slice(1, -1)];
}

function scrub(text: string, knownValues: readonly string[]): { readonly text: string; readonly redacted: boolean } {
  const known = redactKnownValues({ text, knownValues: knownValues.flatMap(variantsOf) });
  let out = known.text;
  const before = out;
  out = out
    .replace(JWT_RE, REDACTED_VALUE)
    .replace(BEARER_RE, (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(PREFIXED_KEY_RE, REDACTED_VALUE)
    .replace(CREDENTIAL_FIELD_RE, (_match, quote: string, name: string, separator: string, valueQuote: string) => `${quote}${name}${quote}${separator}${valueQuote}${REDACTED_VALUE}${valueQuote}`);
  return { text: out, redacted: known.redacted || out !== before };
}

/** The scrub reads UTF-8: a body declared in any other charset (UTF-16 would hide an echoed key) is not released as text. */
function isUtf8Charset(contentType: string): boolean {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  return charset === undefined || charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii';
}

function locationOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    // Relative: keep the path only.
    const path = value.split(/[?#]/)[0] ?? '';
    return path.startsWith('/') ? path : null;
  }
}

function truncateUtf8(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  // Decoding a cut mid-character yields U+FFFD (3 bytes); leave room for it.
  const cut = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, Math.max(0, maxBytes - 3)));
  return { text: cut, truncated: true };
}

export function filterResponse({
  status,
  headers,
  body,
  knownValues,
  maxBodyBytes,
}: {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
  readonly knownValues: readonly string[];
  readonly maxBodyBytes: number;
}): ReleasedResponse {
  let redacted = false;
  const released: [string, string][] = [];
  for (const [rawName, rawValue] of headers) {
    const name = rawName.toLowerCase();
    if (!RELEASED_HEADERS.has(name)) continue;
    const value = name === 'location' ? locationOf(rawValue) : rawValue;
    if (value === null) continue;
    const scrubbed = scrub(value, knownValues);
    redacted = redacted || scrubbed.redacted;
    released.push([name, scrubbed.text]);
  }

  if (body.byteLength === 0) return { status, headers: released, body: null, bodyOmitted: 'empty', truncated: false, redacted };

  const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null;
  let text: string;
  if (contentType === null || contentType.trim() === '') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { status, headers: released, body: null, bodyOmitted: 'binary', truncated: false, redacted };
    }
  } else if (TEXT_TYPE_RE.test(contentType.trim()) && isUtf8Charset(contentType)) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(body);
  } else {
    return { status, headers: released, body: null, bodyOmitted: 'binary', truncated: false, redacted };
  }

  // NUL-interleaved "UTF-8" is an undeclared UTF-16 body: the scrub cannot read it, so it is not released.
  if (text.includes('\u0000')) return { status, headers: released, body: null, bodyOmitted: 'binary', truncated: false, redacted };
  const scrubbed = scrub(text, knownValues);
  const cut = truncateUtf8(scrubbed.text, maxBodyBytes);
  return { status, headers: released, body: cut.text, bodyOmitted: null, truncated: cut.truncated, redacted: redacted || scrubbed.redacted };
}
