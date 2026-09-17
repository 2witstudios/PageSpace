import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('../../audit/security-audit', () => ({ securityAudit: { logEvent: vi.fn() } }));

import {
  ORG_ADMIN_AUDIT_WINDOW_MS,
  createOrgAdminAccessAuditor,
  orgAdminAuditClaim,
  type OrgAdminAccess,
} from '../org-admin-access-audit';

const priyaOnFinance: OrgAdminAccess = { userId: 'user_priya', driveId: 'drive_finance', orgId: 'org_northwind', orgRole: 'ADMIN' };

/** A claim store with the (key, windowStart) unique key the real rate_limit_buckets row has. */
function memoryClaimStore() {
  const taken = new Set<string>();
  const claim = vi.fn(async ({ key, windowStart }: { key: string; windowStart: Date; expiresAt: Date }) => {
    const id = `${key}|${windowStart.toISOString()}`;
    if (taken.has(id)) return false;
    taken.add(id);
    return true;
  });
  const release = vi.fn(async ({ key, windowStart }: { key: string; windowStart: Date }) => {
    taken.delete(`${key}|${windowStart.toISOString()}`);
  });
  return { claim, release, taken };
}

describe('orgAdminAuditClaim', () => {
  it('ORG-4 (partial) keys one claim per user and drive per 15-minute UTC window', () => {
    const at = (iso: string) => orgAdminAuditClaim(priyaOnFinance, new Date(iso));

    expect(at('2026-09-17T09:00:00.000Z')).toEqual({
      key: 'audit:org-admin-private-drive:user_priya:drive_finance',
      windowStart: new Date('2026-09-17T09:00:00.000Z'),
      expiresAt: new Date('2026-09-17T09:15:00.000Z'),
    });
    expect(at('2026-09-17T09:14:59.999Z').windowStart).toEqual(new Date('2026-09-17T09:00:00.000Z'));
    expect(at('2026-09-17T09:15:00.000Z').windowStart).toEqual(new Date('2026-09-17T09:15:00.000Z'));
    expect(ORG_ADMIN_AUDIT_WINDOW_MS).toBe(15 * 60 * 1000);

    // The window is UTC: an offset in the input does not move it.
    expect(at('2026-09-17T04:07:00.000-05:00').windowStart).toEqual(new Date('2026-09-17T09:00:00.000Z'));

    expect(orgAdminAuditClaim({ ...priyaOnFinance, userId: 'user_jono' }, new Date('2026-09-17T09:00:00.000Z')).key)
      .toBe('audit:org-admin-private-drive:user_jono:drive_finance');
  });
});

describe('createOrgAdminAccessAuditor', () => {
  it('ORG-4 (partial) five accesses in one window write one audit event; an access in the next window writes a second', async () => {
    const store = memoryClaimStore();
    const write = vi.fn(async () => undefined);
    let now = new Date('2026-09-17T09:01:00.000Z');
    const auditor = createOrgAdminAccessAuditor({ claim: store.claim, release: store.release, write, now: () => now });

    for (let i = 0; i < 5; i += 1) await auditor.record(priyaOnFinance);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(priyaOnFinance);

    now = new Date('2026-09-17T09:15:00.000Z');
    await auditor.record(priyaOnFinance);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('ORG-4 (partial) a second process that loses the claim writes nothing, and a different user or drive is its own access', async () => {
    const store = memoryClaimStore();
    const now = () => new Date('2026-09-17T09:01:00.000Z');
    const writeA = vi.fn(async () => undefined);
    const writeB = vi.fn(async () => undefined);
    const processA = createOrgAdminAccessAuditor({ claim: store.claim, release: store.release, write: writeA, now });
    const processB = createOrgAdminAccessAuditor({ claim: store.claim, release: store.release, write: writeB, now });

    await Promise.all([processA.record(priyaOnFinance), processB.record(priyaOnFinance)]);
    expect(writeA.mock.calls.length + writeB.mock.calls.length).toBe(1);

    await processB.record({ ...priyaOnFinance, userId: 'user_jono', orgRole: 'OWNER' });
    await processB.record({ ...priyaOnFinance, driveId: 'drive_legal' });
    expect(writeA.mock.calls.length + writeB.mock.calls.length).toBe(3);
  });

  it('ORG-4 (partial) the in-process memo skips the claim store for a repeat inside the window', async () => {
    const store = memoryClaimStore();
    const auditor = createOrgAdminAccessAuditor({ claim: store.claim, release: store.release, write: vi.fn(async () => undefined), now: () => new Date('2026-09-17T09:01:00.000Z') });

    for (let i = 0; i < 5; i += 1) await auditor.record(priyaOnFinance);
    expect(store.claim).toHaveBeenCalledTimes(1);
  });

  it('ORG-4 (partial) a failed audit write releases the claim, so the next access in the same window writes the record', async () => {
    const store = memoryClaimStore();
    const write = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('audit store down'));
    const auditor = createOrgAdminAccessAuditor({ claim: store.claim, release: store.release, write, now: () => new Date('2026-09-17T09:01:00.000Z') });

    await expect(auditor.record(priyaOnFinance)).resolves.toBeUndefined();
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(store.taken.size).toBe(0);

    await auditor.record(priyaOnFinance);
    await auditor.record(priyaOnFinance);
    expect(write).toHaveBeenCalledTimes(2);
    expect(store.taken.size).toBe(1);
  });

  it('ORG-4 (partial) an unreachable claim store fails open: every access is audited rather than none', async () => {
    const claim = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const write = vi.fn(async () => undefined);
    const auditor = createOrgAdminAccessAuditor({ claim, release: vi.fn(async () => undefined), write, now: () => new Date('2026-09-17T09:01:00.000Z') });

    await auditor.record(priyaOnFinance);
    await auditor.record(priyaOnFinance);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
