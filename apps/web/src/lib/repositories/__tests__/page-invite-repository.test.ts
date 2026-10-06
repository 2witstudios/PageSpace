/**
 * Unit tests for pageInviteRepository.consumeInviteAndGrantPage and the org's guests policy (Spec POL-2; Review 3+4
 * P1-3: page-invite acceptance never asked the policy, so an outsider got in with guests OFF).
 *
 * The repository is the seam where ORM details are isolated, so @pagespace/db/db is mocked here to verify the order
 * of the writes inside the transaction. The decision itself is proven against real Postgres in
 * packages/lib (guest-admission.integration, page-grant-admission.integration).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTransaction = vi.hoisted(() => vi.fn());
const decideOrgDriveAdmission = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/guest-admission', () => ({ decideOrgDriveAdmission }));
const consumeApprovedInvitation = vi.hoisted(() => vi.fn());
const requestGuestApproval = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/guest-holds', () => ({ consumeApprovedInvitation, requestGuestApproval }));
// [D-OW-33] the lapse guard: no org (null) unless a test lapses the drive.
const checkDriveMayLoosen = vi.hoisted(() => vi.fn());
const checkPageMayLoosen = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/org-lapse-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/permissions/org-lapse-guard')>()),
  checkDriveMayLoosen,
  checkPageMayLoosen,
}));

vi.mock('@pagespace/db/db', () => ({ db: { transaction: mockTransaction } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ kind: 'eq', field, value })),
  and: vi.fn((...conditions) => ({ kind: 'and', conditions })),
  or: vi.fn((...conditions) => ({ kind: 'or', conditions })),
  gt: vi.fn(),
  lte: vi.fn(),
  isNull: vi.fn((field) => ({ kind: 'isNull', field })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id' } }));
vi.mock('@pagespace/db/schema/core', () => ({ drives: { id: 'drives.id' }, pages: { id: 'pages.id', driveId: 'pages.driveId' } }));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { id: 'driveMembers.id', driveId: 'driveMembers.driveId', userId: 'driveMembers.userId', acceptedAt: 'driveMembers.acceptedAt' },
  pagePermissions: { id: 'pagePermissions.id', pageId: 'pagePermissions.pageId', userId: 'pagePermissions.userId' },
}));
vi.mock('@pagespace/db/schema/pending-page-invites', () => ({
  pendingPageInvites: { id: 'ppi.id', consumedAt: 'ppi.consumedAt', email: 'ppi.email' },
}));

import { pageInviteRepository } from '../page-invite-repository';

function setupTx() {
  const consumeSet = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'inv_1' }]) }) });
  const memberLookup = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) });
  const memberValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'mem_1' }]) });
  const grantValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn()
    .mockReturnValueOnce({ values: memberValues })
    .mockReturnValueOnce({ values: grantValues });
  const tx = { update: vi.fn().mockReturnValue({ set: consumeSet }), select: memberLookup, insert };
  mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb(tx));
  return { tx, consumeSet, insert };
}

const input = {
  inviteId: 'inv_1',
  pageId: 'page_1',
  driveId: 'drive_1',
  userId: 'user_outside',
  permissions: ['VIEW' as const],
  invitedBy: 'inviter_1',
  grantedAt: new Date('2026-10-04T12:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  decideOrgDriveAdmission.mockResolvedValue({ decision: 'allow', orgId: null });
  checkDriveMayLoosen.mockResolvedValue(null);
  checkPageMayLoosen.mockResolvedValue(null);
});

describe('pageInviteRepository.consumeInviteAndGrantPage and the guests policy', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF: acceptance is refused with GUEST_POLICY BEFORE the invitation is consumed, and no member row or grant is written', async () => {
    const { tx, consumeSet, insert } = setupTx();
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'refuse', orgId: 'org_1' });

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: false, reason: 'GUEST_POLICY' });
    expect(decideOrgDriveAdmission).toHaveBeenCalledWith({ driveId: 'drive_1', userId: 'user_outside' }, tx);
    expect(consumeSet).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) guests APPROVE: an invitation an Owner or Admin approved (its marker consumed) is accepted', async () => {
    const { insert } = setupTx();
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'hold', orgId: 'org_1' });
    consumeApprovedInvitation.mockResolvedValue(true);

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: true, memberId: 'mem_1' });
    expect(consumeApprovedInvitation).toHaveBeenCalledWith(expect.anything(), { driveId: 'drive_1', invite: { kind: 'page', id: 'inv_1' } });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('POL-2 (partial) guests APPROVE: an invitation nobody approved is queued as a page grant, spent, and grants nothing', async () => {
    const { consumeSet, insert } = setupTx();
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'hold', orgId: 'org_1' });
    consumeApprovedInvitation.mockResolvedValue(false);

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: false, reason: 'GUEST_APPROVAL_PENDING' });
    expect(consumeSet).toHaveBeenCalledWith({ consumedAt: input.grantedAt });
    expect(insert).not.toHaveBeenCalled();
    expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', driveId: 'drive_1', userId: 'user_outside', origin: 'page_grant',
      request: { permissions: [{ pageId: 'page_1', canView: true, canEdit: false, canShare: false, canDelete: false }], invitedBy: 'inviter_1' },
    }), expect.anything());
  });

  it('POL-2 (partial) guests ON or a personal drive: the invitation is consumed and the page granted as before', async () => {
    const { consumeSet, insert } = setupTx();

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: true, memberId: 'mem_1' });
    expect(consumeSet).toHaveBeenCalledWith({ consumedAt: input.grantedAt });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});

describe('pageInviteRepository [D-OW-33] a lapsed org only restricts', () => {
  const LAPSED = { ok: false, code: 'org_lapsed', status: 402, message: 'lapsed' };

  it('SEAT-9 (partial) [D-OW-33] consumeInviteAndGrantPage: refused with ORG_LAPSED BEFORE the token is consumed; no row or grant written', async () => {
    const { tx, consumeSet, insert } = setupTx();
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'allow', orgId: 'org_1' });
    checkDriveMayLoosen.mockResolvedValue(LAPSED);

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: false, reason: 'ORG_LAPSED' });
    expect(checkDriveMayLoosen).toHaveBeenCalledWith(tx, 'drive_1', true);
    expect(consumeSet).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) [D-OW-33] createDirectPagePermission: a new grant while lapsed throws OrgLapsedError and inserts nothing; an existing grant is returned untouched', async () => {
    const insert = vi.fn();
    const limit = vi.fn().mockResolvedValue([]);
    const select = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit }) }) });
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({ select, insert }));
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'allow', orgId: 'org_1' });
    checkDriveMayLoosen.mockResolvedValue(LAPSED);
    const grant = { pageId: 'page_1', driveId: 'drive_1', userId: 'member_1', canView: true, canEdit: false, canShare: false, grantedBy: 'admin' };

    await expect(pageInviteRepository.createDirectPagePermission(grant)).rejects.toMatchObject({ code: 'org_lapsed' });
    expect(insert).not.toHaveBeenCalled();

    limit.mockResolvedValue([{ id: 'perm_existing' }]);
    expect(await pageInviteRepository.createDirectPagePermission(grant)).toEqual({ id: 'perm_existing' });
  });

  it('SEAT-9 (partial) [D-OW-33] createPendingInvite: no page invitation is issued while lapsed', async () => {
    const insert = vi.fn();
    const del = vi.fn();
    mockTransaction.mockImplementation(async (cb: (t: unknown) => Promise<unknown>) => cb({ insert, delete: del }));
    checkPageMayLoosen.mockResolvedValue(LAPSED);

    await expect(pageInviteRepository.createPendingInvite({
      tokenHash: 'h', email: 'a@b.com', pageId: 'page_1', permissions: ['VIEW'], invitedBy: 'i', expiresAt: null, now: new Date(),
    })).rejects.toMatchObject({ code: 'org_lapsed' });
    expect(checkPageMayLoosen).toHaveBeenCalledWith(expect.anything(), 'page_1', true);
    expect(insert).not.toHaveBeenCalled();
  });
});
