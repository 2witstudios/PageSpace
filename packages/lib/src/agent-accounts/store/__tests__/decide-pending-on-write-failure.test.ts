/**
 * G2 ruling E1(a) (2026-09-21, point guard) — a pending write marker must not
 * become a permanent outage. When the adapter KNOWS its replacing write never
 * left the process (the Universal Auth login failed, the request could not be
 * built), nothing can have landed in Infisical, so the marker is cleared in the
 * same locked section that set it. Every other failure — a network error after
 * sending, a timeout, any HTTP answer — leaves the outcome unknown, so the
 * marker stays and the next locked call reconciles by observation (E1(b)).
 */
import { describe, expect, it } from 'vitest';
import { decidePendingOnWriteFailure } from '../decide-pending-on-write-failure';

describe('decidePendingOnWriteFailure (G2 ruling E1(a))', () => {
  it('given a write that failed before it was sent, should abort the pending marker', () => {
    const actual = decidePendingOnWriteFailure({ failure: 'not_sent' });
    const expected = { action: 'abort_pending' };
    expect(actual).toEqual(expected);
  });

  it('given a write whose outcome is unknown or that Infisical answered, should keep the marker for reconciliation', () => {
    const actual = [decidePendingOnWriteFailure({ failure: 'unavailable' }), decidePendingOnWriteFailure({ failure: 'not_found' })];
    const expected = [{ action: 'keep_pending' }, { action: 'keep_pending' }];
    expect(actual).toEqual(expected);
  });
});
