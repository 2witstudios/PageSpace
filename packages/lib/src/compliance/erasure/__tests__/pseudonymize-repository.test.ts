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

function mockUpdateReturning(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as never);
  return { setFn };
}

beforeEach(() => vi.clearAllMocks());

describe('pseudonymizeActivityLogsForUser', () => {
  it('should set the activity-log actor patch and return the row count', async () => {
    const { setFn } = mockUpdateReturning([{ id: '1' }, { id: '2' }]);
    const count = await pseudonymizeActivityLogsForUser('u1');
    expect(count).toBe(2);
    expect(setFn.mock.calls[0][0]).toEqual({
      actorEmail: 'erased@pseudonymized',
      actorDisplayName: null,
    });
  });
});

describe('pseudonymizeSecurityAuditLogForUser', () => {
  it('should null the non-hashed PII columns and return the row count', async () => {
    const { setFn } = mockUpdateReturning([{ id: '1' }]);
    const count = await pseudonymizeSecurityAuditLogForUser('u1');
    expect(count).toBe(1);
    expect(setFn.mock.calls[0][0]).toEqual({
      ipAddress: null,
      userAgent: null,
      geoLocation: null,
      sessionId: null,
    });
  });
});
