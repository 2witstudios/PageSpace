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
  pendingPageInvites: { id: 'ppi.id', consumedAt: 'ppi.consumedAt' },
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

  it('POL-2 (partial) guests APPROVE: an invitation approved when it was sent is not asked twice and is accepted', async () => {
    const { insert } = setupTx();
    decideOrgDriveAdmission.mockResolvedValue({ decision: 'hold', orgId: 'org_1' });

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: true, memberId: 'mem_1' });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it('POL-2 (partial) guests ON or a personal drive: the invitation is consumed and the page granted as before', async () => {
    const { consumeSet, insert } = setupTx();

    expect(await pageInviteRepository.consumeInviteAndGrantPage(input)).toEqual({ ok: true, memberId: 'mem_1' });
    expect(consumeSet).toHaveBeenCalledWith({ consumedAt: input.grantedAt });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
