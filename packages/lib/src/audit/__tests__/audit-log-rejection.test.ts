/**
 * The audit write is fire-and-forget: a rejection — even one carrying a plain string — is
 * wrapped into an Error and logged, never thrown into the caller's transaction.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../security-audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security-audit')>();
  return {
    ...actual,
    securityAudit: {
      ...actual.securityAudit,
      logEvent: vi.fn().mockRejectedValue('plain-string-reason'),
    },
  };
});

import { audit } from '../audit-log';
import { loggers } from '../../logging/logger-config';

describe('a rejected audit write', () => {
  it('wraps a non-Error rejection and logs it; the caller never finds out', async () => {
    const warn = vi.spyOn(loggers.security, 'warn');
    expect(audit({
      eventType: 'data.read',
      category: 'security',
      riskScore: 0,
    } as never)).toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[Audit] audit write failed',
      expect.objectContaining({
        error: expect.any(Error),
        eventType: 'data.read',
      }),
    ));
    const logged = warn.mock.calls.find(([message]) => message === '[Audit] audit write failed');
    expect((logged?.[1] as { error: Error }).error.message).toBe('plain-string-reason');
    warn.mockRestore();
  });
});
