/**
 * Tests for the web process's Sentry delivery of security-audit alerts.
 *
 * The regression guarded here is not the payload shape — that lives in the
 * shared builder (@pagespace/lib/audit/chain-alert-payload) and is tested
 * there. It is that the alert leaves the process at all: `setChainAlertHandler`
 * had no production caller, so every notify* helper in
 * security-audit-alerting.ts early-returned and no trust-plane failure could
 * ever reach a human.
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

describe('buildSentryChainAlertHandler (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the alert to Sentry as an Error at fatal level', () => {
    buildSentryChainAlertHandler()(alert());

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureException.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[SECURITY ALERT]');
    expect((error as Error).message).toContain('Hash mismatch at entry-42');
    expect(context.level).toBe('fatal');
  });

  it('tags the alert as coming from the web process', () => {
    buildSentryChainAlertHandler()(alert());

    const { tags } = mockCaptureException.mock.calls[0][1];
    expect(tags.process).toBe('web');
    expect(tags.check).toBe('security_audit_chain');
    expect(tags.source).toBe('periodic');
  });

  it('does not pass `message` through as a context key', () => {
    buildSentryChainAlertHandler()(alert());

    // The message becomes the Error; leaving it in the capture context too
    // would be dead weight Sentry ignores.
    expect(mockCaptureException.mock.calls[0][1]).not.toHaveProperty('message');
  });

  it('forwards the shared builder’s fingerprint and extra', () => {
    buildSentryChainAlertHandler()(alert({ source: 'break_glass' }));

    const context = mockCaptureException.mock.calls[0][1];
    expect(context.fingerprint).toEqual(['security-audit-chain', 'break_glass']);
    expect(context.extra).toMatchObject({ totalEntries: 100, durationMs: 1234 });
  });

  it('survives an alert with no breakPoint', () => {
    const noBreak = alert();
    (noBreak.result as { breakPoint: unknown }).breakPoint = null;

    expect(() => buildSentryChainAlertHandler()(noBreak)).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
