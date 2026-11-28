import { describe, expect, it } from 'vitest';
import { isOrgAuditDeadLetter, nextOrgAuditAttemptAt, orgAuditChainDetails, ORG_AUDIT_DEAD_LETTER_ATTEMPTS, ORG_AUDIT_RETRY_BASE_MS, ORG_AUDIT_RETRY_MAX_MS } from '../org-audit-outbox-core';

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

describe('isOrgAuditDeadLetter', () => {
  it('AUD-1 (partial) an event the chain keeps refusing is dead-lettered after a bounded number of attempts, never retried forever', () => {
    expect(isOrgAuditDeadLetter(ORG_AUDIT_DEAD_LETTER_ATTEMPTS - 1)).toBe(false);
    expect(isOrgAuditDeadLetter(ORG_AUDIT_DEAD_LETTER_ATTEMPTS)).toBe(true);
    expect(isOrgAuditDeadLetter(ORG_AUDIT_DEAD_LETTER_ATTEMPTS + 5)).toBe(true);
  });
});

describe('orgAuditChainDetails', () => {
  const row = { id: 'obx_1', orgId: 'org_1', driveId: 'drive_1', createdAt: new Date('2026-10-12T09:00:00.000Z'), details: { n: 1, orgId: 'evil', driveId: 'evil', occurredAt: 'evil', outboxId: 'evil' } };

  it('AUD-1 (partial) the chain row carries when the change happened and the outbox id, so a delayed or re-delivered event is dated and deduplicated by its change', () => {
    expect(orgAuditChainDetails(row)).toEqual({ n: 1, orgId: 'org_1', driveId: 'drive_1', occurredAt: '2026-10-12T09:00:00.000Z', outboxId: 'obx_1' });
  });

  it('AUD-2 (partial) a drive-less event carries no drive dimension', () => {
    expect(orgAuditChainDetails({ ...row, driveId: null, details: {} })).toEqual({ orgId: 'org_1', occurredAt: '2026-10-12T09:00:00.000Z', outboxId: 'obx_1' });
  });
});
