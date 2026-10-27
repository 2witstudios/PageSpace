/**
 * Pure refresh-token rotation decision (ADR 0003 §3.3-3.4, §6-§7; Phase 1
 * task 8, RED sub-task qa0870vw0zz27x14n1vluv6z). No DB, no clock, no
 * randomness — every case below hand-builds a `RefreshTokenRecord` and an
 * injected `userTokenVersion`/`now`/`graceCacheHit` and asserts the resulting
 * decision.
 */
import { describe, it, expect } from 'vitest';
import { decideRefreshRotation, REFRESH_GRACE_WINDOW_MS, type RefreshTokenRecord } from '../refresh-rotation';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function liveRecord(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    expiresAt: new Date(Date.now() + 30 * DAY),
    familyExpiresAt: new Date(Date.now() + 90 * DAY),
    revokedAt: null,
    revokedReason: null,
    tokenVersion: 0,
    ...overrides,
  };
}

describe('decideRefreshRotation — happy path', () => {
  it('rotates a live, unexpired, unrevoked token whose tokenVersion matches the user', () => {
    const now = new Date();
    const decision = decideRefreshRotation(liveRecord(), 0, now, false);
    expect(decision).toEqual({ ok: true, action: 'rotate' });
  });
});

describe('decideRefreshRotation — expiry', () => {
  it('exactly-at per-token expiry fails closed as expired', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    const record = liveRecord({ expiresAt: now, familyExpiresAt: new Date(now.getTime() + DAY) });
    expect(decideRefreshRotation(record, 0, now, false)).toEqual({ ok: false, reason: 'expired', revokeFamily: false });
  });

  it('past per-token expiry is expired', () => {
    const now = new Date();
    const record = liveRecord({ expiresAt: new Date(now.getTime() - 1000) });
    expect(decideRefreshRotation(record, 0, now, false)).toEqual({ ok: false, reason: 'expired', revokeFamily: false });
  });

  it('family_expired takes precedence over the per-token TTL (absolute cap wins)', () => {
    const now = new Date();
    const record = liveRecord({
      familyExpiresAt: new Date(now.getTime() - 1000),
      expiresAt: new Date(now.getTime() + DAY), // per-token TTL not yet reached
    });
    expect(decideRefreshRotation(record, 0, now, false)).toEqual({
      ok: false,
      reason: 'family_expired',
      revokeFamily: false,
    });
  });

  it('exactly-at family expiry fails closed as family_expired', () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    const record = liveRecord({ familyExpiresAt: now });
    expect(decideRefreshRotation(record, 0, now, false)).toEqual({
      ok: false,
      reason: 'family_expired',
      revokeFamily: false,
    });
  });
});

describe('decideRefreshRotation — reuse detection, grace window, grace-cache miss (ADR 0003 §7.3)', () => {
  it('29s after revocation, revokedReason "rotated", graceCacheHit true → grace-replay', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 29_000);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, true)).toEqual({ ok: true, action: 'grace-replay' });
  });

  it('same inputs with graceCacheHit false → grace_cache_miss (NOT theft — family untouched)', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 29_000);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, false)).toEqual({
      ok: false,
      reason: 'grace_cache_miss',
      revokeFamily: false,
    });
  });

  it('a TERMINAL rotation (F1: offline_access dropped, no next refresh token minted) still grants grace — revokedReason is "rotated" regardless of whether a replacement was minted', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 5_000);
    // A terminal rotation revokes the presented token for the SAME reason
    // ('rotated') as any other rotation — it just doesn't mint a next
    // refresh token. The grace-window branch must not require one.
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, false)).toEqual({
      ok: false,
      reason: 'grace_cache_miss',
      revokeFamily: false,
    });
  });

  it('31s after revocation (outside the 30s window), graceCacheHit true → reuse_detected regardless', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 31_000);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, true)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });

  it('31s after revocation, graceCacheHit false → reuse_detected (same as true — cache state never overrides an out-of-window reuse)', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 31_000);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, false)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });

  it('exactly at the 30s boundary is treated as OUTSIDE the window (fail closed) → reuse_detected', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + REFRESH_GRACE_WINDOW_MS);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated' });

    expect(decideRefreshRotation(record, 0, now, true)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });

  it('revoked for reuse_detected (e.g. already family-revoked) is reuse_detected even within 30s — no legitimate rotation to explain the duplicate', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 1_000);
    const record = liveRecord({ revokedAt, revokedReason: 'reuse_detected' });

    expect(decideRefreshRotation(record, 0, now, true)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });

  it('revoked for user_suspended is reuse_detected even within 30s — suspension is not a benign rotation', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 1_000);
    const record = liveRecord({ revokedAt, revokedReason: 'user_suspended' });

    expect(decideRefreshRotation(record, 0, now, true)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });

  it('the theft scenario end-to-end: legitimate client rotates, then an attacker replays the stolen pre-rotation token outside the grace window — reuse_detected, family dies', () => {
    // Legitimate client's rotation revoked the old token at t0.
    const t0 = new Date();
    const legitimateRotation = decideRefreshRotation(liveRecord({ revokedAt: null }), 0, t0, false);
    expect(legitimateRotation).toEqual({ ok: true, action: 'rotate' });

    // Attacker replays the now-revoked, rotated-away token well after the grace window.
    const attackerNow = new Date(t0.getTime() + 60_000);
    const stolenRecord = liveRecord({ revokedAt: t0, revokedReason: 'rotated' });
    const attackerDecision = decideRefreshRotation(stolenRecord, 0, attackerNow, false);

    expect(attackerDecision).toEqual({ ok: false, reason: 'reuse_detected', revokeFamily: true });
  });
});

describe('decideRefreshRotation — tokenVersion mismatch (global logout, ADR 0003 §6-§7)', () => {
  it('refuses a live, unexpired, unrevoked token whose snapshot tokenVersion no longer matches the user — WITHOUT revoking the family (logout ≠ theft)', () => {
    const now = new Date();
    const record = liveRecord({ tokenVersion: 1 });

    expect(decideRefreshRotation(record, 2, now, false)).toEqual({
      ok: false,
      reason: 'version_mismatch',
      revokeFamily: false,
    });
  });

  it('a matching tokenVersion still rotates normally', () => {
    const now = new Date();
    const record = liveRecord({ tokenVersion: 3 });

    expect(decideRefreshRotation(record, 3, now, false)).toEqual({ ok: true, action: 'rotate' });
  });

  it('reuse detection still takes precedence over a version mismatch (revocation checked first)', () => {
    const revokedAt = new Date();
    const now = new Date(revokedAt.getTime() + 60_000);
    const record = liveRecord({ revokedAt, revokedReason: 'rotated', tokenVersion: 1 });

    expect(decideRefreshRotation(record, 2, now, false)).toEqual({
      ok: false,
      reason: 'reuse_detected',
      revokeFamily: true,
    });
  });
});
