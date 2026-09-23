import { describe, it, expect } from 'vitest';
import type { CanonicalOrigin } from '../../canonical-request';
import { decideDestination } from '../../decide-destination';

// Threat model C2, B0 High (D-28) (ASI02). Credentialed redirects are denied.
// G2's executor attaches the account's credential to EVERY request it sends,
// so it follows NO redirect: each hop is re-authorized against the pin (so the
// audit and the caller learn where it pointed) and then refused; the 3xx is
// released, its Location reduced to origin + path. The end-to-end row (a real
// 302 off the pin, never requested) is in `http-executor-end-to-end.integration.test.ts`.

const PIN = ['https://api.example.com:443' as CanonicalOrigin];
const BASE = 'https://api.example.com/v1/start';

describe('adversarial: redirects', () => {
  it('given a 302 to another origin from a credentialed request, should not follow and should report the refusal', () => {
    const actual = decideDestination({ url: 'https://collector.evil.test/steal', base: BASE, allowedOrigins: PIN, hop: 'redirect' });
    const expected = { allow: false, reason: 'origin_not_allowed' };
    expect(actual).toEqual(expected);
  });

  it('given a 302 to the same origin, should still not follow — the new path was never approved, and the credential rides every hop', () => {
    const actual = decideDestination({ url: '/v1/other', base: BASE, allowedOrigins: PIN, hop: 'redirect' });
    const expected = { allow: false, reason: 'credentialed_redirect' };
    expect(actual).toEqual(expected);
  });

  it('given a redirect that would change the method (303) on a write, should refuse — no hop of any status is followed', () => {
    const actual = decideDestination({ url: 'https://api.example.com/v1/result', base: BASE, allowedOrigins: PIN, hop: 'redirect' });
    const expected = { allow: false, reason: 'credentialed_redirect' };
    expect(actual).toEqual(expected);
  });

  it('given a redirect chain of any length, should refuse at the first hop — the executor cap is zero', () => {
    const hops = ['/a', '/b', '/c'].map((url) => decideDestination({ url, base: BASE, allowedOrigins: PIN, hop: 'redirect' }).allow);
    const actual = hops;
    const expected = [false, false, false];
    expect(actual).toEqual(expected);
  });

  it.todo('given an explicitly configured transition with destination-specific credentials (later), should never forward the original auth header — I/O row, owned by a later gate (redirects are refused outright in G2)');
});
