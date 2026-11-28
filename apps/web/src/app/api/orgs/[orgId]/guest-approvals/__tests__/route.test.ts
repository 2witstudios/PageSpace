/**
 * /api/orgs/[orgId]/guest-approvals (Spec POL-2, X-6): the approval queue. The store is faked; authorization is NOT:
 * the real requireOrgRole runs over a faked membership lookup.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

// The org sign-in policy (SEC-2/3) has its own suites; here every credential meets it.
vi.mock('@pagespace/lib/permissions/actor-authentication', () => ({
  checkActorOrgAuthentication: vi.fn(async () => ({ allowed: true })),
  drivePolicyOrgId: vi.fn(async () => null),
}));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({ findMembershipRole: vi.fn() }));
vi.mock('@pagespace/lib/permissions/guest-holds', () => ({
  listPendingGuestApprovalViews: vi.fn(),
  claimPendingGuestApproval: vi.fn(),
  claimGuestApprovalDecision: vi.fn(),
  requestGuestApproval: vi.fn(),
  markApprovedInvitation: vi.fn(async () => {}),
  // AUD-1: the approval event the route hands every admission to stage in its own transaction.
  guestDecisionAuditEvent: vi.fn((claim: { holdId: string }, eventType: string, actorId: string) => ({ eventType, actorId, holdId: claim.holdId })),
}));
vi.mock('@pagespace/lib/notifications/notifications', () => ({ createPermissionNotification: vi.fn(async () => {}) }));
vi.mock('@/lib/websocket', () => ({ broadcastPageEvent: vi.fn(async () => {}), createPageEventPayload: vi.fn((driveId: string, pageId: string, operation: string) => ({ driveId, pageId, operation })) }));
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/lib/permissions/share-link-service', () => ({ completeApprovedLinkAdmission: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policy-reader', () => ({ getOrgPolicies: vi.fn() }));
vi.mock('@pagespace/lib/services/invites', () => ({ emitAcceptanceSideEffects: vi.fn(async () => {}) }));
vi.mock('@/lib/auth/invite-acceptance-adapters', () => ({ buildAcceptancePorts: vi.fn(() => ({ ports: true })) }));
vi.mock('@/lib/repositories/drive-invite-repository', () => ({ driveInviteRepository: { findDriveById: vi.fn() } }));
vi.mock('@/lib/drive-invites/invite-handlers', () => ({ handleUserIdPath: vi.fn(), handleEmailPath: vi.fn() }));
vi.mock('@pagespace/lib/permissions/page-grant-admission', () => ({ completeApprovedPageGrant: vi.fn() }));
vi.mock('@/lib/repositories/page-invite-repository', () => ({ pageInviteRepository: { findPageById: vi.fn() } }));
vi.mock('@/lib/page-invites/share-invite-handlers', () => ({ sendPendingPageInvite: vi.fn() }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { findMembershipRole } from '@pagespace/lib/organizations/repository';
import { claimGuestApprovalDecision, claimPendingGuestApproval, guestDecisionAuditEvent, listPendingGuestApprovalViews, markApprovedInvitation, requestGuestApproval } from '@pagespace/lib/permissions/guest-holds';
import { createPermissionNotification } from '@pagespace/lib/notifications/notifications';
import { broadcastPageEvent } from '@/lib/websocket';
import { completeApprovedLinkAdmission } from '@pagespace/lib/permissions/share-link-service';
import { getOrgPolicies } from '@pagespace/lib/organizations/policy-reader';
import { emitAcceptanceSideEffects } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { handleEmailPath, handleUserIdPath } from '@/lib/drive-invites/invite-handlers';
import { DEFAULT_ORG_POLICIES } from '@pagespace/lib/organizations/policies-core';
import { completeApprovedPageGrant } from '@pagespace/lib/permissions/page-grant-admission';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { sendPendingPageInvite } from '@/lib/page-invites/share-invite-handlers';
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
  vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session('user_priya'));
  vi.mocked(getOrgPolicies).mockResolvedValue({ ...DEFAULT_ORG_POLICIES, guests: 'approve' });
  vi.mocked(listPendingGuestApprovalViews).mockResolvedValue({ total: 0, items: [] });
  // The decision claim (lib) takes the request off the queue through claimPendingGuestApproval for a paid org.
  vi.mocked(claimGuestApprovalDecision).mockImplementation(async ({ orgId, holdId }) => {
    const claimed = await claimPendingGuestApproval({ orgId, holdId });
    return claimed ? { ok: true, claim: claimed } : { ok: false, reason: 'not_found' };
  });
  vi.mocked(driveInviteRepository.findDriveById).mockResolvedValue({ id: 'drive_1', name: 'Finance', ownerId: 'user_marcus' } as never);
  vi.mocked(handleUserIdPath).mockResolvedValue(new Response(JSON.stringify({ kind: 'added' }), { status: 200 }));
  vi.mocked(handleEmailPath).mockResolvedValue(new Response(JSON.stringify({ kind: 'invited' }), { status: 200 }));
});

describe('the approval queue routes', () => {
  it.each(['page_grant', 'drive_link'] as const)('a completed $0 whose drive left the original org refuses with no requeue or notification', async origin => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: false, error: 'SCOPE_CHANGED' });
    vi.mocked(completeApprovedLinkAdmission).mockResolvedValue({ ok: false, error: 'SCOPE_CHANGED' });
    const response = await decide({ decision: 'approve' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
    expect(requestGuestApproval).not.toHaveBeenCalled();
    expect(createPermissionNotification).not.toHaveBeenCalled();
    expect(broadcastPageEvent).not.toHaveBeenCalled();
  });

  it('a page-grant admission refused by current lapse retains its request for reactivation and returns the typed lapse response', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_grant' }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: false, error: 'ORG_LAPSED', message: 'Reactivate first' });
    const response = await decide({ decision: 'approve' });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'org_lapsed', error: 'Reactivate first' });
    expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, driveId: 'drive_1', origin: 'page_grant' }));
    expect(createPermissionNotification).not.toHaveBeenCalled();
    expect(broadcastPageEvent).not.toHaveBeenCalled();
  });

  it.each([
    { reason: 'insufficient_role' as const, status: 403 as const },
    { reason: 'not_member' as const, status: 404 as const },
  ])('a current-authority $reason refusal is typed and never carries out an approval', async refusal => {
    as('ADMIN');
    vi.mocked(claimGuestApprovalDecision).mockResolvedValue({ ok: false, ...refusal });
    const response = await decide({ decision: 'approve' });
    expect(response.status).toBe(refusal.status);
    expect(await response.json()).toMatchObject({ code: refusal.reason });
    expect(handleUserIdPath).not.toHaveBeenCalled();
    expect(handleEmailPath).not.toHaveBeenCalled();
    expect(completeApprovedLinkAdmission).not.toHaveBeenCalled();
    expect(completeApprovedPageGrant).not.toHaveBeenCalled();
    expect(guestDecisionAuditEvent).not.toHaveBeenCalled();
  });

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

  it('SEAT-9 (partial) POL-2 (partial) approving while the org is LAPSED gets the lapse refusal and admits nobody; the decision names approve (review #2817 P3-1)', async () => {
    as('ADMIN');
    vi.mocked(claimGuestApprovalDecision).mockResolvedValue({ ok: false, reason: 'org_lapsed', message: 'Reactivate to continue.' });
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'Reactivate to continue.', code: 'org_lapsed' });
    expect(claimGuestApprovalDecision).toHaveBeenCalledWith({ orgId: ORG_ID, holdId: 'hold_1', decision: 'approve', actorId: 'user_priya' });
    expect(handleUserIdPath).not.toHaveBeenCalled();
    expect(handleEmailPath).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) declining removes the request, admits nobody, and is audited', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim() as never);
    const res = await decide({ decision: 'decline' });
    expect(await res.json()).toEqual({ decided: 'declined' });
    expect(handleUserIdPath).not.toHaveBeenCalled();
    expect(claimGuestApprovalDecision).toHaveBeenCalledWith({ orgId: ORG_ID, holdId: 'hold_1', decision: 'decline', actorId: 'user_priya' });
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
    // AUD-1: the approver's event rides into the admission, which stages it in its own transaction.
    expect(handleUserIdPath).toHaveBeenCalledWith(expect.objectContaining({ approval: { eventType: 'org.guest.approved', actorId: 'user_priya', holdId: 'hold_1' } }));
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

  it('POL-2 (partial) a link that is gone (revoked or turned off) admits nobody: 409 with its code, and the request is not re-queued', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'drive_link', request: { linkId: 'l1' } }) as never);
    vi.mocked(completeApprovedLinkAdmission).mockResolvedValue({ ok: false, error: 'LINK_GONE' });
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'link_gone' });
    expect(requestGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) approving a queued page grant writes exactly that grant and is audited; the drive invite handlers are not involved', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_grant', request: { permissions: [{ pageId: 'p1', canView: true, canEdit: true, canShare: false }], invitedBy: 'user_marcus' } }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: true, driveId: 'drive_1', userId: 'user_chris', pageIds: ['p1'] });
    const res = await decide({ decision: 'approve' });
    expect(await res.json()).toEqual({ decided: 'approved', driveId: 'drive_1', pageIds: ['p1'] });
    expect(completeApprovedPageGrant).toHaveBeenCalledWith(expect.objectContaining({ holdId: 'hold_1', origin: 'page_grant' }), { eventType: 'org.guest.approved', actorId: 'user_priya', holdId: 'hold_1' });
    expect(handleUserIdPath).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) a queued page grant whose page is gone admits nobody: 409 with the reason, not re-queued, not audited as approved', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_grant' }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: false, error: 'PAGE_GONE' });
    const res = await decide({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'page_gone' });
    expect(requestGuestApproval).not.toHaveBeenCalled();
  });

  it('POL-2 (partial) approving a queued page invitation by email sends it through the SAME handler as the share-invite route, as the original sharer', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({
      origin: 'page_invite', userId: null, email: 'new@example.com',
      request: { pageId: 'p1', permissions: [{ pageId: 'p1', canView: true, canEdit: true, canShare: false }], expiryDays: 7, invitedBy: 'user_marcus' },
    }) as never);
    const page = { id: 'p1', title: 'Plan', driveId: 'drive_1', driveName: 'Finance' };
    vi.mocked(pageInviteRepository.findPageById).mockResolvedValue(page);
    vi.mocked(sendPendingPageInvite).mockResolvedValue(new Response(JSON.stringify({ kind: 'invited' }), { status: 200 }));
    const res = await decide({ decision: 'approve' });
    expect(await res.json()).toEqual({ decided: 'approved', result: { kind: 'invited' } });
    expect(sendPendingPageInvite).toHaveBeenCalledWith(expect.objectContaining({ page, email: 'new@example.com', permissions: ['VIEW', 'EDIT'], expiryDays: 7, inviterUserId: 'user_marcus' }));
  });

  it('POL-2 (partial) a queued page invitation whose page left the drive invites nobody (409); one that fails to send goes back on the queue', async () => {
    as('ADMIN');
    const queued = claim({ origin: 'page_invite', userId: null, email: 'new@example.com', request: { pageId: 'p1', permissions: [{ pageId: 'p1', canView: true, canEdit: false, canShare: false }], invitedBy: 'user_marcus' } });
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(queued as never);
    vi.mocked(pageInviteRepository.findPageById).mockResolvedValue({ id: 'p1', title: 'Plan', driveId: 'drive_other', driveName: 'Elsewhere' });
    expect((await decide({ decision: 'approve' })).status).toBe(409);
    expect(sendPendingPageInvite).not.toHaveBeenCalled();

    vi.mocked(pageInviteRepository.findPageById).mockResolvedValue({ id: 'p1', title: 'Plan', driveId: 'drive_1', driveName: 'Finance' });
    vi.mocked(sendPendingPageInvite).mockResolvedValue(new Response(JSON.stringify({ error: 'pending' }), { status: 409 }));
    expect((await decide({ decision: 'approve' })).status).toBe(409);
    expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com', origin: 'page_invite' }));
  });

  it('POL-2 (partial) approving an emailed invitation records that it was approved, so its acceptance under approve is not queued again', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ userId: null, email: 'new@example.com' }) as never);
    vi.mocked(handleEmailPath).mockResolvedValue(new Response(JSON.stringify({ kind: 'invited', memberId: 'pinv_77' }), { status: 200 }));
    expect((await decide({ decision: 'approve' })).status).toBe(200);
    // Exactly the invitation the email path just stored, never "any invitation to this address" (re-verify N3).
    expect(markApprovedInvitation).toHaveBeenCalledWith(expect.anything(), { orgId: ORG_ID, driveId: 'drive_1', email: 'new@example.com', approvedBy: 'user_priya', invite: { kind: 'drive', id: 'pinv_77' } });
  });

  it('POL-2 (partial) an approved page grant tells the person and refreshes open clients, like an immediate grant', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_grant', request: { permissions: [{ pageId: 'p1', canView: true, canEdit: true, canShare: false }], invitedBy: 'user_marcus' } }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: true, driveId: 'drive_1', userId: 'user_chris', pageIds: ['p1'] });
    expect((await decide({ decision: 'approve' })).status).toBe(200);
    expect(createPermissionNotification).toHaveBeenCalledWith('user_chris', 'p1', 'granted', { canView: true, canEdit: true, canShare: false, canDelete: false }, 'user_marcus');
    expect(broadcastPageEvent).toHaveBeenCalledWith({ driveId: 'drive_1', pageId: 'p1', operation: 'updated' });
  });

  it('POL-2 (partial) a page grant whose approval lost a race with guests turning off goes back on the queue instead of vanishing', async () => {
    as('ADMIN');
    vi.mocked(claimPendingGuestApproval).mockResolvedValue(claim({ origin: 'page_grant' }) as never);
    vi.mocked(completeApprovedPageGrant).mockResolvedValue({ ok: false, error: 'POLICY_OFF' });
    expect((await decide({ decision: 'approve' })).status).toBe(409);
    expect(requestGuestApproval).toHaveBeenCalledWith(expect.objectContaining({ origin: 'page_grant', driveId: 'drive_1' }));
  });
});
