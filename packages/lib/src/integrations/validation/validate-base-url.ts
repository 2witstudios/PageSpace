/**
 * Integration target URL validation (SSRF guard).
 *
 * A connection's `baseUrlOverride` is user-supplied and becomes the fetch base
 * for every tool call, with the connection's credentials attached. Both the
 * routes that store it and the HTTP executor that uses it run this check so a
 * target can never be loopback, private (RFC 1918), link-local, unique-local
 * (Fly 6PN), or a cloud-metadata address — whether written as an IP literal or
 * as a hostname that resolves there.
 *
 * Mirrors the `web_fetch` tool's shell: scheme/host/IP-literal decisions come
 * from `security/url-validator`, and hostnames are resolved with `dns.lookup`
 * (the resolver `fetch` itself uses) with EVERY returned address checked. The
 * executor re-runs this immediately before each connect and each redirect hop.
 */

import { promises as dns } from 'dns';
import { validateExternalURL, isBlockedIP } from '../../security/url-validator';

const BLOCKED_TARGET_MESSAGE = 'Base URL must point at a public host';

export type IntegrationTargetDecision = { ok: true } | { ok: false; reason: string };

export type HostnameResolver = (hostname: string) => Promise<string[]>;

const lookupAllAddresses: HostnameResolver = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

/**
 * Decide whether an integration may send a credentialed request to `urlString`.
 * Fails closed: an unparseable URL, a blocked scheme or hostname, an IP literal
 * in a blocked range, a resolver failure, or ANY resolved address in a blocked
 * range all return `{ ok: false }`.
 */
export const validateIntegrationTargetUrl = async (
  urlString: string,
  resolve: HostnameResolver = lookupAllAddresses
): Promise<IntegrationTargetDecision> => {
  const shape = await validateExternalURL(urlString, { skipDNSCheck: true });
  if (!shape.valid || !shape.url) {
    return { ok: false, reason: shape.error ?? BLOCKED_TARGET_MESSAGE };
  }

  // An IP literal was already checked against the blocked ranges above.
  if (shape.resolvedIPs && shape.resolvedIPs.length > 0) {
    return { ok: true };
  }

  let addresses: string[];
  try {
    addresses = await resolve(shape.url.hostname);
  } catch {
    return { ok: false, reason: 'Could not resolve hostname' };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'Hostname resolved to no addresses' };
  }

  for (const address of addresses) {
    if (isBlockedIP(address)) {
      return { ok: false, reason: BLOCKED_TARGET_MESSAGE };
    }
  }

  return { ok: true };
};
