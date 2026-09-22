/**
 * `buildOutboundRequest` — the FRESH request the HTTP executor sends (L2·G2),
 * built from the canonical request the grant's digest covers plus the
 * resolved key. Never from the caller's raw request object: what is sent is
 * exactly what was digested, so "approve one, execute another" cannot happen
 * between verification and the wire.
 *
 * - URL: the canonical origin, path and query (already normalized, never
 *   decoded), plus the key parameter for a query placement.
 * - Headers: the canonical projection (`accept`, `content-type`, the derived
 *   `content-length`, registry-declared headers), `host`, and the key header
 *   for a header placement. Nothing else — no cookie, no forwarding header,
 *   no caller header that was not digested.
 * - Body: the exact bytes, refused unless their SHA-256 is the canonical
 *   `bodySha256`.
 * - The key is formatted by `applyAuth` (the pure formatter the integrations
 *   saga already uses, ADR 0005 §6). A placement that collides with a header or
 *   query parameter the request already carries is refused, not merged, so the
 *   model cannot pre-set the slot the key rides in; a key carrying CR/LF is
 *   refused so it can never split a header. Pure; the hash is injected.
 */
import type { HashBytes } from './grant';
import type { CanonicalRequest } from './canonical-request';
import type { SecretMaterialByKind } from './store/store-adapter';
import { applyAuth } from '../integrations/auth/apply-auth';

export type OutboundRequest = {
  readonly method: CanonicalRequest['method'];
  readonly url: string;
  /** The hostname the TLS certificate must match and the address is pinned for. */
  readonly hostname: string;
  readonly port: number;
  /** Lowercase names, sorted. */
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
};

export type OutboundRequestVerdict =
  | { readonly ok: true; readonly request: OutboundRequest }
  | { readonly ok: false; readonly reason: 'body_mismatch' | 'placement_collision' | 'key_invalid' | 'malformed' };

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

/**
 * How servers commonly fold query names: case-insensitively (ASP.NET) and with `.`, space and `[`
 * read as `_` (PHP). A caller parameter that folds to the placement name could be read instead of
 * the key, so collisions compare folded names.
 */
function foldQueryName(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // An undecodable name still compares by its raw form.
  }
  return decoded.toLowerCase().replace(/[.\s[]/g, '_');
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildOutboundRequest({
  canonical,
  body,
  material,
  sha256,
}: {
  readonly canonical: CanonicalRequest;
  readonly body: Uint8Array;
  readonly material: SecretMaterialByKind['api_key'];
  readonly sha256: HashBytes;
}): OutboundRequestVerdict {
  if (sha256(body) !== canonical.bodySha256) return { ok: false, reason: 'body_mismatch' };
  if (typeof material.value !== 'string' || material.value.length === 0 || CONTROL_CHAR_RE.test(material.value)) return { ok: false, reason: 'key_invalid' };

  const originMatch = /^https:\/\/([a-z0-9.-]+):(\d+)$/.exec(canonical.origin);
  if (originMatch === null) return { ok: false, reason: 'malformed' };
  const hostname = originMatch[1]!;
  const port = Number(originMatch[2]);

  const placement = material.placement;
  const auth = applyAuth({ apiKey: material.value }, { type: 'api_key', config: { placement: placement.in, paramName: placement.name } });

  const query = canonical.query.map(([name, value]) => `${name}=${value}`);
  for (const [name, value] of Object.entries(auth.queryParams)) {
    if (canonical.query.some(([existing]) => foldQueryName(existing) === foldQueryName(name))) return { ok: false, reason: 'placement_collision' };
    query.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }

  const headers: [string, string][] = canonical.headers.map(([name, value]) => [name, value]);
  for (const [rawName, value] of Object.entries(auth.headers)) {
    const name = rawName.toLowerCase();
    if (name === 'host' || headers.some(([existing]) => existing === name)) return { ok: false, reason: 'placement_collision' };
    headers.push([name, value]);
  }
  headers.push(['host', port === 443 ? hostname : `${hostname}:${port}`]);
  headers.sort(([a], [b]) => compareStrings(a, b));

  const authority = port === 443 ? hostname : `${hostname}:${port}`;
  const url = `https://${authority}${canonical.path}${query.length > 0 ? `?${query.join('&')}` : ''}`;
  return { ok: true, request: { method: canonical.method, url, hostname, port, headers, body } };
}
