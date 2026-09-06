import { describe, expect, it } from 'vitest';
import { GRANT_MAX_CLOCK_SKEW_MS } from '@pagespace/lib/env-bridge/grant';
import { createDaemonNonceStore, grantPredatesDaemon, PREDATES_DAEMON_REASON } from '../nonce-store.js';

const STARTED_AT = Date.parse('2026-09-06T10:00:00.000Z');

describe('nonce-store (Codex C6 — replay across a daemon restart)', () => {
  it('given a grant issued more than the clock-skew allowance before the daemon started, should report it as predating the daemon', () => {
    expect(grantPredatesDaemon(STARTED_AT - GRANT_MAX_CLOCK_SKEW_MS - 1, STARTED_AT)).toBe(true);
  });

  it('given a grant issued exactly at the boundary, or after the daemon started, should NOT report it as predating the daemon', () => {
    expect(grantPredatesDaemon(STARTED_AT - GRANT_MAX_CLOCK_SKEW_MS, STARTED_AT)).toBe(false);
    expect(grantPredatesDaemon(STARTED_AT, STARTED_AT)).toBe(false);
    expect(grantPredatesDaemon(STARTED_AT + 5_000, STARTED_AT)).toBe(false);
  });

  it('should name the closed-union reason the daemon audits and answers with', () => {
    expect(PREDATES_DAEMON_REASON).toBe('predates_daemon');
  });

  it('given a nonce that was added, should report it as seen (single-threaded has+add is atomic by construction — no await between them)', () => {
    const store = createDaemonNonceStore();
    expect(store.has('n1')).toBe(false);
    store.add('n1', STARTED_AT + 60_000);
    expect(store.has('n1')).toBe(true);
  });

  it('given evictExpired(now) past a nonce expiry, should forget only the expired nonce', () => {
    const store = createDaemonNonceStore();
    store.add('old', STARTED_AT + 1_000);
    store.add('live', STARTED_AT + 60_000);
    store.evictExpired(STARTED_AT + 2_000);
    expect(store.has('old')).toBe(false);
    expect(store.has('live')).toBe(true);
  });
});
