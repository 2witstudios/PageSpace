/**
 * `decidePinnedAddress` — which resolved address the executor's connection is
 * pinned to (L2·G2; DNS-rebinding defence, threat model C2).
 *
 * The network shell resolves the pinned hostname ONCE, classifies every answer
 * with its injected classifier (public or not — `isPublicIp` in production),
 * and hands them here; it then connects to exactly the address returned and
 * verifies the TLS certificate against the hostname. It never re-resolves, so
 * a second, different DNS answer cannot redirect the connection.
 *
 * The whole answer is refused if ANY address is not public. An answer that
 * mixes a public and a private record is a rebinding attempt; picking the
 * public one only wins the race this time. IPv4 is preferred when present
 * (deterministic, and the address family most upstreams serve first). Pure.
 */
export type ResolvedAddress = { readonly address: string; readonly family: 4 | 6; readonly isPublic: boolean };

export type PinnedAddressVerdict =
  | { readonly ok: true; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly reason: 'no_address' | 'non_public_address' };

export function decidePinnedAddress({ addresses }: { readonly addresses: readonly ResolvedAddress[] }): PinnedAddressVerdict {
  if (addresses.length === 0) return { ok: false, reason: 'no_address' };
  if (addresses.some((entry) => entry.isPublic !== true)) return { ok: false, reason: 'non_public_address' };
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { ok: true, address: chosen.address, family: chosen.family };
}
