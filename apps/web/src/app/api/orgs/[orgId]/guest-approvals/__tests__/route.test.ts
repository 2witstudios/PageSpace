/**
 * /api/orgs/[orgId]/guest-approvals (Spec POL-2, X-6): the approval queue. The store is faked; authorization is NOT:
 * the real requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/permissions/guest-holds', () => ({
  listPendingGuestApprovalViews: vi.fn(),
  claimPendingGuestApproval: vi.fn(),
  requestGuestApproval: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/share-link-service', () => ({ completeApprovedLinkAdmission: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-reader', () => ({ getOrgPolicies: vi.fn() }));
vi.mock('@pagespace/lib/audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));
vi.mock('@pagespace/lib/services/invites', () => ({ emitAcceptanceSideEffects: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({ buildAcceptancePorts: vi.fn(() => ({ ports: true })) }));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({ driveInviteRepository: { findDriveById: vi.fn() } }));
vi.mock('@/lib/drive-invites/invite-handlers', () => ({ handleUserIdPath: vi.fn(), handleEmailPath: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { claimPendingGuestApproval, listPendingGuestApprovalViews, requestGuestApproval } from '@pagespace/lib/permissions/guest-holds';
import { completeApprovedLinkAdmission } from '@pagespace/lib/permissions/share-link-service';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { recordOrgAuditEvent } from '@pagespace/lib/audit/org-audit';
import { emitAcceptanceSideEffects } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { handleEmailPath, handleUserIdPath } from '@/lib/drive-invites/invite-handlers';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { GET } from '../route';
import { POST } from '../[holdId]/route';

const ORG_ID = 'org_northwind';
const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const as = (role: OrgRole | null) => vi.mocked(findMembershipRole).mockResolvedValue(role);
const listCtx = { params: Promise.resolve({ orgId: ORG_ID }) };
const decideCtx = { params: Promise.resolve({ orgId: ORG_ID, holdId: 'hold_1' }) };
const get = () => GET(new Request(`https://example.test/api/orgs/${ORG_ID}/guest-approvals`), listCtx);
const decide = (body: unknown) =>
  POST(new Request(`https://example.test/api/orgs/${ORG_ID}/guest-approvals/hold_1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), decideCtx);

const claim = (over: Record<string, unknown> = {}) => ({
  holdId: 'hold_1', orgId: ORG_ID, driveId: 'drive_1', userId: 'user_chris', email: null, origin: 'invite', createdAt: new Date(),
  request: { role: 'MEMBER', customRoleId: null, permissions: [{ pageId: 'p1', canView: true, canEdit: false, canShare: false }], invitedBy: 'user_marcus' },
  requestedBy: 'user_marcus', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES, guests: 'approve' });
  vi.mocked(listPendingGuestApprovalViews).mockResolvedValue({ total: 0, items: [] });
  vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({ id: 'drive_1', name: 'Finance', ownerId: 'user_marcus' } as never);
  vi.mocked(handleUserIdPath).mockResolvedValue(new Response(JSON.stringify({ kind: 'added' }), { status: 200 }));
  vi.mocked(handleEmailPath).mockResolvedValue(new Response(JSON.stringify({ kind: 'invited' }), { status: 200 }));
});

describe('the approval queue routes', () => {
  it('POL-2 (partial) X-6 (partial) only Owner and Admins list or decide; a plain member is refused and a non-member sees no org; the queue is never touched', async () => {
    as('MEMBER');
    expect((await get()).status).toBe(403);
    expect((await decide({ decision: 'approve' })).status).toBe(403);
    as(null);
    expect((await get()).status).toBe(404);
    expect((await decide({ decision: 'approve' })).status).toBe(404);
    expect(listPendingGuestApprovalViews).not.toHaveBeenCalled();
    expect(claimPendingGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) an Admin reads the queue', async () => {
    as('ADMIN');
    vi.mocked(listPendingGuestApprovalViews).mockResolvedValue({ total: 1, items: [{ holdId: 'hold_1' }] as never });
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
  });

  it('POL-2 (partial) a request of another org, a repeat or a missing id all answer the same 404; a bad body is 400 before anything is claimed', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(null);
    expect((await decide({ decision: 'approve' })).status).toBe(404);
    expect(claimPendingGuestApproval).toHaveBeenCalledWith({ orgId: ORG_ID, holdId: 'hold_1' });
    vi.mocked(claimPendingGuestApproval).mockClear();
    expect((await decide({ decision: 'maybe' })).status).toBe(400);
    expect((await decide(null)).status).toBe(400);
    expect(claimPendingGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) declining removes the request, admits nobody, and is audited', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim() as never);
    const res = await decide({ decision: 'decline' });
    expect(await res.json()).toEqual({ decided: 'declined' });
    expect(handleUserIdPath).not.toHaveBeenCalled();
    expect(recordOrgAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'org.guest.declined', actorId: 'user_priya', driveId: 'drive_1' }));
  });

  it('POL-2 (partial) approving an invite replays it through the SAME handler as the original inviter, with the policy skipped so it is not queued again', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim() as never);
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(200);
    expect(handleUserIdPath).toHaveBeenCalledWith(expect.objectContaining({
      driveId: 'drive_1',
      inviterUserId: 'user_marcus',
      skipGuestPolicy: true,
      body: { userId: 'user_chris', role: 'MEMBER', customRoleId: null, permissions: [{ pageId: 'p1', canView: true, canEdit: false, canShare: false }] },
    }));
    expect(recordOrgAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'org.guest.approved' }));
  });

  it('POL-2 (partial) an emailed invitee (no account) is invited by the email handler on approval', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ userId: null, email: 'new@example.com', request: { role: 'MEMBER', expiryDays: 7, invitedBy: 'user_marcus' } }) as never);
    await decide({ decision: 'approve' });
    expect(handleEmailPath).toHaveBeenCalledWith(expect.objectContaining({ skipGuestPolicy: true, body: expect.objectContaining({ email: 'new@example.com', expiryDays: 7 }) }));
    expect(handleUserIdPath).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) when the replayed invite fails, the request goes back on the queue and the approver sees the reason; nothing is audited as approved', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim() as never);
    vi.mocked(handleUserIdPath).mockResolvedValue(new Response(JSON.stringify({ error: 'This account is suspended and cannot be invited.' }), { status: 403 }));
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(403);
    expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, driveId: 'drive_1', userId: 'user_chris', origin: 'invite' }));
    expect(recordOrgAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'org.guest.approved' }));
  });

  it('POL-2 (partial) approving while guests are OFF is refused before the queue is touched: the policy outranks the approver', async () => {
    as('OWNER');
    vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES, guests: 'off' });
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'org_policy', policy: 'guests' });
    expect(claimPendingGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) approving a queued drive-link redeemer admits them and emits the member-added side effects as the link creator', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'drive_link', request: { linkId: 'l1', role: 'MEMBER' } }) as never);
    vi.mocked(completeApprovedLinkAdmission).mockResolvedValue({ ok: true, driveId: 'drive_1', userId: 'user_chris', memberId: 'm1', role: 'MEMBER', customRoleId: null, driveName: 'Finance', createdBy: 'user_marcus' });
    const res = await decide({ decision: 'approve' });
    expect(await res.json()).toEqual({ decided: 'approved', driveId: 'drive_1' });
    expect(emitAcceptanceSideEffects).toHaveBeenCalledWith({ ports: true }, expect.objectContaining({ memberId: 'm1', invitedUserId: 'user_chris', inviterUserId: 'user_marcus' }), 0);
    expect(handleUserIdPath).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) a page-link guest is admitted without a member-added event (they hold one page, not the drive)', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_link', request: { linkId: 'l1', pageId: 'p1' } }) as never);
    vi.mocked(completeApprovedLinkAdmission).mockResolvedValue({ ok: true, driveId: 'drive_1', userId: 'user_chris', memberId: null, role: 'GUEST', customRoleId: null, driveName: 'Finance', createdBy: null });
    expect((await decide({ decision: 'approve' })).status).toBe(200);
    expect(emitAcceptanceSideEffects).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) a link that is gone (revoked or turned off) admits nobody: 409 with the reason, and the request is not re-queued', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'drive_link', request: { linkId: 'l1' } }) as never);
    vi.mocked(completeApprovedLinkAdmission).mockResolvedValue({ ok: false, error: 'LINK_GONE' });
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: 'LINK_GONE' });
    expect(requestGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) the routes are dark with the orgs flag off', async () => {
    flags.orgsEnabled = false;
    as('OWNER');
    expect((await get()).status).toBe(404);
    expect((await decide({ decision: 'approve' })).status).toBe(404);
  });
});
