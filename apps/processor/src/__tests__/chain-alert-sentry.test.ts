/**
 * Processor-side Sentry delivery for security-audit trust-plane alerts.
 *
 * `alertHandler` in security-audit-alerting.ts is a module-local variable, so a
 * registration in the web app's Next.js instrumentation does NOT cover this
 * process — yet notifyChainPreflightFailure (siem-delivery-worker),
 * notifyChainAppendVerificationFailure and notifyAnchorPublishFailure
 * (audit-chainer-worker) all fire from here. Without a registration in this
 * composition root every one of them hits `if (!alertHandler) return` and a
 * detected chain tamper reaches nobody.
 *
 * server.ts executes start() at import time so it cannot be imported in a unit
 * test; the wiring assertions are source pins, matching
 * server-clickhouse-wiring.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

import { buildSentryChainAlertHandler } from '../observability/chain-alert-sentry';
import type { ChainVerificationAlert } from '@pagespace/lib/audit/security-audit-alerting';

const TRIGGERED_AT = new Date('2026-08-08T02:00:00.000Z');

function alert(overrides: Partial<ChainVerificationAlert> = {}): ChainVerificationAlert {
  return {
    source: 'preflight',
    triggeredAt: TRIGGERED_AT,
    result: {
      isValid: false,
      totalEntries: 50,
      entriesVerified: 10,
      validEntries: 9,
      invalidEntries: 1,
      breakPoint: {
        entryId: 'entry-10',
        timestamp: TRIGGERED_AT,
        position: 9,
        storedHash: 'stored',
        computedHash: 'computed',
        previousHashUsed: 'prev',
        description: 'SIEM preflight chain break at security_audit_log[9]',
      },
      firstEntryId: null,
      lastEntryId: 'entry-10',
      verificationStartedAt: TRIGGERED_AT,
      verificationCompletedAt: TRIGGERED_AT,
      durationMs: 5,
    },
    ...overrides,
  } as ChainVerificationAlert;
}

describe('buildSentryChainAlertHandler (processor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures the alert via @sentry/node at fatal level', () => {
    buildSentryChainAlertHandler()(alert());

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureException.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('SIEM preflight chain break');
    expect(context.level).toBe('fatal');
  });

  it('tags the alert as coming from the processor process', () => {
    buildSentryChainAlertHandler()(alert());

    expect(mockCaptureException.mock.calls[0][1].tags.process).toBe('processor');
  });

  it('groups by source, matching the web adapter so one fault is one issue', () => {
    buildSentryChainAlertHandler()(alert({ source: 'anchor_publish' }));

    expect(mockCaptureException.mock.calls[0][1].fingerprint).toEqual([
      'security-audit-chain',
      'anchor_publish',
    ]);
  });
});

describe('processor server — chain alert composition-root wiring', () => {
  const source = readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

  it('registers a chain alert handler at startup', () => {
    expect(source).toContain('setChainAlertHandler(buildSentryChainAlertHandler())');
  });

  it('registers it before the server starts listening', () => {
    const registerIndex = source.indexOf('setChainAlertHandler(');
    const listenIndex = source.indexOf('app.listen');
    expect(registerIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeLessThan(listenIndex);
  });
});
