/**
 * `canonicalizeRequest` — the ONE projection both the authority (before it
 * asks for approval) and the executor (before it sends) hash (ADR 0004 §3).
 *
 * The approval UI shows one representation of a request and the executor
 * must send exactly that one. This function turns an untrusted
 * `{ channel, method, url, headers, body, resources }` into the frozen
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
 * another with `digest_mismatch` never firing. The path follows the same
 * rule: each segment is decoded once ONLY to catch dot segments, `%2e%2e`
 * and control characters, and the digested form is the normalized raw
 * segment, so `foo;bar` and `foo%3Bbar` (a server that strips `;` path
 * parameters routes them differently) stay distinct and an encoded `/` can
 * never become a segment boundary.
 *
 * Rules, in the order they are applied (`canonical-request.ts` §3.2):
 *   - the channel must be in its closed union. The OPERATION is never read
 *     from the request: `lookupOperation` derives it (and the declared
 *     headers) from the reviewed registry by the account's providerSlug, the
 *     channel and the canonical method and path; no match is
 *     `unknown`/`generic_request`. A tool that could name its own operation
 *     could call a DELETE a read (G1a review M1);
 *   - method from the channel's closed set (HTTP upper-cased; relay and
 *     browser verbs are exact);
 *   - origin: `https://` only; the WHATWG parser does IDNA→ASCII and lower-
 *     casing; userinfo, wildcards and IP literals (the parser folds decimal,
 *     hex, octal and short forms into a dotted quad first, so every encoding
 *     is caught by one check) are REFUSED, never stripped; one trailing dot
 *     is dropped; the port is always written. A name that RESOLVES privately
 *     is admitted here — the address check belongs at connect time, per hop;
 *   - path: dot segments resolved by the parser; each segment percent-decoded
 *     ONCE on a copy, refused if a `.`/`..` part or a control character
 *     survives that decode; the segment itself is normalized as the query is;
 *   - query: split on the first `=` per pair, each half normalized as above,
 *     sorted by name with duplicates kept in input order;
 *   - headers: a caller-supplied reserved header is a refusal, not a strip;
 *     only `accept`, `content-type`, `content-length` and the matched entry's
 *     declared headers are projected; a VALUE carrying a control character is
 *     refused too, because a name-only check does not stop a CRLF pair from
 *     smuggling `authorization:` into an admitted `accept`;
 *   - `content-length` is always derived from the body bytes, so a caller who
 *     supplies a correct one digests identically to one who omits it;
 *   - `bodySha256` over the exact bytes (the empty body hashes to the digest
 *     of zero bytes); `resources` are the matched entry's `{slot}` values
 *     from the canonical path, sorted by slot, `[]` without a match — the
 *     request has no resources field (G1a review M8).
 *
 * Every field is checked before it is dereferenced — the containers
 * (`headers`, `body`, `resources`, `declaredHeaders`) included — so malformed
 * input is a `malformed` refusal, never a throw at the authorization boundary.
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
  GenericOperation,
  ReservedHeader,
} from './canonical-request';
import type { ExecutorChannel } from './grant';
import { lookupOperation } from './lookup-operation';
import { findRegistryEntryDefects } from './find-registry-entry-defects';
import { extractBodyResources } from './extract-body-resources';
import { deriveGitResources } from './derive-git-resources';
import { sortResourcePairs } from './sort-resource-pairs';
import { canonicalOriginOf } from './normalize-origin';

const METHODS_BY_CHANNEL: { readonly [C in ExecutorChannel]: readonly MethodFor[C][] } = {
  'http-executor': ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  'relay-runner': ['git-receive-pack', 'git-upload-pack', 'lfs-batch', 'lfs-upload'],
  'browser-worker': ['navigate', 'click', 'type', 'read', 'wait', 'fill'],
};

/** What every request without exactly one registry match is: never self-declared, never `read`. */
const GENERIC_OPERATION: GenericOperation = { class: 'unknown', name: 'generic_request' };

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

/** A plain `{ name: string }` record — not null, not an array. The containers arrive from an untrusted tool call. */
function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isExecutorChannel(value: unknown): value is ExecutorChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(METHODS_BY_CHANNEL, value);
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
function normalizeComponent(raw: string, keep: RegExp): NormalizeOutcome {
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
    out += keep.test(char) ? char : encodeWith(char, keep);
  }
  return { ok: true, value: out };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type PathVerdict = { readonly ok: true; readonly path: string } | Refusal;

function canonicalizePath(pathname: string): PathVerdict {
  const segments: string[] = [];
  for (const rawSegment of pathname.split('/')) {
    // The decoded copy is for the traversal and control-character checks
    // only; what is digested is the NORMALIZED segment, so `;` and `%3B`
    // stay two different requests.
    const decoded = decodeOnce(rawSegment);
    if (decoded === null) return refuse('malformed');
    if (CONTROL_CHAR_RE.test(decoded)) return refuse('path_control_char');
    if (decoded.split('/').some((part) => part === '.' || part === '..')) return refuse('path_traversal');
    const normalized = normalizeComponent(rawSegment, PATH_KEEP_RE);
    if (!normalized.ok) return normalized;
    segments.push(normalized.value);
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
    const name = normalizeComponent(eq === -1 ? part : part.slice(0, eq), QUERY_KEEP_RE);
    if (!name.ok) return name;
    const value = normalizeComponent(eq === -1 ? '' : part.slice(eq + 1), QUERY_KEEP_RE);
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

/** A query name for comparison only (never digested): decoded when it decodes, else as written. */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const canonicalizeRequest: CanonicalizeRequest = (call): CanonicalizeResult => {
  if (call === null || typeof call !== 'object') return refuse('malformed');
  const { request: input, providerSlug, registry } = call;
  if (providerSlug !== null && typeof providerSlug !== 'string') return refuse('malformed');
  if (!Array.isArray(registry)) return refuse('malformed');
  if (input === null || typeof input !== 'object') return refuse('malformed');
  if (!isExecutorChannel(input.channel)) return refuse('malformed');
  if (typeof input.method !== 'string' || typeof input.url !== 'string') return refuse('malformed');
  if (!isStringRecord(input.headers)) return refuse('malformed');
  if (!(input.body instanceof Uint8Array)) return refuse('malformed');

  const channel = input.channel;
  const method = channel === 'http-executor' ? input.method.toUpperCase() : input.method;
  if (!(METHODS_BY_CHANNEL[channel] as readonly string[]).includes(method)) return refuse('method_not_allowed');

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return refuse('malformed');
  }
  const origin = canonicalOriginOf(url);
  if (!origin.ok) return origin;
  const path = canonicalizePath(url.pathname);
  if (!path.ok) return path;
  const query = canonicalizeQuery(url.search);
  if (!query.ok) return query;
  const match = lookupOperation({ registry, providerSlug, origin: origin.origin, channel, method: method as CanonicalRequest['method'], path: path.path });
  const headers = canonicalizeHeaders(input.headers, match?.entry.declaredHeaders ?? [], input.body.byteLength);
  if (!headers.ok) return headers;

  const bodySha256 = createHash('sha256').update(input.body).digest('hex');
  // Bound by the matched entry from the ACTUAL request — its path slots (M8), its typed body slots
  // (G1c R5) and, for a relay push, the refs in the git command list (G1c R11) — never the caller's.
  let resources: readonly (readonly [string, string])[] = [];
  if (match !== null) {
    // The registry-load checks also hold at runtime: a defective entry (shared restriction key,
    // undeclared audit or restriction slot, malformed template) never projects resources or reaches
    // the audit allowlist, whether or not a loader ran (CodeRabbit on #2660).
    if (findRegistryEntryDefects({ registry: [match.entry] }).length > 0) return refuse('malformed');
    // A body-slot operation is read as JSON by exactly one route: a JSON content type, and no query
    // argument that shadows a body slot (a provider that also reads query arguments would act on it).
    if (match.entry.bodySlots.length > 0) {
      const contentType = headers.headers.find(([name]) => name === 'content-type')?.[1] ?? '';
      if (!/^application\/json\s*(;|$)/i.test(contentType)) return refuse('malformed');
      const shadowed = new Set(match.entry.bodySlots.map(({ pointer }) => (pointer[0] ?? '').toLowerCase()));
      if (query.query.some(([name]) => shadowed.has(decodeURIComponentSafe(name).toLowerCase()))) return refuse('malformed');
    }
    const body = extractBodyResources({ slots: match.entry.bodySlots, body: input.body });
    if (!body.ok) return refuse(body.reason);
    // Derived resources are relay-only (a registry defect elsewhere); `channel` already fixed `method` to a relay verb.
    const derived =
      channel === 'relay-runner'
        ? deriveGitResources({ method: method as MethodFor['relay-runner'], rules: match.entry.derivedResources, body: input.body })
        : ({ ok: true, resources: [] } as const);
    if (!derived.ok) return refuse(derived.reason);
    const keys = match.entry.restrictionKeys;
    const keyed = [...body.resources, ...derived.resources].map(([slot, value]) => [Object.prototype.hasOwnProperty.call(keys, slot) ? keys[slot]! : slot, value] as const);
    resources = sortResourcePairs([...match.resources, ...keyed]);
  }

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
      operation: match === null ? GENERIC_OPERATION : { class: match.entry.operation.class, name: match.entry.operation.name },
    },
  };
};
