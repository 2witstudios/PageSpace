import { describe, it, expect } from 'vitest';
import {
  classifyDedupeOutcome,
  isUniqueViolation,
  PG_UNIQUE_VIOLATION,
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
