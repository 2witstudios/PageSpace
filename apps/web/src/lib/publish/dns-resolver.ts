import { Resolver } from 'dns/promises';
import { registrableDomain } from '@pagespace/lib/validators/custom-domain';
import type { ResolvedRecords } from '@pagespace/lib/validators/custom-domain';

/**
 * Custom-domain DNS verification must reflect source-of-truth DNS immediately,
 * never a caching local resolver. Node's default `dns/promises` queries the app
 * server's system resolver (on Fly), which caches and lags authoritative DNS —
 * a false-negative at onboarding when a customer has just set the right record.
 *
 * So we resolve the target against its own authoritative nameservers:
 *   1. Find the registrable domain's NS records, via a fast PUBLIC resolver
 *      (so even the NS lookup doesn't hit the stale local resolver).
 *   2. Resolve those NS hostnames to IPs (public resolver too).
 *   3. Point a second resolver at those authoritative NS IPs and query the
 *      target there — no cache lag, the records as the domain owner published them.
 *
 * Fallbacks: if the NS lookup or its IP resolution fails/empty, query the target
 * via the public resolver — still far better than the local one. If everything
 * fails, return empty arrays per record type (the "not yet set" semantics) — this
 * function never throws.
 */

/** Fast public resolvers: Cloudflare, Google, Quad9. */
const PUBLIC_DNS_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

/** Per-lookup timeout so a dead/slow NS can't hang the verify request. */
const DNS_TIMEOUT_MS = 5000;
const DNS_TRIES = 2;

function makeResolver(servers: string[]): Resolver {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  resolver.setServers(servers);
  return resolver;
}

/**
 * Resolve the authoritative nameserver IPs for a hostname's registrable domain,
 * using the public resolver. Returns `[]` if the NS lookup fails, finds no NS
 * records, or none of them resolve to an IP — the caller then falls back.
 */
async function resolveAuthoritativeNsIps(hostname: string, publicResolver: Resolver): Promise<string[]> {
  const domain = registrableDomain(hostname);
  if (!domain) return [];

  const nsHosts = await publicResolver.resolveNs(domain).catch(() => [] as string[]);
  if (nsHosts.length === 0) return [];

  const ipLists = await Promise.all(
    nsHosts.map((ns) => publicResolver.resolve4(ns).catch(() => [] as string[])),
  );
  // De-dupe so we don't hand the same IP to setServers twice.
  return [...new Set(ipLists.flat())];
}

/**
 * Query a single hostname's A / AAAA / CNAME records through the given resolver.
 * Each record type is independent: a failure of one (no AAAA, no CNAME, timeout)
 * yields `[]` for that type and never breaks the others. Never throws.
 */
async function queryRecords(resolver: Resolver, hostname: string): Promise<ResolvedRecords> {
  const [a, aaaa, cname] = await Promise.all([
    resolver.resolve4(hostname).catch(() => [] as string[]),
    resolver.resolve6(hostname).catch(() => [] as string[]),
    resolver.resolveCname(hostname).catch(() => [] as string[]),
  ]);
  return { a, aaaa, cname };
}

/**
 * Resolve a hostname's DNS records against its authoritative nameservers,
 * falling back to a public resolver, then to empty arrays. NXDOMAIN, ENODATA,
 * ENOTFOUND, and timeouts all surface as empty arrays for that record type —
 * the caller treats them as "not yet set".
 */
export async function resolveHostname(hostname: string): Promise<ResolvedRecords> {
  const publicResolver = makeResolver(PUBLIC_DNS_SERVERS);

  // 1. Authoritative path — the source of truth, no local cache lag.
  const nsIps = await resolveAuthoritativeNsIps(hostname, publicResolver).catch(() => [] as string[]);
  if (nsIps.length > 0) {
    const authoritativeResolver = makeResolver(nsIps);
    return queryRecords(authoritativeResolver, hostname);
  }

  // 2. Fallback — public resolver (still bypasses the stale local resolver).
  return queryRecords(publicResolver, hostname);
}
