import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { update: vi.fn() } }));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: { id: 'id', userId: 'userId', actorEmail: 'actorEmail', actorDisplayName: 'actorDisplayName' },
}));
vi.mock('@pagespace/db/schema/security-audit', () => ({
  securityAuditLog: { id: 'id', userId: 'userId', ipAddress: 'ipAddress' },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn(() => 'eq') }));

import {
  pseudonymizeActivityLogsForUser,
  pseudonymizeSecurityAuditLogForUser,
} from '../pseudonymize-repository';
import { db } from '@pagespace/db/db';
import type { SecurityAuditDatabase } from '../../../audit/security-audit-repository';

function updateChain(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const update = vi.fn().mockReturnValue({ set: setFn });
  return { update, setFn };
}

beforeEach(() => vi.clearAllMocks());

describe('pseudonymizeActivityLogsForUser', () => {
  it('should set the activity-log actor patch on the main db and return the row count', async () => {
    const { update, setFn } = updateChain([{ id: '1' }, { id: '2' }]);
    vi.mocked(db.update).mockImplementation(update as never);
    const count = await pseudonymizeActivityLogsForUser('u1');
    expect(count).toBe(2);
    expect(setFn.mock.calls[0][0]).toEqual({
      actorEmail: 'erased@pseudonymized',
      actorDisplayName: null,
      resourceTitle: null,
    });
  });
});

describe('pseudonymizeSecurityAuditLogForUser', () => {
  it('should null the non-hashed PII columns (incl. ipBidx) ON THE INJECTED STORE and return the row count', async () => {
    const { update, setFn } = updateChain([{ id: '1' }]);
    const store = { update } as unknown as SecurityAuditDatabase;

    const count = await pseudonymizeSecurityAuditLogForUser('u1', { db: store });

    expect(count).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(setFn.mock.calls[0][0]).toEqual({
      ipAddress: null,
      ipBidx: null,
      userAgent: null,
      geoLocation: null,
      sessionId: null,
    });
    // The injected client is the ONLY thing written — never the ambient main db.
    expect(db.update).not.toHaveBeenCalled();
  });

  it('given two different stores (dual-location erasure), should write each store exactly once', async () => {
    const adminChain = updateChain([{ id: 'a1' }, { id: 'a2' }]);
    const mainChain = updateChain([{ id: 'm1' }]);
    const adminStore = { update: adminChain.update } as unknown as SecurityAuditDatabase;
    const mainStore = { update: mainChain.update } as unknown as SecurityAuditDatabase;

    const adminRows = await pseudonymizeSecurityAuditLogForUser('u1', { db: adminStore });
    const mainRows = await pseudonymizeSecurityAuditLogForUser('u1', { db: mainStore });

    expect(adminRows).toBe(2);
    expect(mainRows).toBe(1);
    expect(adminChain.update).toHaveBeenCalledTimes(1);
    expect(mainChain.update).toHaveBeenCalledTimes(1);
  });
});
