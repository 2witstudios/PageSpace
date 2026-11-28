import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  isOrgActive: vi.fn(),
  stageOrgAuditEvent: vi.fn(),
  publishOrgAuditEvents: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('../../organizations/status', () => ({ isOrgActive: mocks.isOrgActive }));
vi.mock('../../audit/org-audit', () => ({
  stageOrgAuditEvent: mocks.stageOrgAuditEvent,
  publishOrgAuditEvents: mocks.publishOrgAuditEvents,
  transactionWithOrgAudit: vi.fn(),
}));

import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { orgGuestHolds, type OrgGuestHold } from '@pagespace/db/schema/org-guest-holds';
import { claimGuestApprovalDecision } from '../guest-holds';
import { ORG_LAPSED_CODE, ORG_LAPSED_MESSAGE } from '../../organizations/status-core';

const pendingRequest: OrgGuestHold = {
  id: 'hold_pending', orgId: 'org_northwind', driveId: 'drive_product', userId: 'user_guest', email: null,
  state: 'pending_approval', origin: 'drive_link', request: { linkId: 'link_offer' }, parked: null,
  requestedBy: 'user_inviter', createdAt: new Date('2026-10-13T12:00:00Z'),
};
let pending: OrgGuestHold | null;
let role: OrgRole | null;
const lockOrder: string[] = [];
const audits: unknown[] = [];
const tx = {
  select: vi.fn(() => ({
    from: vi.fn((table: typeof organizations | typeof orgMembers) => ({
      where: vi.fn(() => ({
        for: vi.fn(async () => {
          if (table === organizations) { lockOrder.push('org'); return [{ id: pendingRequest.orgId }]; }
          lockOrder.push('actor');
          return role === null ? [] : [{ role }];
        }),
      })),
    })),
  })),
  delete: vi.fn((table: typeof orgGuestHolds) => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => {
        expect(table).toBe(orgGuestHolds);
        const row = pending;
        pending = null;
        return row ? [row] : [];
      }),
    })),
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  pending = structuredClone(pendingRequest);
  role = 'ADMIN';
  lockOrder.length = 0;
  audits.length = 0;
  mocks.transaction.mockImplementation(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx));
  mocks.isOrgActive.mockResolvedValue(true);
  mocks.stageOrgAuditEvent.mockImplementation(async (_executor, event: unknown) => { audits.push(event); return { id: 'staged_event' }; });
});

const decide = (decision: 'approve' | 'decline') => claimGuestApprovalDecision({
  orgId: pendingRequest.orgId, holdId: pendingRequest.id, actorId: 'user_approver', decision,
});

describe('guest decisions require the current approver membership', () => {
  for (const decision of ['approve', 'decline'] as const) {
    it.each(['MEMBER', null] as const)('a %s approver cannot '+decision+' a pending request or change its audit', async membership => {
      role = membership;
      expect(await decide(decision)).toEqual(membership === null
        ? { ok: false, reason: 'not_member', status: 404 }
        : { ok: false, reason: 'insufficient_role', status: 403 });
      expect(pending).toEqual(pendingRequest);
      expect(tx.delete).not.toHaveBeenCalled();
      expect(mocks.isOrgActive).not.toHaveBeenCalled();
      expect(audits).toEqual([]);
      expect(mocks.stageOrgAuditEvent).not.toHaveBeenCalled();
    });

    it.each(['OWNER', 'ADMIN'] as const)('a current %s can '+decision+' the request exactly once', async membership => {
      role = membership;
      expect(await decide(decision)).toMatchObject({ ok: true, claim: { holdId: pendingRequest.id, request: pendingRequest.request } });
      expect(pending).toBeNull();
      expect(await decide(decision)).toEqual({ ok: false, reason: 'not_found' });
      expect(audits).toHaveLength(decision === 'decline' ? 1 : 0);
      // Org before membership matches profile writes, removals and departures.
      expect(lockOrder).toEqual(['org', 'actor', 'org', 'actor']);
    });
  }

  it('an authorized approval of a lapsed org retains the request and writes no decision audit', async () => {
    mocks.isOrgActive.mockResolvedValue(false);
    expect(await decide('approve')).toEqual({ ok: false, reason: ORG_LAPSED_CODE, message: ORG_LAPSED_MESSAGE });
    expect(pending).toEqual(pendingRequest);
    expect(audits).toEqual([]);
  });
});
