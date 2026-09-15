/**
 * `canonicalizeRequest` — the ONE projection both the authority (before it
 * asks for approval) and the executor (before it sends) hash (ADR 0004 §3).
 *
 * The approval UI shows one representation of a request and the executor
 * must send exactly that one. This function turns an untrusted
 * `{ method, url, headers, body, resources, operation }` into the frozen
 * `CanonicalRequest` — a fixed field set in a fixed order, absent optionals
 * as `[]` never a missing key — or refuses with a reason that names the rule
 * (F18). Refusals are for the human and the audit; the model never sees
 * which rule fired.
 *
 * TWO REQUESTS THAT DIFFER MUST DIGEST DIFFERENTLY. That is the property the
 * whole approval binding rests on, and it is easy to lose by normalizing too
 * hard. So the query is NORMALIZED, not decoded: percent-escapes are
 * upper-cased and the unreserved set is unescaped, but everything else stays
 * encoded, which keeps `a+b` distinct from `a%2Bb` (a form-decoding server
 * reads the first as `a b`) and `/safe` distinct from `%2Fsafe`. Decoding the
 * query and hashing the decoded text collapsed all three into one digest —
 * the human would approve one representation and the executor could send
 * another with `digest_mismatch` never firing. The path is different on
 * purpose: it is decoded once so dot segments and `%2e%2e` are caught, then
 * re-encoded canonically, and an encoded `/` stays encoded so it can never
 * become a segment boundary.
 *
 * Rules, in the order they are applied (`canonical-request.ts` §3.2):
 *   - channel and operation must be in their closed unions, and the
 *     operation NAME must be catalogue-shaped: it is interpolated into the
 *     approval headline, so free text there lets a model author what the
 *     human reads (ASI06);
 *   - method from the channel's closed set (HTTP upper-cased; relay and
 *     browser verbs are exact);
 *   - origin: `https://` only; the WHATWG parser does IDNA→ASCII and lower-
 *     casing; userinfo, wildcards and IP literals (the parser folds decimal,
 *     hex, octal and short forms into a dotted quad first, so every encoding
 *     is caught by one check) are REFUSED, never stripped; one trailing dot
 *     is dropped; the port is always written. A name that RESOLVES privately
 *     is admitted here — the address check belongs at connect time, per hop;
 *   - path: dot segments resolved by the parser, each segment percent-decoded
 *     ONCE, refused if a `.`/`..` part or a control character survives that
 *     decode, then re-encoded canonically;
 *   - query: split on the first `=` per pair, each half normalized as above,
 *     sorted by name with duplicates kept in input order;
 *   - headers: a caller-supplied reserved header is a refusal, not a strip;
 *     only `accept`, `content-type`, `content-length` and the operation's
 *     declared headers are projected; a VALUE carrying a control character is
 *     refused too, because a name-only check does not stop a CRLF pair from
 *     smuggling `authorization:` into an admitted `accept`;
 *   - `content-length` is always derived from the body bytes, so a caller who
 *     supplies a correct one digests identically to one who omits it;
 *   - `bodySha256` over the exact bytes (the empty body hashes to the digest
 *     of zero bytes); `resources` sorted by key.
 *
 * Pure and total: same input → same output, no I/O, no clock. The SHA-256 of
 * the body is a deterministic function of the input, not an injected
 * primitive, because the frozen `CanonicalizeRequest` signature carries no
 * hash parameter and the digest of the WHOLE projection is where injection
 * happens (`digestRequest`).
 */
import { createHash } from 'crypto';
import type {
  CanonicalOrigin,
  CanonicalRequest,
  CanonicalizeRefusal,
  CanonicalizeRequest,
  CanonicalizeResult,
  MethodFor,
  ProjectedHeader,
  ReservedHeader,
} from './canonical-request';
import type { ExecutorChannel, OperationClass, OperationRef } from './grant';

const METHODS_BY_CHANNEL: { readonly [C in ExecutorChannel]: readonly MethodFor[C][] } = {
  'http-executor': ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  'relay-runner': ['git-receive-pack', 'git-upload-pack', 'lfs-batch', 'lfs-upload'],
  'browser-worker': ['navigate', 'click', 'type', 'read', 'wait', 'fill'],
};

const OPERATION_CLASSES: readonly OperationClass[] = ['read', 'write', 'irreversible', 'privilege', 'unknown'];

/**
 * The shape a reviewed catalogue entry has (`github.issues.create`). It is
 * deliberately narrow: this string reaches the human in the approval
 * headline, so anything that could fake a second line, a separator or a
 * class suffix is refused before it can be rendered.
 */
const OPERATION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const RESERVED_HEADERS: readonly ReservedHeader[] = [
  'authorization',
  'cookie',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'transfer-encoding',
  'connection',
  'upgrade',
];

/** `proxy-*` and `x-forwarded-*` are reserved as families, not only the named members. */
const RESERVED_HEADER_PREFIXES: readonly string[] = ['proxy-', 'x-forwarded-'];

const PROJECTED_HEADERS: readonly ProjectedHeader[] = ['accept', 'content-type', 'content-length'];

const DEFAULT_HTTPS_PORT = '443';

/** Host labels after IDNA→ASCII: letters, digits, hyphen; no leading/trailing hyphen. */
const LDH_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Written with \x escapes on purpose: a literal NUL in this file makes grep and ripgrep skip it as binary. */
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/** RFC 3986 unreserved — the only set whose percent-escapes may be unescaped without changing meaning. */
const UNRESERVED_RE = /[A-Za-z0-9\-._~]/;
/** Characters kept verbatim in a re-encoded PATH segment: unreserved + sub-delims + `:@`. */
const PATH_KEEP_RE = /[A-Za-z0-9\-._~!$&'()*+,;=:@]/;
/**
 * Characters kept verbatim in a NORMALIZED query component. `&` is absent
 * because it separates pairs; `=` may appear inside a value after the first
 * one and is kept, so `x=y` and `x%3Dy` stay distinct.
 */
const QUERY_KEEP_RE = /[A-Za-z0-9\-._~!$'()*+,;:@/?=]/;
const HEX_PAIR_RE = /^[0-9A-Fa-f]{2}$/;

type Refusal = { readonly ok: false; readonly reason: CanonicalizeRefusal };
const refuse = (reason: CanonicalizeRefusal): Refusal => ({ ok: false, reason });

function isExecutorChannel(value: unknown): value is ExecutorChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METHODS_BY_CHANNEL, value);
}

function isOperationRef(value: unknown): value is OperationRef {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.class === 'string' &&
    (OPERATION_CLASSES as readonly string[]).includes(record.class) &&
    typeof record.name === 'string' &&
    OPERATION_NAME_RE.test(record.name)
  );
}

/** Percent-encode every byte of `text` outside `keep`, upper-case hex. */
function encodeWith(text: string, keep: RegExp): string {
  let out = '';
  for (const char of text) {
    if (keep.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** Percent-decode exactly once; `null` for a malformed escape. Never treats `+` as a space. */
function decodeOnce(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

type NormalizeOutcome = { readonly ok: true; readonly value: string } | Refusal;

/**
 * RFC 3986 normalization WITHOUT decoding: upper-case the hex of every
 * escape, unescape only the unreserved set, percent-encode anything the
 * component may not carry verbatim, and refuse a control character in either
 * form. Two components that normalize alike are the same octets; two that
 * differ stay different, which is what keeps the digest honest.
 */
function normalizeQueryComponent(raw: string): NormalizeOutcome {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '%') {
      const hex = raw.slice(index + 1, index + 3);
      if (!HEX_PAIR_RE.test(hex)) return refuse('malformed');
      const byte = Number.parseInt(hex, 16);
      if (byte <= 0x1f || byte === 0x7f) return refuse('path_control_char');
      const decoded = String.fromCharCode(byte);
      out += UNRESERVED_RE.test(decoded) ? decoded : `%${hex.toUpperCase()}`;
      index += 2;
      continue;
    }
    if (CONTROL_CHAR_RE.test(char)) return refuse('path_control_char');
    out += QUERY_KEEP_RE.test(char) ? char : encodeWith(char, QUERY_KEEP_RE);
  }
  return { ok: true, value: out };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type OriginVerdict = { readonly ok: true; readonly origin: CanonicalOrigin } | Refusal;

function canonicalizeOrigin(url: URL): OriginVerdict {
  if (url.protocol !== 'https:') return refuse('scheme_not_https');
  if (url.username.length > 0 || url.password.length > 0) return refuse('userinfo_present');
  const rawHost = url.hostname;
  if (rawHost.length === 0) return refuse('malformed');
  if (rawHost.includes('*')) return refuse('wildcard_host');
  if (rawHost.startsWith('[') || IPV4_RE.test(rawHost)) return refuse('ip_literal_host');
  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (!LDH_HOST_RE.test(host)) return refuse('host_not_idna');
  const port = url.port.length === 0 ? DEFAULT_HTTPS_PORT : url.port;
  return { ok: true, origin: `https://${host}:${port}` as CanonicalOrigin };
}

type PathVerdict = { readonly ok: true; readonly path: string } | Refusal;

function canonicalizePath(pathname: string): PathVerdict {
  const segments: string[] = [];
  for (const rawSegment of pathname.split('/')) {
    const decoded = decodeOnce(rawSegment);
    if (decoded === null) return refuse('malformed');
    if (CONTROL_CHAR_RE.test(decoded)) return refuse('path_control_char');
    if (decoded.split('/').some((part) => part === '.' || part === '..')) return refuse('path_traversal');
    segments.push(encodeWith(decoded, PATH_KEEP_RE));
  }
  return { ok: true, path: segments.join('/') };
}

type QueryVerdict = { readonly ok: true; readonly query: readonly (readonly [string, string])[] } | Refusal;

function canonicalizeQuery(search: string): QueryVerdict {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw.length === 0) return { ok: true, query: [] };
  const pairs: (readonly [string, string])[] = [];
  for (const part of raw.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    // A bare flag (`?force`) and an explicit empty value (`?force=`) both
    // project as `[name, '']`: the frozen pair shape cannot hold the
    // difference, so they are one canonical request by construction.
    const name = normalizeQueryComponent(eq === -1 ? part : part.slice(0, eq));
    if (!name.ok) return name;
    const value = normalizeQueryComponent(eq === -1 ? '' : part.slice(eq + 1));
    if (!value.ok) return value;
    pairs.push([name.value, value.value]);
  }
  // Stable sort by name only: duplicates keep their input order.
  const sorted = [...pairs].sort((a, b) => compareStrings(a[0], b[0]));
  return { ok: true, query: sorted };
}

type HeadersVerdict = { readonly ok: true; readonly headers: readonly (readonly [string, string])[] } | Refusal;

function canonicalizeHeaders(
  headers: Readonly<Record<string, string>>,
  declaredHeaders: readonly string[],
  bodyBytes: number,
): HeadersVerdict {
  const projected = new Set<string>([...PROJECTED_HEADERS, ...declaredHeaders.map((name) => name.toLowerCase())]);
  const out = new Map<string, string>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if ((RESERVED_HEADERS as readonly string[]).includes(name) || RESERVED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return refuse('reserved_header');
    }
    if (!projected.has(name)) continue;
    if (out.has(name)) return refuse('malformed');
    // A reserved-header check by NAME does not stop header injection: a CRLF
    // inside an admitted value smuggles `authorization:` past it, and the
    // approval subject carries no header values for a human to notice.
    if (CONTROL_CHAR_RE.test(rawValue)) return refuse('malformed');
    out.set(name, rawValue.trim());
  }
  // `content-length` is DERIVED, always: a caller who supplies one that
  // disagrees with the bytes is malformed, and a caller who supplies a
  // correct one must produce the same projection — and therefore the same
  // digest — as a caller who omitted it.
  const claimedLength = out.get('content-length');
  if (claimedLength !== undefined && (!/^\d+$/.test(claimedLength) || Number(claimedLength) !== bodyBytes)) {
    return refuse('malformed');
  }
  out.set('content-length', String(bodyBytes));
  const sorted = [...out.entries()].map(([name, value]) => [name, value] as const).sort((a, b) => compareStrings(a[0], b[0]));
  return { ok: true, headers: sorted };
}

export const canonicalizeRequest: CanonicalizeRequest = (input): CanonicalizeResult => {
  if (!isExecutorChannel(input.channel)) return refuse('malformed');
  if (!isOperationRef(input.operation)) return refuse('malformed');
  if (typeof input.method !== 'string' || typeof input.url !== 'string') return refuse('malformed');

  const channel = input.channel;
  const method = channel === 'http-executor' ? input.method.toUpperCase() : input.method;
  if (!(METHODS_BY_CHANNEL[channel] as readonly string[]).includes(method)) return refuse('method_not_allowed');

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return refuse('malformed');
  }
  const origin = canonicalizeOrigin(url);
  if (!origin.ok) return origin;
  const path = canonicalizePath(url.pathname);
  if (!path.ok) return path;
  const query = canonicalizeQuery(url.search);
  if (!query.ok) return query;
  const headers = canonicalizeHeaders(input.headers, input.declaredHeaders, input.body.byteLength);
  if (!headers.ok) return headers;

  const bodySha256 = createHash('sha256').update(input.body).digest('hex');
  const resources = Object.entries(input.resources)
    .map(([key, value]) => [key, value] as const)
    .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]));

  return {
    ok: true,
    canonical: {
      channel,
      method: method as CanonicalRequest['method'],
      origin: origin.origin,
      path: path.path,
      query: query.query,
      headers: headers.headers,
      bodySha256,
      resources,
      operation: { class: input.operation.class, name: input.operation.name },
    },
  };
};
