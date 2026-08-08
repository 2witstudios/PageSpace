/**
 * Tests for the shared chain-alert Sentry payload builder.
 *
 * This is the single source of truth for the alert shape across two processes
 * (web + processor) that use different Sentry SDKs, so the regression guarded
 * here is drift between them — and, via the `process` tag, the ability to tell
 * which process reported a trust-plane failure.
 */

import { describe, it, expect } from 'vitest';
import { buildChainAlertPayload } from '../chain-alert-payload';
import type { ChainVerificationAlert } from '../security-audit-alerting';

const TRIGGERED_AT = new Date('2026-08-08T02:00:00.000Z');

function alert(overrides: Partial<ChainVerificationAlert> = {}): ChainVerificationAlert {
  return {
    source: 'periodic',
    triggeredAt: TRIGGERED_AT,
    result: {
      isValid: false,
      totalEntries: 100,
      entriesVerified: 42,
      validEntries: 41,
      invalidEntries: 1,
      breakPoint: {
        entryId: 'entry-42',
        timestamp: TRIGGERED_AT,
        position: 41,
        storedHash: 'stored',
        computedHash: 'computed',
        previousHashUsed: 'prev',
        description: 'Hash mismatch at entry-42',
      },
      firstEntryId: 'entry-1',
      lastEntryId: 'entry-42',
      verificationStartedAt: TRIGGERED_AT,
      verificationCompletedAt: TRIGGERED_AT,
      durationMs: 1234,
    },
    ...overrides,
  } as ChainVerificationAlert;
}

describe('buildChainAlertPayload', () => {
  it('builds a fatal payload carrying the break description', () => {
    const payload = buildChainAlertPayload(alert(), 'web');

    expect(payload.level).toBe('fatal');
    expect(payload.message).toBe('[SECURITY ALERT] periodic: Hash mismatch at entry-42');
    expect(payload.tags).toEqual({
      check: 'security_audit_chain',
      source: 'periodic',
      process: 'web',
    });
  });

  it('carries forensic counts in extra', () => {
    const payload = buildChainAlertPayload(alert(), 'processor');

    expect(payload.extra).toMatchObject({
      triggeredAt: '2026-08-08T02:00:00.000Z',
      totalEntries: 100,
      entriesVerified: 42,
      validEntries: 41,
      invalidEntries: 1,
      breakPointEntryId: 'entry-42',
      breakPointPosition: 41,
      lastEntryId: 'entry-42',
      durationMs: 1234,
    });
  });

  it('tags the reporting process so web and processor alerts are distinguishable', () => {
    expect(buildChainAlertPayload(alert(), 'web').tags.process).toBe('web');
    expect(buildChainAlertPayload(alert(), 'processor').tags.process).toBe('processor');
  });

  it('fingerprints by source, not by message, so a recurring alert stays one issue', () => {
    const a = buildChainAlertPayload(alert({ source: 'preflight' }), 'processor');
    const b = buildChainAlertPayload(alert({ source: 'preflight' }), 'processor');
    const c = buildChainAlertPayload(alert({ source: 'break_glass' }), 'web');

    expect(a.fingerprint).toEqual(['security-audit-chain', 'preflight']);
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(c.fingerprint).toEqual(['security-audit-chain', 'break_glass']);
  });

  it('groups the same source identically across processes — one fault, one issue', () => {
    // A chain break seen by both processes must not fan out into two issues.
    const fromWeb = buildChainAlertPayload(alert({ source: 'anchor_verify' }), 'web');
    const fromProcessor = buildChainAlertPayload(alert({ source: 'anchor_verify' }), 'processor');

    expect(fromWeb.fingerprint).toEqual(fromProcessor.fingerprint);
  });

  it('survives an alert with no breakPoint (anchor-publish / receipts-missing style)', () => {
    const noBreak = alert();
    (noBreak.result as { breakPoint: unknown }).breakPoint = null;

    const payload = buildChainAlertPayload(noBreak, 'processor');

    expect(payload.message).toContain('Chain verification reported invalid.');
    expect(payload.extra.breakPointEntryId).toBeNull();
    expect(payload.extra.breakPointPosition).toBeNull();
  });
});
