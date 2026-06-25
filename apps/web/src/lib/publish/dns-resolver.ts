import { Resolver } from 'dns/promises';
import { registrableDomain } from '@pagespace/lib/validators/custom-domain';
import type { ResolvedRecords } from '@pagespace/lib/validators/custom-domain';
import { isPublicIp } from '@/lib/ai/tools/web-fetch-ssrf';

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
 * Fallbacks: query the target via the public *recursive* resolver when either
 *   - the NS lookup or its IP resolution fails/empty, OR
 *   - the authoritative query returns NO records at all.
 * The second case matters because the registrable-domain heuristic ("last 2
 * labels") picks the parent zone for a multi-segment public suffix
 * (`www.example.co.uk` → `co.uk`), and the target may also live in a deeper
 * delegated zone — in both cases the queried nameservers are authoritative only
 * for the parent and answer with a referral (no records). A public recursive
 * resolver performs full iterative resolution (follows referrals), so it
 * resolves those names correctly while still honoring TTLs and bypassing the
 * stale local Fly resolver. If everything fails, return empty arrays per record
 * type (the "not yet set" semantics) — this function never throws.
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
 * records, or none of them resolve to a public IP — the caller then falls back.
 *
 * The registrable domain (and thus its NS records) is attacker-controlled — a
 * customer registers any domain and points its NS wherever they like. So every
 * resolved IP is filtered through {@link isPublicIp} before it reaches
 * `setServers`: an NS record pointing at a private/loopback/link-local/reserved
 * address (e.g. `169.254.169.254` cloud metadata, `127.0.0.1`, `10.0.0.0/8`)
 * would otherwise turn this verifier into an SSRF vector that fires DNS queries
 * at internal hosts. Filtered-out IPs simply drop us to the public-resolver
 * fallback.
 */
async function resolveAuthoritativeNsIps(hostname: string, publicResolver: Resolver): Promise<string[]> {
  const domain = registrableDomain(hostname);
  if (!domain) return [];

  const nsHosts = await publicResolver.resolveNs(domain).catch(() => [] as string[]);
  if (nsHosts.length === 0) return [];

  const ipLists = await Promise.all(
    nsHosts.map((ns) => publicResolver.resolve4(ns).catch(() => [] as string[])),
  );
  // De-dupe, and only ever hand globally-routable public IPs to setServers.
  return [...new Set(ipLists.flat())].filter(isPublicIp);
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

/** Whether a resolution produced any A / AAAA / CNAME record. */
function hasAnyRecord(records: ResolvedRecords): boolean {
  return records.a.length > 0 || records.aaaa.length > 0 || records.cname.length > 0;
}

/**
 * Resolve a hostname's DNS records against its authoritative nameservers,
 * falling back to a public recursive resolver, then to empty arrays. NXDOMAIN,
 * ENODATA, ENOTFOUND, and timeouts all surface as empty arrays for that record
 * type — the caller treats them as "not yet set".
 */
export async function resolveHostname(hostname: string): Promise<ResolvedRecords> {
  const publicResolver = makeResolver(PUBLIC_DNS_SERVERS);

  // 1. Authoritative path — the source of truth, no local cache lag.
  const nsIps = await resolveAuthoritativeNsIps(hostname, publicResolver).catch(() => [] as string[]);
  if (nsIps.length > 0) {
    const authoritativeResolver = makeResolver(nsIps);
    const records = await queryRecords(authoritativeResolver, hostname);
    // A non-empty answer is authoritative — trust it. An all-empty answer means
    // the heuristic's zone wasn't authoritative for the target (a multi-segment
    // public suffix, or a deeper delegation that returns only a referral), so
    // fall through to the recursive resolver, which follows the referral chain.
    if (hasAnyRecord(records)) return records;
  }

  // 2. Fallback — public recursive resolver: follows referrals, honors TTLs, and
  //    still bypasses the stale local Fly resolver.
  return queryRecords(publicResolver, hostname);
}
