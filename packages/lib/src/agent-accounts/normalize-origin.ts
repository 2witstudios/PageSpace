/**
 * `normalizeOrigin` / `canonicalOriginOf` — the ONE origin rule (ADR 0004
 * §3.2), shared by account creation (the origins a human pins) and
 * `canonicalizeRequest` (the origin a request targets), so "the same origin"
 * means one thing on both sides of the comparison.
 *
 * `https://` only; host lowercased by the URL parser (IDNA → punycode, so a
 * Cyrillic lookalike becomes `xn--…`, never the ASCII name it imitates),
 * trailing dot dropped; the port ALWAYS written (`:443` included), so
 * `api.example.com` and `api.example.com:8443` are different origins; userinfo,
 * wildcards and IP literals refused (a private range is never an origin, and a
 * public IP needs a hostname the TLS certificate can be checked against).
 *
 * `normalizeOrigin` additionally refuses a value that carries a path, query or
 * fragment: a human pinning `https://api.example.com/v1` meant something an
 * origin cannot express, and silently dropping `/v1` would pin more than they
 * asked for. Pure.
 */
import type { CanonicalizeRefusal, CanonicalOrigin } from './canonical-request';

export type OriginRefusal = Extract<CanonicalizeRefusal, 'scheme_not_https' | 'userinfo_present' | 'wildcard_host' | 'ip_literal_host' | 'host_not_idna' | 'malformed'>;

export type OriginVerdict = { readonly ok: true; readonly origin: CanonicalOrigin } | { readonly ok: false; readonly reason: OriginRefusal };

export type NormalizeOriginVerdict = OriginVerdict | { readonly ok: false; readonly reason: 'not_an_origin' };

const DEFAULT_HTTPS_PORT = '443';
/** Letters-digits-hyphen labels, after the parser's IDNA→ASCII step. */
const LDH_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function canonicalOriginOf(url: URL): OriginVerdict {
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (url.username.length > 0 || url.password.length > 0) return { ok: false, reason: 'userinfo_present' };
  const rawHost = url.hostname;
  if (rawHost.length === 0) return { ok: false, reason: 'malformed' };
  if (rawHost.includes('*')) return { ok: false, reason: 'wildcard_host' };
  if (rawHost.startsWith('[') || IPV4_RE.test(rawHost)) return { ok: false, reason: 'ip_literal_host' };
  const host = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
  if (!LDH_HOST_RE.test(host)) return { ok: false, reason: 'host_not_idna' };
  const port = url.port.length === 0 ? DEFAULT_HTTPS_PORT : url.port;
  return { ok: true, origin: `https://${host}:${port}` as CanonicalOrigin };
}

export function normalizeOrigin({ raw }: { readonly raw: string }): NormalizeOriginVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // The URL parser rejects `*` in a host outright; name the rule the human broke.
    return /^https:\/\/[^/]*\*/i.test(raw.trim()) ? { ok: false, reason: 'wildcard_host' } : { ok: false, reason: 'malformed' };
  }
  const origin = canonicalOriginOf(url);
  if (!origin.ok) return origin;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search.length > 0 || url.hash.length > 0) return { ok: false, reason: 'not_an_origin' };
  return origin;
}
