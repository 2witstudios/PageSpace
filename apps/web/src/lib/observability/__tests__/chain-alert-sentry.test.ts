/**
 * Tests for the Sentry delivery of security-audit trust-plane alerts.
 *
 * The regression guarded here is not a wrong Sentry payload — it is the alert
 * being dropped entirely. `setChainAlertHandler` had no production caller, so
 * every notify* helper in security-audit-alerting.ts early-returned and no
 * trust-plane failure could ever reach a human.
 */

// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nextjs', () => ({
  captureException: mockCaptureException,
}));

import { buildSentryChainAlertHandler } from '../chain-alert-sentry';
import type { ChainVerificationAlert } from '@pagespace/lib/audit/security-audit-alerting';

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

describe('buildSentryChainAlertHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the alert to Sentry at fatal level', () => {
    buildSentryChainAlertHandler()(alert());

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureException.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[SECURITY ALERT]');
    expect((error as Error).message).toContain('Hash mismatch at entry-42');
    expect(context.level).toBe('fatal');
    expect(context.tags.check).toBe('security_audit_chain');
    expect(context.tags.source).toBe('periodic');
  });

  it('carries forensic counts in extra without inventing detection logic', () => {
    buildSentryChainAlertHandler()(alert());

    const { extra } = mockCaptureException.mock.calls[0][1];
    expect(extra).toMatchObject({
      totalEntries: 100,
      entriesVerified: 42,
      validEntries: 41,
      invalidEntries: 1,
      breakPointEntryId: 'entry-42',
      breakPointPosition: 41,
      durationMs: 1234,
    });
  });

  it('fingerprints by source so a recurring alert escalates one issue', () => {
    const handler = buildSentryChainAlertHandler();

    handler(alert({ source: 'preflight' }));
    handler(alert({ source: 'preflight' }));
    handler(alert({ source: 'break_glass' }));

    const fingerprints = mockCaptureException.mock.calls.map((c) => c[1].fingerprint);
    expect(fingerprints[0]).toEqual(['security-audit-chain', 'preflight']);
    expect(fingerprints[1]).toEqual(fingerprints[0]);
    expect(fingerprints[2]).toEqual(['security-audit-chain', 'break_glass']);
  });

  it('survives an alert with no breakPoint (anchor-publish style)', () => {
    const withoutBreakPoint = alert();
    // notifyAnchorPublishFailure builds a synthetic result; guard the null path.
    (withoutBreakPoint.result as { breakPoint: unknown }).breakPoint = null;

    expect(() => buildSentryChainAlertHandler()(withoutBreakPoint)).not.toThrow();
    const [error, context] = mockCaptureException.mock.calls[0];
    expect((error as Error).message).toContain('Chain verification reported invalid.');
    expect(context.extra.breakPointEntryId).toBeNull();
    expect(context.extra.breakPointPosition).toBeNull();
  });
});
