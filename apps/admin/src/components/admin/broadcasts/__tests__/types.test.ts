import { describe, it, expect } from 'vitest';
import { isPollingSettled, isTerminalStatus } from '../types';

describe('isTerminalStatus', () => {
  it('treats completed and cancelled as terminal — the API always refuses further intervention here', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('treats every in-flight status as non-terminal', () => {
    expect(isTerminalStatus('draft')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('paused')).toBe(false);
  });

  it('treats failed as NON-terminal — the API always accepts a cancel on a failed row (it may be mid pg-boss-retry, or a dead row an admin wants to close out)', () => {
    expect(isTerminalStatus('failed')).toBe(false);
  });
});

describe('isPollingSettled', () => {
  it('is settled for completed and cancelled regardless of blockedReason', () => {
    expect(isPollingSettled('completed', null)).toBe(true);
    expect(isPollingSettled('cancelled', null)).toBe(true);
  });

  it('is NOT settled for every in-flight status', () => {
    expect(isPollingSettled('draft', null)).toBe(false);
    expect(isPollingSettled('pending', null)).toBe(false);
    expect(isPollingSettled('queued', null)).toBe(false);
    expect(isPollingSettled('in_progress', null)).toBe(false);
    expect(isPollingSettled('paused', null)).toBe(false);
  });

  it('is settled for a failed row with a blockedReason — refuse() RETURNS without rethrowing, so pg-boss will never retry it', () => {
    expect(isPollingSettled('failed', 'on-prem: transactional email is a no-op')).toBe(true);
  });

  it('is NOT settled for a failed row with no blockedReason — a retryable per-recipient/ledger failure rethrows, so pg-boss WILL retry it', () => {
    expect(isPollingSettled('failed', null)).toBe(false);
  });
});
