import { resolve4, resolve6, resolveCname } from 'dns/promises';
import type { ResolvedRecords } from '@pagespace/lib/validators/custom-domain';

/**
 * Resolve a hostname's DNS records using the system resolver.
 * NXDOMAIN, ENODATA, ENOTFOUND, and timeouts all return empty arrays for
 * that record type — the caller treats them as "not yet set".
 */
export async function resolveHostname(hostname: string): Promise<ResolvedRecords> {
  const [a, aaaa, cname] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
    resolveCname(hostname).catch(() => [] as string[]),
  ]);
  return { a, aaaa, cname };
}
