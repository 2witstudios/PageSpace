import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), select: vi.fn(), insert: vi.fn(), update: vi.fn(),
  getDrivePolicies: vi.fn(), admission: vi.fn(), lapse: vi.fn(),
  stage: vi.fn(), publish: vi.fn(),
}));
vi.mock('@pagespace/db/db', () => ({ db: { transaction: mocks.transaction, select: mocks.select, update: mocks.update } }));
vi.mock('../../organizations/policy-reader', () => ({ getDrivePolicies: mocks.getDrivePolicies, getOrgPolicies: vi.fn() }));
vi.mock('../guest-admission', () => ({ decideOrgDriveAdmission: mocks.admission }));
vi.mock('../org-lapse-guard', () => ({ checkDriveMayLoosen: mocks.lapse }));
vi.mock('../../audit/org-audit', () => ({
  stageOrgAuditEvents: mocks.stage, publishOrgAuditEvents: mocks.publish,
  stageOrgAuditEvent: vi.fn(), transactionWithOrgAudit: vi.fn(),
}));

import { drives, pages } from '@pagespace/db/schema/core';
import { organizations } from '@pagespace/db/schema/organizations';
import { users } from '@pagespace/db/schema/auth';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { DEFAULT_ORG_POLICIES } from '../../organizations/policies-core';
import { completeApprovedPageGrant } from '../page-grant-admission';
import { completeApprovedLinkAdmission } from '../share-link-service';
import type { ClaimedGuestApproval } from '../guest-holds';
import type { OrgAuditEvent } from '../../audit/org-audit';

const ORG = 'org_original';
const DRIVE = 'drive_offer';
const PAGE = 'page_offer';
let originalExists: boolean;
let currentOrg: string | null;
const lockOrder: string[] = [];
const writes: unknown[] = [];
const staged: OrgAuditEvent[] = [];

const offer = { id: 'link_offer', driveId: DRIVE, pageId: PAGE, role: 'MEMBER', customRoleId: null,
  isActive: true, expiresAt: null, suspendedByPolicy: null, permissions: ['VIEW'], createdBy: 'user_sharer', driveName: 'Product' };

function select(table: unknown) {
  const rows = () => {
    if (table === organizations) return originalExists ? [{ id: ORG }] : [];
    if (table === drives) return [{ id: DRIVE, orgId: currentOrg }];
    if (table === pages) return [{ id: PAGE }];
    if (table === users) return [{ id: 'user_sharer' }];
    if (table === driveShareLinks || table === pageShareLinks) return [offer];
    return [];
  };
  const chain = {
    where: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), leftJoin: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => rows()),
    for: vi.fn(async () => { lockOrder.push(table === organizations ? 'org' : 'drive'); return rows(); }),
    then: (resolve: (result: unknown[]) => void) => Promise.resolve(rows()).then(resolve),
  };
  return chain;
}
const tx = {
  select: mocks.select,
  insert: mocks.insert,
};

beforeEach(() => {
  vi.resetAllMocks();
  originalExists = true;
  currentOrg = ORG;
  lockOrder.length = 0;
  writes.length = 0;
  staged.length = 0;
  mocks.select.mockImplementation(() => ({ from: vi.fn(select) }));
  mocks.insert.mockImplementation(() => ({ values: vi.fn((value: unknown) => {
    writes.push(value);
    const chain = { onConflictDoNothing: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockReturnThis(), returning: vi.fn(async () => [{ id: 'member_new' }]) };
    return chain;
  }) }));
  mocks.update.mockImplementation(() => ({ set: vi.fn((value: unknown) => { writes.push(value); return { where: vi.fn(async () => []) }; }) }));
  mocks.transaction.mockImplementation(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx));
  mocks.getDrivePolicies.mockImplementation(async () => currentOrg ? { orgId: currentOrg, policies: { ...DEFAULT_ORG_POLICIES, guests: 'approve' } } : null);
  mocks.admission.mockImplementation(async () => ({ decision: 'allow', orgId: currentOrg }));
  mocks.lapse.mockResolvedValue(null);
  mocks.stage.mockImplementation(async (_executor, events: OrgAuditEvent[]) => { staged.push(...events); return []; });
});

const claim = (origin: 'page_grant' | 'drive_link' | 'page_link'): ClaimedGuestApproval => ({
  holdId: 'hold_committed', orgId: ORG, driveId: DRIVE, userId: 'user_guest', email: null, origin,
  createdAt: new Date(), requestedBy: 'user_sharer',
  request: origin === 'page_grant' ? { permissions: [{ pageId: PAGE, canView: true, canEdit: false, canShare: false }], invitedBy: 'user_sharer' } : { linkId: offer.id },
});
const approval: OrgAuditEvent = { orgId: ORG, driveId: DRIVE, eventType: 'org.guest.approved', actorId: 'user_prior_admin', resourceType: 'drive', resourceId: DRIVE, details: { holdId: 'hold_committed' } };
const complete = (origin: 'page_grant' | 'drive_link' | 'page_link') => origin === 'page_grant'
  ? completeApprovedPageGrant(claim(origin), approval)
  : completeApprovedLinkAdmission(claim(origin), approval);

describe('committed guest approvals stay bound to the original org and current admission policy', () => {
  for (const origin of ['page_grant', 'drive_link', 'page_link'] as const) {
    it.each(['personal_drive', 'different_org', 'missing_original'] as const)(origin+' refuses %s without granting or auditing access', async boundary => {
      currentOrg = boundary === 'different_org' ? 'org_other' : null;
      originalExists = boundary !== 'missing_original';
      expect(await complete(origin)).toEqual({ ok: false, error: 'SCOPE_CHANGED' });
      expect(writes).toEqual([]);
      expect(staged).toEqual([]);
    });

    it(origin+' refuses a lapse before admission without granting or auditing access', async () => {
      mocks.lapse.mockResolvedValue({ ok: false, code: 'org_lapsed', message: 'Reactivate the organization first' });
      expect(await complete(origin)).toEqual(origin === 'page_grant'
        ? { ok: false, error: 'ORG_LAPSED', message: 'Reactivate the organization first' }
        : { ok: false, error: 'POLICY_OFF' });
      expect(writes).toEqual([]);
      expect(staged).toEqual([]);
    });

    it(origin+' carries out an already committed decision within the same active org without reauthorizing its prior approver', async () => {
      expect(await complete(origin)).toMatchObject({ ok: true, driveId: DRIVE, userId: 'user_guest' });
      expect(writes.length).toBeGreaterThan(0);
      expect(staged).toEqual([approval]);
      expect(lockOrder).toEqual(['org', 'drive']);
    });
  }
});
