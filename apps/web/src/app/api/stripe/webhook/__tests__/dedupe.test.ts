import { describe, it, expect } from 'vitest';
import {
  classifyDedupeOutcome,
  isUniqueViolation,
  PG_UNIQUE_VIOLATION,
  DEFAULT_LEASE_MS,
} from '../dedupe';

describe('classifyDedupeOutcome', () => {
  it('processes a fresh insert (won the idempotency race)', () => {
    expect(classifyDedupeOutcome({ inserted: true })).toBe('process');
  });

  it('acks a duplicate whose prior attempt finished (processedAt set)', () => {
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: new Date('2026-06-09T00:00:00.000Z'),
      })
    ).toBe('duplicate-ack');
  });

  it('retries a duplicate whose prior attempt has NOT finished (processedAt null)', () => {
    expect(
      classifyDedupeOutcome({ inserted: false, existingProcessedAt: null })
    ).toBe('retry');
  });

  it('retries a duplicate with no existing row info (undefined processedAt)', () => {
    expect(classifyDedupeOutcome({ inserted: false })).toBe('retry');
  });

  it('retries an unfinished marker still within its lease (live in-flight attempt)', () => {
    const now = new Date('2026-06-09T00:05:00.000Z');
    const claimedAt = new Date('2026-06-09T00:04:00.000Z'); // 1 min ago, < 10 min lease
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: null,
        existingClaimedAt: claimedAt,
        now,
      })
    ).toBe('retry');
  });

  it('reclaims an unfinished marker older than the lease (abandoned by a dead worker)', () => {
    const now = new Date('2026-06-09T00:30:00.000Z');
    const claimedAt = new Date('2026-06-09T00:10:00.000Z'); // 20 min ago, >= 10 min lease
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: null,
        existingClaimedAt: claimedAt,
        now,
      })
    ).toBe('reclaim');
  });

  it('reclaims exactly at the lease boundary (age === leaseMs)', () => {
    const claimedAt = new Date('2026-06-09T00:00:00.000Z');
    const now = new Date(claimedAt.getTime() + DEFAULT_LEASE_MS);
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: null,
        existingClaimedAt: claimedAt,
        now,
      })
    ).toBe('reclaim');
  });

  it('respects a custom lease window', () => {
    const claimedAt = new Date('2026-06-09T00:00:00.000Z');
    const now = new Date(claimedAt.getTime() + 30_000); // 30s old
    // Within a 60s lease → retry; past a 10s lease → reclaim.
    expect(
      classifyDedupeOutcome({ inserted: false, existingProcessedAt: null, existingClaimedAt: claimedAt, now, leaseMs: 60_000 })
    ).toBe('retry');
    expect(
      classifyDedupeOutcome({ inserted: false, existingProcessedAt: null, existingClaimedAt: claimedAt, now, leaseMs: 10_000 })
    ).toBe('reclaim');
  });

  it('falls back to retry when the lease cannot be assessed (missing claimedAt or now)', () => {
    const t = new Date('2026-06-09T00:00:00.000Z');
    expect(classifyDedupeOutcome({ inserted: false, existingProcessedAt: null, now: t })).toBe('retry');
    expect(classifyDedupeOutcome({ inserted: false, existingProcessedAt: null, existingClaimedAt: t })).toBe('retry');
  });

  it('retries on an unknown DB error (never silently ack lost funding)', () => {
    expect(
      classifyDedupeOutcome({ inserted: false, error: new Error('pool timeout') })
    ).toBe('retry');
  });

  it('retries on an unknown DB error even if an insert somehow reported success', () => {
    // Defensive: a fault must dominate — we never claim "process" while an error is present.
    expect(
      classifyDedupeOutcome({ inserted: true, error: new Error('connection reset') })
    ).toBe('retry');
  });

  it('treats a 23505 unique-violation error as a duplicate, not a fault', () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), {
      code: PG_UNIQUE_VIOLATION,
    });
    // Finished prior attempt → ack.
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: new Date('2026-06-09T00:00:00.000Z'),
        error: uniqueErr,
      })
    ).toBe('duplicate-ack');
    // Unfinished prior attempt → retry (not a fault-driven retry, a race-driven one).
    expect(
      classifyDedupeOutcome({
        inserted: false,
        existingProcessedAt: null,
        error: uniqueErr,
      })
    ).toBe('retry');
  });
});

describe('isUniqueViolation', () => {
  it('detects a Postgres 23505 error by code', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('rejects other error codes', () => {
    expect(isUniqueViolation(Object.assign(new Error('boom'), { code: '08006' }))).toBe(false);
  });

  it('rejects errors without a code', () => {
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
