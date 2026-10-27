/**
 * L2·G2 — `decidePinnedAddress`: which resolved address the executor's
 * connection is pinned to (DNS-rebinding defence; `web-fetch-ssrf.ts` is pure
 * decisions, so the network shell resolves ONCE, asks this function, and
 * connects to exactly the address it returns — never re-resolving the name).
 *
 * The shell classifies each address (public or not) with an injected
 * classifier; this decision refuses the whole answer if ANY address is not
 * public. A resolver that returns one public and one private record is a
 * rebinding attempt, and picking the public one would only win the race this
 * time.
 */
import { describe, expect, it } from 'vitest';
import { decidePinnedAddress } from '../decide-pinned-address';

describe('decidePinnedAddress', () => {
  it('given only public addresses, should pin the first IPv4 address, else the first address', () => {
    const actual = [
      decidePinnedAddress({ addresses: [{ address: '2606:4700::1', family: 6, isPublic: true }, { address: '93.184.216.34', family: 4, isPublic: true }] }),
      decidePinnedAddress({ addresses: [{ address: '2606:4700::1', family: 6, isPublic: true }] }),
    ];
    const expected = [
      { ok: true, address: '93.184.216.34', family: 4 },
      { ok: true, address: '2606:4700::1', family: 6 },
    ];
    expect(actual).toEqual(expected);
  });

  it('given any non-public address among the answers, should refuse the whole answer', () => {
    const actual = decidePinnedAddress({ addresses: [{ address: '93.184.216.34', family: 4, isPublic: true }, { address: '169.254.169.254', family: 4, isPublic: false }] });
    const expected = { ok: false, reason: 'non_public_address' };
    expect(actual).toEqual(expected);
  });

  it('given no addresses, should refuse no_address', () => {
    const actual = decidePinnedAddress({ addresses: [] });
    const expected = { ok: false, reason: 'no_address' };
    expect(actual).toEqual(expected);
  });

  it('given a classification that is anything but true, should treat the address as not public', () => {
    const actual = decidePinnedAddress({ addresses: [{ address: '93.184.216.34', family: 4, isPublic: 'yes' as unknown as boolean }] });
    const expected = { ok: false, reason: 'non_public_address' };
    expect(actual).toEqual(expected);
  });
});
