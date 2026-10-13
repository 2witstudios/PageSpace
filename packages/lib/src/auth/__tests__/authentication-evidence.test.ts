import { describe, expect, it } from 'vitest';
import { ceremonyAuthentication, type SignInCeremony } from '../authentication-evidence';

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
