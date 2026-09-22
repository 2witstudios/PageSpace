/**
 * May the browser open a connection to this URL? — the one navigation and
 * egress decision, pure (Control Board §7.1).
 *
 * It is asked in two places, with the same rules:
 *  - by the web tool before a `browser_navigate` (hygiene: a clear refusal
 *    before a browser is even woken), and
 *  - by the worker's egress proxy for EVERY connection Chromium opens —
 *    navigations, redirects, subresources, fetch/XHR, forms, WebSockets.
 *    That second place is the boundary (S3 §3.5); redirects are followed by
 *    the browser, so a check in `navigate()` alone would be decoration.
 *
 * THE RULES, in the order they are applied (the first that fails decides):
 *  1. A web transport only: http, https, ws, wss. `file:`, `javascript:`,
 *     `data:`, `chrome:` and the rest never leave the page as a request.
 *  2. No userinfo: `https://accounts.example.com@evil.test/` renders as a
 *     lookalike and is refused outright.
 *  3. No internal surface by NAME: loopback names, `.local`, the Fly
 *     internal zones and Tigris (`egress.ts`'s deny list, reused so the two
 *     stay in lockstep), cloud-metadata names, and `*.sprites.app` — the
 *     browser has no business reaching another sandbox's edge URL.
 *  4. IP literals must be public in every encoding (`isPublicIp`, the same
 *     IANA allowlist `web_fetch` uses; integer, hex, octal and IPv4-mapped
 *     forms included).
 *  5. A pinned session may reach only its transport origins (secure-or-
 *     plaintext + host + port; S3 R12). This is decided BEFORE any lookup,
 *     so an off-pin name is never even resolved.
 *  6. A hostname is resolved by the caller (`verdict: 'resolve'`), then EVERY
 *     address must be public. One private address in the answer denies the
 *     whole name: that is the DNS-rebinding case, where the connection could
 *     land on either.
 *  7. An allowed connection is PINNED to `connectAddress`, an address this
 *     function checked. The caller connects to that address and never looks
 *     the name up again, so a rebinding resolver gets no second answer.
 *
 * `https:`/`wss:` are one transport unit and `http:`/`ws:` another, because
 * a non-intercepting proxy sees `CONNECT host:443` for both (S3 R12, round 4).
 */
import { isIpLiteral, isPublicIp } from '@pagespace/lib/security/web-fetch-ssrf';
import { buildInternalSurfaceDenyRules } from '@pagespace/lib/services/sandbox/egress';

export type NavigationDenyReason =
  | 'invalid-url'
  | 'scheme-not-allowed'
  | 'credentials-in-url'
  | 'internal-host'
  | 'private-address'
  | 'unresolved'
  | 'origin-not-allowed';

export type TransportOrigin = {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
};

export type NavigationVerdict =
  | { readonly verdict: 'allow'; readonly transportOrigin: TransportOrigin; readonly connectAddress: string }
  | { readonly verdict: 'resolve'; readonly host: string }
  | { readonly verdict: 'deny'; readonly reason: NavigationDenyReason };

export type DecideNavigationOptions = {
  readonly url: string;
  /** Every address the host resolved to, or `null` if it has not been resolved yet. */
  readonly resolvedAddresses: readonly string[] | null;
  /** The session's pinned origins, or `null` for the public web. */
  readonly allowedOrigins: readonly string[] | null;
};

const TRANSPORTS: Readonly<Record<string, { readonly secure: boolean; readonly defaultPort: number }>> = Object.freeze({
  'https:': { secure: true, defaultPort: 443 },
  'wss:': { secure: true, defaultPort: 443 },
  'http:': { secure: false, defaultPort: 80 },
  'ws:': { secure: false, defaultPort: 80 },
});

/** Zones whose apex and every subdomain are never reachable, beyond the Fly internal surface. */
const INTERNAL_ZONES: readonly string[] = Object.freeze([
  'localhost',
  'local',
  'sprites.app',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
  ...buildInternalSurfaceDenyRules().map((rule) => String(rule.domain).replace(/^\*\./, '')),
]);

const isInternalHost = (host: string): boolean => INTERNAL_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`));

const bareHost = (hostname: string): string => hostname.replace(/^\[|\]$/g, '');

const toTransportOrigin = (url: URL): TransportOrigin | null => {
  const transport = TRANSPORTS[url.protocol];
  if (transport === undefined) return null;
  return {
    secure: transport.secure,
    host: url.hostname.replace(/\.$/, ''),
    port: url.port === '' ? transport.defaultPort : Number(url.port),
  };
};

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const sameTransportOrigin = (a: TransportOrigin, b: TransportOrigin): boolean => a.secure === b.secure && a.host === b.host && a.port === b.port;

const isPinned = (origin: TransportOrigin, allowedOrigins: readonly string[]): boolean =>
  allowedOrigins.some((entry) => {
    const parsed = parseUrl(entry);
    const pinned = parsed === null ? null : toTransportOrigin(parsed);
    return pinned !== null && sameTransportOrigin(origin, pinned);
  });

export const decideNavigation = ({ url, resolvedAddresses, allowedOrigins }: DecideNavigationOptions): NavigationVerdict => {
  const parsed = parseUrl(url);
  if (parsed === null) return { verdict: 'deny', reason: 'invalid-url' };

  const transportOrigin = toTransportOrigin(parsed);
  if (transportOrigin === null) return { verdict: 'deny', reason: 'scheme-not-allowed' };
  if (parsed.username !== '' || parsed.password !== '') return { verdict: 'deny', reason: 'credentials-in-url' };

  const host = bareHost(transportOrigin.host);
  if (isInternalHost(host)) return { verdict: 'deny', reason: 'internal-host' };

  const literal = isIpLiteral(host);
  if (literal && !isPublicIp(host)) return { verdict: 'deny', reason: 'private-address' };

  if (allowedOrigins !== null && !isPinned(transportOrigin, allowedOrigins)) return { verdict: 'deny', reason: 'origin-not-allowed' };

  if (literal) return { verdict: 'allow', transportOrigin, connectAddress: host };
  if (resolvedAddresses === null) return { verdict: 'resolve', host };
  if (resolvedAddresses.length === 0) return { verdict: 'deny', reason: 'unresolved' };
  if (!resolvedAddresses.every((address) => isPublicIp(address))) return { verdict: 'deny', reason: 'private-address' };

  return { verdict: 'allow', transportOrigin, connectAddress: resolvedAddresses[0] };
};
