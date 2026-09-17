import { describe, it, expect } from 'vitest';
import { shouldRetryRefusal, REFUSAL_RETRY_WINDOW_MS } from './refusal-retry';

const now = new Date('2026-09-17T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const scheduled = (occurrenceAt: Date | null, table = 'calendarTriggers') => ({ table, triggerAt: occurrenceAt });

describe('shouldRetryRefusal', () => {
  it('given a transient refusal for a fresh scheduled occurrence, should retry next tick', () => {
    expect(shouldRetryRefusal({ kind: 'transient', source: scheduled(ago(60_000)), now })).toBe(true);
  });

  it('given each scheduled source (calendar, task trigger, cron), should retry', () => {
    for (const table of ['calendarTriggers', 'taskTriggers', 'cron']) {
      expect(shouldRetryRefusal({ kind: 'transient', source: scheduled(ago(1), table), now })).toBe(true);
    }
  });

  it('given a transient refusal exactly at the 24h bound, should still retry', () => {
    expect(shouldRetryRefusal({ kind: 'transient', source: scheduled(ago(REFUSAL_RETRY_WINDOW_MS)), now })).toBe(true);
  });

  it('given a transient refusal for an occurrence older than 24h, should stop retrying (record it)', () => {
    expect(shouldRetryRefusal({ kind: 'transient', source: scheduled(ago(REFUSAL_RETRY_WINDOW_MS + 1)), now })).toBe(false);
  });

  it('given a scheduled source with no occurrence time, should not retry', () => {
    expect(shouldRetryRefusal({ kind: 'transient', source: scheduled(null), now })).toBe(false);
  });

  it('given a webhook or manual fire (nothing re-fires it), should never retry even with a fresh timestamp', () => {
    expect(shouldRetryRefusal({ kind: 'transient', source: { table: 'webhookTriggers', triggerAt: ago(1) }, now })).toBe(false);
    expect(shouldRetryRefusal({ kind: 'transient', source: { table: 'manual', triggerAt: null }, now })).toBe(false);
  });

  it('given a terminal refusal, should never retry', () => {
    expect(shouldRetryRefusal({ kind: 'terminal', source: scheduled(ago(60_000)), now })).toBe(false);
  });

  it('given the window, should be 24 hours', () => {
    expect(REFUSAL_RETRY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
