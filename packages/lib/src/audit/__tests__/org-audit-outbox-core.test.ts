import { describe, expect, it } from 'vitest';
import { nextOrgAuditAttemptAt, ORG_AUDIT_RETRY_BASE_MS, ORG_AUDIT_RETRY_MAX_MS } from '../org-audit-outbox-core';

const now = new Date('2026-10-12T12:00:00.000Z');
const waitAfter = (attempts: number) => nextOrgAuditAttemptAt(attempts, now).getTime() - now.getTime();

describe('nextOrgAuditAttemptAt', () => {
  it('AUD-1 (partial) the first failed append is retried after the base delay', () => {
    expect(waitAfter(1)).toBe(ORG_AUDIT_RETRY_BASE_MS);
  });

  it('AUD-1 (partial) each later failure doubles the wait', () => {
    expect(waitAfter(2)).toBe(2 * ORG_AUDIT_RETRY_BASE_MS);
    expect(waitAfter(3)).toBe(4 * ORG_AUDIT_RETRY_BASE_MS);
  });

  it('AUD-1 (partial) the wait is capped, never infinite, however many times the append failed', () => {
    expect(waitAfter(50)).toBe(ORG_AUDIT_RETRY_MAX_MS);
    expect(waitAfter(10_000)).toBe(ORG_AUDIT_RETRY_MAX_MS);
  });

  it('a nonsensical attempt count is treated as the first failure', () => {
    expect(waitAfter(0)).toBe(ORG_AUDIT_RETRY_BASE_MS);
    expect(waitAfter(-3)).toBe(ORG_AUDIT_RETRY_BASE_MS);
  });
});
