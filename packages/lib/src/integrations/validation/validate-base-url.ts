/**
 * Integration target URL validation (SSRF guard).
 *
 * A connection's `baseUrlOverride` is user-supplied and becomes the fetch base
 * for every tool call, with the connection's credentials attached. Both the
 * routes that store it and the HTTP executor that uses it run this check so a
 * target can never be a non-globally-routable address — loopback, RFC 1918,
 * CGNAT, link-local, multicast, reserved, IPv6 ULA (Fly 6PN) / link-local /
 * mapped / NAT64, cloud metadata — whether written as an IP literal or as a
 * hostname that resolves there.
 *
 * Decisions come from the same primitives the `web_fetch` tool uses:
 * scheme + blocked-hostname checks from `security/url-validator`, and the
 * "is this address public?" decision from `security/web-fetch-ssrf`
 * (`isPublicIp`, fail-closed for anything that is not an IP). Hostnames are
 * resolved with `dns.lookup` (the resolver `fetch` uses) and EVERY returned
 * address must be public. On success the decision carries the address the
 * caller must connect to, so the connection is pinned to what was validated.
 */

import { promises as dns } from 'dns';
import { validateExternalURL } from '../../security/url-validator';
import { isPublicIp } from '../../security/web-fetch-ssrf';

const BLOCKED_TARGET_MESSAGE = 'Base URL must point at a public host';

export type IntegrationTargetDecision =
  | { ok: true; address: string }
  | { ok: false; reason: string };

export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface ValidateTargetOptions {
  /** Hostname resolver; defaults to `dns.lookup(hostname, { all: true })`. */
  resolve?: HostnameResolver;
  /** Bounds the DNS wait: an abort rejects with an `AbortError`. */
  signal?: AbortSignal;
}

const lookupAllAddresses: HostnameResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

const abortError = (): Error => {
  const error = new Error('Target validation aborted');
  error.name = 'AbortError';
  return error;
};

/** Stop waiting on `promise` as soon as `signal` aborts (the work itself is not cancellable). */
const raceWithAbort = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
};

/**
 * Decide whether an integration may send a credentialed request to `urlString`,
 * and to which address. Fails closed: an unparseable URL, a blocked scheme or
 * hostname, a non-public IP literal, a resolver failure, no addresses, or ANY
 * resolved address that is not public all return `{ ok: false }`.
 * Rejects (throws) with an `AbortError` if `signal` aborts while resolving.
 */
export const validateIntegrationTargetUrl = async (
  urlString: string,
  options: ValidateTargetOptions = {}
): Promise<IntegrationTargetDecision> => {
  const { resolve = lookupAllAddresses, signal } = options;

  if (signal?.aborted) throw abortError();

  const shape = await validateExternalURL(urlString, { skipDNSCheck: true });
  if (!shape.valid || !shape.url) {
    return { ok: false, reason: shape.error ?? BLOCKED_TARGET_MESSAGE };
  }

  // An IP literal: the URL parser already normalized it; it must be public.
  const literal = shape.resolvedIPs?.[0];
  if (literal !== undefined) {
    return isPublicIp(literal) ? { ok: true, address: literal } : { ok: false, reason: BLOCKED_TARGET_MESSAGE };
  }

  let addresses: string[];
  try {
    addresses = await raceWithAbort(resolve(shape.url.hostname), signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { ok: false, reason: 'Could not resolve hostname' };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'Hostname resolved to no addresses' };
  }

  for (const address of addresses) {
    if (!isPublicIp(address)) {
      return { ok: false, reason: BLOCKED_TARGET_MESSAGE };
    }
  }

  return { ok: true, address: addresses[0] };
};
