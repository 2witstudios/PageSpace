/**
 * `operations/organizations.ts` (Spec X-1) — the org WRITES and admin reads. Each operation
 * is pinned to the route it calls (method + interpolated path), what it sends (body for a
 * write, query for a read), its destructive flag, and the response shape it accepts. The
 * server's authorization is the web's requireOrgRole (ORG-5); these tests prove the SDK
 * reaches exactly those routes.
 */
import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import {
  acceptOrgInvitation,
  addOrgDomain,
  answerOrgGuestApproval,
  changeOrgMemberRole,
  clearOrgSuppression,
  confirmOrgDomainEmail,
  deleteOrgAutomation,
  exportOrgAuditLog,
  getOrgAuditLog,
  getOrgDriveUsage,
  inviteToOrganization,
  leaveOrganization,
  listOrgAutomations,
  listOrgDomains,
  listOrgGuestApprovals,
  listOrgGuests,
  listOrgInvitations,
  listOrgMemberActivity,
  listOrgPolicySuspensions,
  listOrgTrashedDrives,
  ORG_POLICY_KEYS,
  reassignOrgAutomation,
  removeOrgDomain,
  removeOrgMember,
  resendOrgInvitation,
  revokeOrgInvitation,
  updateOrgPolicies,
  updateOrganization,
  verifyOrgDomain,
} from '../organizations.js';

const config = { baseUrl: 'https://pagespace.ai' };
/** The transport takes any operation; the per-case unions are too wide for its generic, so widen once here. */
const anyOp = (op: unknown) => op as Parameters<typeof buildRequest>[0];
const body = (request: { body?: string }) => (request.body === undefined ? undefined : JSON.parse(request.body));

const INVITATION = {
  id: 'inv1',
  orgId: 'o1',
  email: 'marcus@northwind.test',
  role: 'MEMBER',
  invitedBy: 'u1',
  expiresAt: '2026-09-24T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-09-17T00:00:00.000Z',
};

const DOMAIN = {
  id: 'dom1',
  orgId: 'o1',
  domain: 'northwind.com',
  dnsToken: 'tok',
  emailTokenExpiresAt: null,
  emailSentTo: null,
  verifiedAt: null,
  verifiedMethod: null,
  createdBy: 'u1',
  createdAt: '2026-09-17T00:00:00.000Z',
  dnsRecord: { type: 'TXT', name: '_pagespace.northwind.com', value: 'pagespace-verify=tok' },
};

describe('org writes — route, method, payload', () => {
  const cases = [
    { op: updateOrganization, input: { orgId: 'o1', name: 'Northwind' }, method: 'PATCH', url: '/api/orgs/o1', sent: { name: 'Northwind' } },
    { op: changeOrgMemberRole, input: { orgId: 'o1', userId: 'u2', role: 'ADMIN' }, method: 'PATCH', url: '/api/orgs/o1/members/u2', sent: { role: 'ADMIN' } },
    { op: removeOrgMember, input: { orgId: 'o1', userId: 'u2' }, method: 'DELETE', url: '/api/orgs/o1/members/u2', sent: undefined },
    { op: leaveOrganization, input: { orgId: 'o1' }, method: 'POST', url: '/api/orgs/o1/leave', sent: undefined },
    { op: inviteToOrganization, input: { orgId: 'o1', email: 'a@b.co', role: 'ADMIN' }, method: 'POST', url: '/api/orgs/o1/invitations', sent: { email: 'a@b.co', role: 'ADMIN' } },
    { op: resendOrgInvitation, input: { orgId: 'o1', invitationId: 'inv1' }, method: 'POST', url: '/api/orgs/o1/invitations/inv1/resend', sent: undefined },
    { op: revokeOrgInvitation, input: { orgId: 'o1', invitationId: 'inv1' }, method: 'DELETE', url: '/api/orgs/o1/invitations/inv1', sent: undefined },
    { op: acceptOrgInvitation, input: { token: 'ps_orginv_t' }, method: 'POST', url: '/api/orgs/invitations/accept', sent: { token: 'ps_orginv_t' } },
    {
      op: updateOrgPolicies,
      input: { orgId: 'o1', requireStrongSignIn: true, maximumSessionAgeMinutes: 60 },
      method: 'PATCH',
      url: '/api/orgs/o1/policies',
      sent: { requireStrongSignIn: true, maximumSessionAgeMinutes: 60 },
    },
    { op: deleteOrgAutomation, input: { orgId: 'o1', kind: 'workflow', automationId: 'w1' }, method: 'DELETE', url: '/api/orgs/o1/automations/workflow/w1', sent: undefined },
    {
      op: reassignOrgAutomation,
      input: { orgId: 'o1', kind: 'page_webhook', automationId: 'h1', newOwnerId: 'u3' },
      method: 'POST',
      url: '/api/orgs/o1/automations/page_webhook/h1/reassign',
      sent: { newOwnerId: 'u3' },
    },
    { op: answerOrgGuestApproval, input: { orgId: 'o1', holdId: 'h1', decision: 'decline' }, method: 'POST', url: '/api/orgs/o1/guest-approvals/h1', sent: { decision: 'decline' } },
    { op: addOrgDomain, input: { orgId: 'o1', domain: 'northwind.com' }, method: 'POST', url: '/api/orgs/o1/domains', sent: { domain: 'northwind.com' } },
    { op: removeOrgDomain, input: { orgId: 'o1', domainId: 'dom1' }, method: 'DELETE', url: '/api/orgs/o1/domains/dom1', sent: undefined },
    {
      op: verifyOrgDomain,
      input: { orgId: 'o1', domainId: 'dom1', method: 'email', mailbox: 'postmaster' },
      method: 'POST',
      url: '/api/orgs/o1/domains/dom1/verify',
      sent: { method: 'email', mailbox: 'postmaster' },
    },
    { op: confirmOrgDomainEmail, input: { token: 't' }, method: 'POST', url: '/api/orgs/domains/verify-email', sent: { token: 't' } },
    { op: clearOrgSuppression, input: { orgId: 'o1', email: 'gone@northwind.com' }, method: 'POST', url: '/api/orgs/o1/suppressions/clear', sent: { email: 'gone@northwind.com' } },
  ] as const;

  for (const c of cases) {
    it(`X-1 (partial) ${c.op.name} is ${c.method} ${c.url}`, () => {
      expect(c.op.inputSchema.safeParse(c.input).success).toBe(true);
      const request = buildRequest(anyOp(c.op), c.input as Record<string, unknown>, config);
      expect(request.method).toBe(c.method);
      expect(request.url).toBe(`https://pagespace.ai${c.url}`);
      expect(body(request)).toEqual(c.sent);
    });
  }

  it('X-1 (partial) exactly the irreversible verbs are destructive (CLI asks for --yes)', () => {
    const destructive = [removeOrgMember, leaveOrganization, revokeOrgInvitation, deleteOrgAutomation, removeOrgDomain];
    const notDestructive = [updateOrganization, changeOrgMemberRole, inviteToOrganization, resendOrgInvitation, acceptOrgInvitation, updateOrgPolicies, reassignOrgAutomation, answerOrgGuestApproval, addOrgDomain, verifyOrgDomain, confirmOrgDomainEmail, clearOrgSuppression];
    for (const op of destructive) expect(op.destructive, op.name).toBe(true);
    for (const op of notDestructive) expect(op.destructive, op.name).toBeUndefined();
  });

  it('X-1 (partial) every write states the sign-in policy rule for the key', () => {
    for (const op of [updateOrganization, changeOrgMemberRole, removeOrgMember, leaveOrganization, inviteToOrganization, updateOrgPolicies]) {
      expect(op.description, op.name).toContain('org_strong_sign_in_required');
      expect(op.description, op.name).toContain('org_reauthentication_required');
    }
  });
});

describe('org writes — input validation before the network', () => {
  it('X-1 (partial) update refuses an empty change and unknown fields', () => {
    expect(updateOrganization.inputSchema.safeParse({ orgId: 'o1' }).success).toBe(false);
    expect(updateOrganization.inputSchema.safeParse({ orgId: 'o1', avatarUrl: null }).success).toBe(true);
    expect(updateOrganization.inputSchema.safeParse({ orgId: 'o1', name: 'x', ownerId: 'u9' }).success).toBe(false);
  });

  it('X-1 (partial) a role change or invite can never grant OWNER (ownership transfer is session-only)', () => {
    expect(changeOrgMemberRole.inputSchema.safeParse({ orgId: 'o1', userId: 'u2', role: 'OWNER' }).success).toBe(false);
    expect(inviteToOrganization.inputSchema.safeParse({ orgId: 'o1', email: 'a@b.co', role: 'OWNER' }).success).toBe(false);
  });

  it('X-1 (partial) a policy change names at least one known policy, with the sign-in bounds', () => {
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1' }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', unknownPolicy: true }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', maximumSessionAgeMinutes: 14 }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', maximumSessionAgeMinutes: 43_201 }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', maximumSessionAgeMinutes: null }).success).toBe(true);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', guests: 'sometimes' }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'o1', modelAllowlist: ['m1'], whoCanInvite: 'members' }).success).toBe(true);
    // Every policy key is changeable, and nothing else but the org id.
    expect(Object.keys(updateOrgPolicies.inputSchema.shape).sort()).toEqual(['orgId', ...ORG_POLICY_KEYS].sort());
  });

  it('X-1 (partial) automation kind and guest decision are closed vocabularies', () => {
    expect(deleteOrgAutomation.inputSchema.safeParse({ orgId: 'o1', kind: 'cron', automationId: 'w1' }).success).toBe(false);
    expect(answerOrgGuestApproval.inputSchema.safeParse({ orgId: 'o1', holdId: 'h1', decision: 'maybe' }).success).toBe(false);
    expect(verifyOrgDomain.inputSchema.safeParse({ orgId: 'o1', domainId: 'd', method: 'email', mailbox: 'ceo' }).success).toBe(false);
  });
});

describe('org writes — responses', () => {
  it('X-1 (partial) invitation rows parse; the token hash never appears in the type', () => {
    const parsed = inviteToOrganization.outputSchema.parse({ invitation: { ...INVITATION, tokenHash: 'secret' } });
    expect(parsed.invitation).toEqual(INVITATION);
    expect(listOrgInvitations.outputSchema.safeParse({ invitations: [INVITATION] }).success).toBe(true);
    expect(resendOrgInvitation.outputSchema.safeParse({ invitation: INVITATION }).success).toBe(true);
    expect(revokeOrgInvitation.outputSchema.safeParse({ revoked: true }).success).toBe(true);
    expect(acceptOrgInvitation.outputSchema.safeParse({ orgId: 'o1', role: 'MEMBER', joined: true }).success).toBe(true);
  });

  it('X-1 (partial) membership answers parse', () => {
    expect(changeOrgMemberRole.outputSchema.safeParse({ userId: 'u2', role: 'ADMIN' }).success).toBe(true);
    expect(removeOrgMember.outputSchema.safeParse({ removed: true }).success).toBe(true);
    expect(leaveOrganization.outputSchema.safeParse({ left: true }).success).toBe(true);
    expect(updateOrganization.outputSchema.safeParse({
      organization: { id: 'o1', name: 'N', slug: 'n', avatarUrl: null, ownerId: 'u1', createdAt: '2026-09-01T00:00:00.000Z' },
    }).success).toBe(true);
  });

  it('X-1 (partial) a policy change answers the new policies and what it suspended, restored and blocked', () => {
    const policies = {
      requireStrongSignIn: true,
      maximumSessionAgeMinutes: 60,
      guests: 'off',
      publicShareLinks: false,
      publishWeb: true,
      customDomains: true,
      whoCanInvite: 'admins',
      whoCanCreateDrives: 'members',
      openDriveRoleFloor: 'view',
      modelAllowlist: null,
      providerAllowlist: null,
      agentsAutonomous: true,
      crossDriveAgents: true,
      cloudSandbox: true,
      persistentEnvironments: true,
      publishedApps: true,
      integrationsAllowlist: null,
    };
    const answer = { policies, changed: ['guests'], suspended: { guests: 2 }, restored: {}, blocked: {}, auditRecorded: true };
    expect(updateOrgPolicies.outputSchema.parse(answer)).toEqual(answer);
  });

  it('X-1 (partial) [D-OW-26] a key\'s policy change cannot name a money policy: the seat allowance and the wallet fallback are not inputs', () => {
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'org_1', seatAllowanceCents: 3000 }).success).toBe(false);
    expect(updateOrgPolicies.inputSchema.safeParse({ orgId: 'org_1', walletFallback: 'seat_allowance' }).success).toBe(false);
    expect(ORG_POLICY_KEYS).not.toContain('seatAllowanceCents');
    expect(ORG_POLICY_KEYS).not.toContain('walletFallback');
  });

  it('X-1 (partial) domain answers parse, including both verify outcomes', () => {
    expect(listOrgDomains.outputSchema.safeParse({ domains: [DOMAIN] }).success).toBe(true);
    expect(addOrgDomain.outputSchema.safeParse({ domain: DOMAIN }).success).toBe(true);
    expect(removeOrgDomain.outputSchema.safeParse({ removed: true }).success).toBe(true);
    const { dnsRecord: _dnsRecord, ...verified } = DOMAIN;
    expect(verifyOrgDomain.outputSchema.safeParse({ domain: { ...verified, verifiedAt: '2026-09-18T00:00:00.000Z', verifiedMethod: 'dns' }, alreadyVerified: false }).success).toBe(true);
    expect(verifyOrgDomain.outputSchema.safeParse({ sentTo: 'postmaster@northwind.com', expiresAt: '2026-09-18T00:00:00.000Z' }).success).toBe(true);
    expect(confirmOrgDomainEmail.outputSchema.safeParse({ domain: 'northwind.com', verified: true }).success).toBe(true);
    expect(clearOrgSuppression.outputSchema.safeParse({ cleared: false }).success).toBe(true);
  });

  it('X-1 (partial) automation and guest-approval answers parse', () => {
    expect(deleteOrgAutomation.outputSchema.safeParse({ deleted: true }).success).toBe(true);
    expect(reassignOrgAutomation.outputSchema.safeParse({ reassigned: true, newOwnerId: 'u3' }).success).toBe(true);
    expect(answerOrgGuestApproval.outputSchema.safeParse({ decided: 'declined' }).success).toBe(true);
    expect(answerOrgGuestApproval.outputSchema.safeParse({ decided: 'approved', driveId: 'd1', pageIds: ['p1'] }).success).toBe(true);
    expect(answerOrgGuestApproval.outputSchema.safeParse({ decided: 'approved', result: { kind: 'invited' } }).success).toBe(true);
  });
});

describe('org admin reads — route, query, response', () => {
  it('X-1 (partial) each admin read is a GET on its org route with account scope', () => {
    const reads = [
      [listOrgMemberActivity, '/api/orgs/o1/members/activity'],
      [listOrgInvitations, '/api/orgs/o1/invitations'],
      [listOrgPolicySuspensions, '/api/orgs/o1/policies/suspended'],
      [listOrgTrashedDrives, '/api/orgs/o1/drives/trashed'],
      [getOrgDriveUsage, '/api/orgs/o1/drives/usage'],
      [listOrgAutomations, '/api/orgs/o1/automations'],
      [listOrgGuests, '/api/orgs/o1/guests'],
      [listOrgGuestApprovals, '/api/orgs/o1/guest-approvals'],
      [listOrgDomains, '/api/orgs/o1/domains'],
      [getOrgAuditLog, '/api/orgs/o1/audit'],
      [exportOrgAuditLog, '/api/orgs/o1/audit/export'],
    ] as const;
    for (const [op, url] of reads) {
      const request = buildRequest(anyOp(op), { orgId: 'o1' }, config);
      expect(request.method, op.name).toBe('GET');
      expect(request.url, op.name).toBe(`https://pagespace.ai${url}`);
      expect(op.requiredScope, op.name).toBe('account');
    }
  });

  it('X-1 (partial) the audit log sends its filters and cursor as query parameters', () => {
    const request = buildRequest(getOrgAuditLog, { orgId: 'o1', category: 'membership', driveId: 'd1', limit: 50, before: 1234 }, config);
    expect(request.url).toBe('https://pagespace.ai/api/orgs/o1/audit?before=1234&category=membership&driveId=d1&limit=50');
    expect(getOrgAuditLog.inputSchema.safeParse({ orgId: 'o1', limit: 501 }).success).toBe(false);
    expect(getOrgAuditLog.inputSchema.safeParse({ orgId: 'o1', category: 'gossip' }).success).toBe(false);
    expect(exportOrgAuditLog.inputSchema.safeParse({ orgId: 'o1', limit: 10 }).success).toBe(false);
  });

  it('X-1 (partial) the audit export is CSV text, not JSON', () => {
    expect(exportOrgAuditLog.textResponse).toBe(true);
    expect(exportOrgAuditLog.expectedContentType).toBe('text/csv');
  });

  it('X-1 (partial) the admin read models parse', () => {
    expect(getOrgAuditLog.outputSchema.safeParse({
      entries: [{ timestamp: '2026-09-17T00:00:00.000Z', category: 'membership', eventType: 'org.member.removed', actorId: 'u1', actorName: 'Jono', resourceType: 'organization_member', resourceId: 'u2', driveId: null, details: {} }],
      nextCursor: null,
    }).success).toBe(true);
    expect(listOrgMemberActivity.outputSchema.safeParse({ activity: [{ userId: 'u1', driveCount: 3, lastActiveAt: null }] }).success).toBe(true);
    expect(listOrgTrashedDrives.outputSchema.safeParse({ drives: [{ id: 'd1', name: 'Old', trashedAt: null, lead: { id: 'u1', name: null } }] }).success).toBe(true);
    expect(getOrgDriveUsage.outputSchema.safeParse({ usage: [{ driveId: 'd1', memberCount: 4, guestCount: 1, storageBytes: 100 }] }).success).toBe(true);
    expect(listOrgAutomations.outputSchema.safeParse({ automations: [{ kind: 'workflow', id: 'w1', driveId: 'd1', name: 'Nightly', ownerLeftAt: '2026-09-17T00:00:00.000Z' }] }).success).toBe(true);
    expect(listOrgGuests.outputSchema.safeParse({ guests: [{ userId: 'g1', name: null, email: 'g@x.co', image: null, drives: [{ id: 'd1', name: 'R', pending: false, source: 'invited', pageCount: 0 }] }] }).success).toBe(true);
    expect(listOrgGuestApprovals.outputSchema.safeParse({
      total: 1,
      items: [{
        holdId: 'h1', driveId: 'd1', userId: null, email: 'g@x.co', origin: 'invite', createdAt: '2026-09-17T00:00:00.000Z', driveName: 'R', requesterName: null,
        request: { role: 'MEMBER', customRoleId: null, pageGrants: 0, tokenScopes: 0, earliestExpiry: null, viaLink: false },
      }],
    }).success).toBe(true);
    expect(listOrgPolicySuspensions.outputSchema.safeParse({
      suspended: [{ kind: 'guests', resourceType: 'guest_hold', total: 1, items: [{ kind: 'guests', resourceType: 'guest_hold', id: 'h1', driveId: 'd1', userId: 'g1', driveName: 'R', userName: 'Gus', label: 'Guest Gus' }] }],
    }).success).toBe(true);
  });
});
