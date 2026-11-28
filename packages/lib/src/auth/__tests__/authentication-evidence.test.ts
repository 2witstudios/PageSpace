import { describe, expect, it } from 'vitest';
import { ceremonyAuthentication, EVIDENCE_FUTURE_SKEW_MS, parseVerifiedAuthentication, type SignInCeremony } from '../authentication-evidence';

const nowMs = Date.parse('2026-10-12T12:00:00Z');

describe('the evidence each sign-in ceremony records (D-OW-45)', () => {
  it.each<[SignInCeremony, 'single_factor' | 'user_verified_passkey']>([
    [{ method: 'magic_link' }, 'single_factor'],
    [{ method: 'google' }, 'single_factor'],
    [{ method: 'apple' }, 'single_factor'],
    [{ method: 'passkey', userVerified: false }, 'single_factor'],
    [{ method: 'passkey', userVerified: true }, 'user_verified_passkey'],
  ])('SEC-2 (partial) %o records %s at the ceremony time', (ceremony, assurance) => {
    expect(ceremonyAuthentication(ceremony, nowMs)).toEqual({ authenticatedAtMs: nowMs, assurance });
  });
});

describe('evidence read on another clock (review #2866 B5)', () => {
  it('SEC-3 (partial) a ceremony time up to 120 s ahead counts as clock skew and is clamped to now', () => {
    expect(EVIDENCE_FUTURE_SKEW_MS).toBe(120_000);
    expect(parseVerifiedAuthentication({ authenticatedAtMs: nowMs + 120_000, assurance: 'single_factor' }, nowMs))
      .toEqual({ authenticatedAtMs: nowMs, assurance: 'single_factor' });
    expect(parseVerifiedAuthentication({ authenticatedAtMs: nowMs + 5, assurance: 'user_verified_passkey' }, nowMs))
      .toEqual({ authenticatedAtMs: nowMs, assurance: 'user_verified_passkey' });
  });

  it('SEC-3 (partial) a ceremony time beyond the skew still fails closed', () => {
    expect(parseVerifiedAuthentication({ authenticatedAtMs: nowMs + 120_001, assurance: 'single_factor' }, nowMs)).toBeNull();
  });

  it('SEC-3 (partial) a past ceremony time is kept as stored', () => {
    expect(parseVerifiedAuthentication({ authenticatedAtMs: nowMs - 1, assurance: 'single_factor' }, nowMs))
      .toEqual({ authenticatedAtMs: nowMs - 1, assurance: 'single_factor' });
  });
});
