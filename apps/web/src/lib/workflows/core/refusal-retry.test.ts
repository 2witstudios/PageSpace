import { describe, it, expect } from 'vitest';
import { shouldRetryRefusal, REFUSAL_RETRY_WINDOW_MS } from './refusal-retry';

const now = new Date('2026-09-17T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('shouldRetryRefusal', () => {
  it('given a transient refusal for a fresh occurrence, should retry next tick', () => {
    expect(shouldRetryRefusal({ kind: 'transient', occurrenceAt: ago(60_000), now })).toBe(true);
  });

  it('given a transient refusal exactly at the 24h bound, should still retry', () => {
    expect(shouldRetryRefusal({ kind: 'transient', occurrenceAt: ago(REFUSAL_RETRY_WINDOW_MS), now })).toBe(true);
  });

  it('given a transient refusal for an occurrence older than 24h, should stop retrying (record it)', () => {
    expect(shouldRetryRefusal({ kind: 'transient', occurrenceAt: ago(REFUSAL_RETRY_WINDOW_MS + 1), now })).toBe(false);
  });

  it('given a transient refusal with no occurrence time (manual or event-fired), should not retry — no tick will pick it up', () => {
    expect(shouldRetryRefusal({ kind: 'transient', occurrenceAt: null, now })).toBe(false);
  });

  it('given a terminal refusal, should never retry', () => {
    expect(shouldRetryRefusal({ kind: 'terminal', occurrenceAt: ago(60_000), now })).toBe(false);
  });

  it('given the window, should be 24 hours', () => {
    expect(REFUSAL_RETRY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
