/**
 * Token issuance (ADR 0003 §3.1-3.2, task suty9f9jbha82c0831e9rjec).
 */
import { describe, it, expect } from 'vitest';
import {
  issuedTokenLifetimes,
  issueInitialTokenPair,
  issueRotatedTokenPair,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_FAMILY_TTL_SECONDS,
} from '../issue-tokens';
import { isValidTokenFormat, getTokenType } from '../../opaque-tokens';

describe('issuedTokenLifetimes', () => {
  it('access always expires 15 minutes from now', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const familyExpiresAt = new Date('2026-04-01T00:00:00Z');

    const { accessExpiresAt } = issuedTokenLifetimes(now, familyExpiresAt);

    expect(accessExpiresAt.getTime()).toBe(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  });

  it('refresh expires 30 days from now when that is still within the family cap', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const familyExpiresAt = new Date('2026-04-01T00:00:00Z');

    const { refreshExpiresAt } = issuedTokenLifetimes(now, familyExpiresAt);

    expect(refreshExpiresAt.getTime()).toBe(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  });

  it('clamps refresh expiry to the family cap when 30 days would overshoot it', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    // Family expires in 10 days — well short of the usual 30-day refresh TTL.
    const familyExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

    const { refreshExpiresAt } = issuedTokenLifetimes(now, familyExpiresAt);

    expect(refreshExpiresAt.getTime()).toBe(familyExpiresAt.getTime());
  });

  it('never returns a refreshExpiresAt past familyExpiresAt', () => {
    const now = new Date();
    const familyExpiresAt = new Date(now.getTime() + 1000);

    const { refreshExpiresAt } = issuedTokenLifetimes(now, familyExpiresAt);

    expect(refreshExpiresAt.getTime()).toBeLessThanOrEqual(familyExpiresAt.getTime());
  });
});

describe('issueInitialTokenPair', () => {
  it('mints ps_at_*/ps_rt_* tokens that pass the opaque-token format gate when offline_access is granted', () => {
    const pair = issueInitialTokenPair(new Date(), true);

    expect(isValidTokenFormat(pair.accessToken)).toBe(true);
    expect(isValidTokenFormat(pair.refreshToken!)).toBe(true);
    expect(getTokenType(pair.accessToken)).toBe('at');
    expect(getTokenType(pair.refreshToken!)).toBe('rt');
  });

  it('never returns the raw token as its own hash', () => {
    const pair = issueInitialTokenPair(new Date(), true);

    expect(pair.accessTokenHash).not.toBe(pair.accessToken);
    expect(pair.refreshTokenHash).not.toBe(pair.refreshToken);
    expect(pair.accessTokenHash).toHaveLength(64); // SHA3-256 hex
    expect(pair.refreshTokenHash).toHaveLength(64);
  });

  it('fixes familyExpiresAt at 90 days from now and clamps refresh accordingly', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const pair = issueInitialTokenPair(now, true);

    expect(pair.familyExpiresAt.getTime()).toBe(now.getTime() + REFRESH_TOKEN_FAMILY_TTL_SECONDS * 1000);
    expect(pair.refreshExpiresAt!.getTime()).toBe(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    expect(pair.accessExpiresAt.getTime()).toBe(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  });

  it('generates a fresh familyId and fresh tokens on every call (never reused)', () => {
    const now = new Date();
    const first = issueInitialTokenPair(now, true);
    const second = issueInitialTokenPair(now, true);

    expect(first.familyId).not.toBe(second.familyId);
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
  });

  describe('F1 — refresh token gated on offline_access', () => {
    it('mints no refresh token at all when offline_access was not granted', () => {
      const pair = issueInitialTokenPair(new Date(), false);

      expect(pair.refreshToken).toBeUndefined();
      expect(pair.refreshTokenHash).toBeUndefined();
      expect(pair.refreshTokenPrefix).toBeUndefined();
      expect(pair.refreshExpiresAt).toBeUndefined();
    });

    it('still mints a valid access token and family metadata when offline_access is absent', () => {
      const now = new Date('2026-01-01T00:00:00Z');
      const pair = issueInitialTokenPair(now, false);

      expect(isValidTokenFormat(pair.accessToken)).toBe(true);
      expect(pair.familyId).toBeTruthy();
      expect(pair.familyExpiresAt.getTime()).toBe(now.getTime() + REFRESH_TOKEN_FAMILY_TTL_SECONDS * 1000);
    });
  });
});

describe('issueRotatedTokenPair — F1 refresh token gated on offline_access', () => {
  it('mints a refresh token when offline_access is granted', () => {
    const now = new Date();
    const pair = issueRotatedTokenPair(now, 'family-1', new Date(now.getTime() + 1000), true);

    expect(isValidTokenFormat(pair.refreshToken!)).toBe(true);
    expect(pair.familyId).toBe('family-1');
  });

  it('mints no refresh token when offline_access is not granted', () => {
    const now = new Date();
    const pair = issueRotatedTokenPair(now, 'family-1', new Date(now.getTime() + 1000), false);

    expect(pair.refreshToken).toBeUndefined();
    expect(pair.refreshTokenHash).toBeUndefined();
    expect(pair.refreshTokenPrefix).toBeUndefined();
    expect(pair.refreshExpiresAt).toBeUndefined();
    expect(isValidTokenFormat(pair.accessToken)).toBe(true);
  });
});
