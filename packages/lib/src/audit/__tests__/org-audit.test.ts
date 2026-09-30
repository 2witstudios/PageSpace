import { describe, it, expect, vi, beforeEach } from 'vitest';

const logEvent = vi.hoisted(() => vi.fn());
vi.mock('../security-audit', () => ({ securityAudit: { logEvent } }));
vi.mock('../../logging/logger-config', () => ({ loggers: { security: { info: vi.fn(), error: vi.fn() } } }));

import { recordOrgAuditEvent } from '../org-audit';

beforeEach(() => {
  logEvent.mockReset();
  logEvent.mockResolvedValue(undefined);
});

describe('recordOrgAuditEvent', () => {
  it('AUD-2 (partial) writes through the existing audit chain with the org as the dimension every query filters on', async () => {
    await recordOrgAuditEvent({ orgId: 'org_1', eventType: 'org.policy.changed', actorId: 'u1', resourceType: 'organization', resourceId: 'org_1', details: { changes: [] } });
    expect(logEvent).toHaveBeenCalledWith({
      eventType: 'org.policy.changed',
      userId: 'u1',
      resourceType: 'organization',
      resourceId: 'org_1',
      details: { changes: [], orgId: 'org_1' },
    });
  });

  it('AUD-2 (partial) a drive event carries the drive dimension too, and a caller\'s details can never overwrite either dimension', async () => {
    await recordOrgAuditEvent({ orgId: 'org_1', driveId: 'd1', eventType: 'org.policy.suspended', resourceType: 'drive', resourceId: 'd1', details: { orgId: 'org_evil', driveId: 'd_evil' } });
    expect(logEvent.mock.calls[0][0].details).toEqual({ orgId: 'org_1', driveId: 'd1' });
  });

  it('AUD-2 (partial) a rejected append is seen by the caller, never swallowed', async () => {
    logEvent.mockRejectedValue(new Error('chain down'));
    await expect(recordOrgAuditEvent({ orgId: 'o', eventType: 'org.policy.restored', resourceType: 'organization', resourceId: 'o' })).rejects.toThrow('chain down');
  });
});
