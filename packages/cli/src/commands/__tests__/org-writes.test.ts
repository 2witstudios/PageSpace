import { describe, expect, it } from 'vitest';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  buildAuditFilter,
  buildVerifyDomain,
  parseArgv,
  parsePolicyAssignments,
  parseVerbArgs,
  renderAuditLog,
  renderDomains,
  renderGuestApprovals,
  renderInvitations,
  renderPolicyChange,
  renderSuspended,
  orgsAcceptInviteHandler,
  orgsAnswerGuestHandler,
  policyChangeMayRestrict,
  orgsAuditExportHandler,
  orgsAuditHandler,
  orgsDeleteAutomationHandler,
  orgsInviteHandler,
  orgsLeaveHandler,
  orgsRemoveMemberHandler,
  orgsSetPoliciesHandler,
  orgsSetRoleHandler,
  orgsSignInPreviewHandler,
  orgsUpdateHandler,
  orgsVerifyDomainHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const INVITATION = {
  id: 'inv1',
  orgId: 'o1',
  email: 'marcus@northwind.test',
  role: 'MEMBER' as const,
  invitedBy: 'u1',
  expiresAt: '2026-09-24T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-09-17T00:00:00.000Z',
};

describe('verb argv (pure)', () => {
  it('X-1 (partial) splits positionals from known --flag values and refuses everything else', () => {
    const spec = { usage: 'Usage: x <a> <b>', positionals: 2, flags: ['role'] };
    expect(parseVerbArgs(['o1', 'a@b.co', '--role', 'ADMIN'], spec)).toEqual({ ok: true, value: { positionals: ['o1', 'a@b.co'], options: { role: 'ADMIN' } } });
    expect(parseVerbArgs(['o1'], spec).ok).toBe(false);
    expect(parseVerbArgs(['o1', 'a', 'b'], spec).ok).toBe(false);
    expect(parseVerbArgs(['o1', 'a', '--nope', 'x'], spec).ok).toBe(false);
    expect(parseVerbArgs(['o1', 'a', '--role'], spec).ok).toBe(false);
    expect(parseVerbArgs(['o1', 'a', '--role', 'A', '--role', 'B'], spec).ok).toBe(false);
    expect(parseVerbArgs(['o1', 'a', 'b', 'c'], { ...spec, variadic: true }).ok).toBe(true);
  });
});

describe('orgs set-policies — key=value (pure)', () => {
  it('X-1 (partial) parses booleans, minutes, allowlists and words, including the sign-in policy', () => {
    expect(parsePolicyAssignments(['requireStrongSignIn=on', 'maximumSessionAgeMinutes=480', 'guests=approve', 'modelAllowlist=a, b', 'providerAllowlist=none', 'integrationsAllowlist='])).toEqual({
      ok: true,
      value: {
        requireStrongSignIn: true,
        maximumSessionAgeMinutes: 480,
        guests: 'approve',
        modelAllowlist: ['a', 'b'],
        providerAllowlist: null,
        integrationsAllowlist: [],
      },
    });
    expect(parsePolicyAssignments(['maximumSessionAgeMinutes=none'])).toEqual({ ok: true, value: { maximumSessionAgeMinutes: null } });
  });

  it('X-1 (partial) refuses unknown keys, malformed pairs, repeats and bad values before the network', () => {
    expect(parsePolicyAssignments(['bogus=1']).ok).toBe(false);
    expect(parsePolicyAssignments(['guests']).ok).toBe(false);
    expect(parsePolicyAssignments(['guests=on', 'guests=off']).ok).toBe(false);
    expect(parsePolicyAssignments(['requireStrongSignIn=maybe']).ok).toBe(false);
    expect(parsePolicyAssignments(['maximumSessionAgeMinutes=soon']).ok).toBe(false);
    // [D-OW-26] the money policies are not a key's to set: refused as unknown before the network.
    expect(parsePolicyAssignments(['seatAllowanceCents=3000']).ok).toBe(false);
    expect(parsePolicyAssignments(['walletFallback=seat_allowance']).ok).toBe(false);
  });
});

describe('org verb builders (pure)', () => {
  it('X-1 (partial) audit filters: only known categories, flags renamed to the operation input', () => {
    expect(buildAuditFilter({ category: 'membership', drive: 'd1', from: '2026-09-01' }, 'u')).toEqual({ ok: true, value: { category: 'membership', driveId: 'd1', from: '2026-09-01' } });
    expect(buildAuditFilter({ category: 'gossip' }, 'u').ok).toBe(false);
  });

  it('X-1 (partial) verify-domain is `dns` or `email <mailbox>`', () => {
    expect(buildVerifyDomain(['o1', 'dom1', 'dns'])).toEqual({ ok: true, value: { orgId: 'o1', domainId: 'dom1', method: 'dns' } });
    expect(buildVerifyDomain(['o1', 'dom1', 'email', 'postmaster'])).toEqual({ ok: true, value: { orgId: 'o1', domainId: 'dom1', method: 'email', mailbox: 'postmaster' } });
    expect(buildVerifyDomain(['o1', 'dom1', 'email']).ok).toBe(false);
    expect(buildVerifyDomain(['o1', 'dom1', 'email', 'ceo']).ok).toBe(false);
    expect(buildVerifyDomain(['o1', 'dom1', 'dns', 'extra']).ok).toBe(false);
  });
});

describe('org renderers (pure)', () => {
  it('X-1 (partial) invitations, policy changes, audit pages, suspensions, guest queue and domains render', () => {
    expect(renderInvitations({ invitations: [INVITATION] })).toContain('inv1  [MEMBER]  marcus@northwind.test  expires 2026-09-24');
    expect(renderInvitations({ invitations: [] })).toBe('No open invitations.\n');

    const change = renderPolicyChange({
      policies: { requireStrongSignIn: true } as never,
      changed: ['requireStrongSignIn'],
      suspended: { guests: 2 },
      restored: {},
      blocked: {},
      auditRecorded: true,
    });
    expect(change).toContain('Changed: requireStrongSignIn=on');
    expect(change).toContain('suspended: guests 2');

    const audit = renderAuditLog({
      entries: [{ timestamp: '2026-09-17T00:00:00.000Z', category: 'membership', eventType: 'org.member.removed', actorId: 'u1', actorName: 'Jono', resourceType: 'organization_member', resourceId: 'u2', driveId: null, details: {} }],
      nextCursor: 42,
    });
    expect(audit).toContain('org.member.removed  by Jono  organization_member:u2');
    expect(audit).toContain('More: --before 42');

    expect(renderSuspended({ suspended: [{ kind: 'guests', resourceType: 'guest_hold', total: 0, items: [] }] })).toBe('Nothing is suspended by policy.\n');
    expect(renderGuestApprovals({ total: 0, items: [] })).toContain('No guests');
    expect(
      renderDomains({
        domains: [{ id: 'dom1', orgId: 'o1', domain: 'northwind.com', dnsToken: 't', emailTokenExpiresAt: null, emailSentTo: null, verifiedAt: null, verifiedMethod: null, createdBy: null, createdAt: '2026-09-17T00:00:00.000Z', dnsRecord: { type: 'TXT', name: '_ps.northwind.com', value: 'v=t' } }],
      }),
    ).toContain('TXT _ps.northwind.com  "v=t"');
  });
});

describe('pagespace orgs <write verbs>', () => {
  it('X-1 (partial) set-role sends the role to organizations.changeMemberRole; OWNER is a usage error', async () => {
    const calls: unknown[] = [];
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { changeMemberRole: async (input: unknown) => (calls.push(input), { userId: 'u2', role: 'ADMIN' }) } }), stdout });
    expect(await orgsSetRoleHandler(ctx, commandIntent(['o1', 'u2', 'ADMIN']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ orgId: 'o1', userId: 'u2', role: 'ADMIN' }]);
    expect(stdout.lines.join('')).toBe('u2 is now ADMIN.\n');

    const stderr = createRecordingSink();
    expect(await orgsSetRoleHandler(createFakeContext({ stderr }), commandIntent(['o1', 'u2', 'OWNER']))).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('Role must be one of: ADMIN, MEMBER');
  });

  it('X-1 (partial) invite passes --role through; update needs at least one field and maps --avatar-url none to null', async () => {
    const calls: unknown[] = [];
    const ctx = createFakeContext({
      sdk: fakeSdk({
        organizations: {
          invite: async (input: unknown) => (calls.push(input), { invitation: INVITATION }),
          update: async (input: unknown) => (calls.push(input), { organization: { id: 'o1', name: 'N', slug: 'n', avatarUrl: null, ownerId: 'u1', createdAt: '2026-09-01T00:00:00.000Z' } }),
        },
      }),
    });
    expect(await orgsInviteHandler(ctx, commandIntent(['o1', 'marcus@northwind.test', '--role', 'ADMIN']))).toBe(EXIT_SUCCESS);
    expect(await orgsUpdateHandler(ctx, commandIntent(['o1', '--name', 'N', '--avatar-url', 'none']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([
      { orgId: 'o1', email: 'marcus@northwind.test', role: 'ADMIN' },
      { orgId: 'o1', name: 'N', avatarUrl: null },
    ]);
    expect(await orgsUpdateHandler(createFakeContext(), commandIntent(['o1']))).toBe(EXIT_USAGE_ERROR);
  });

  it('X-1 (partial) set-policies sends the parsed change, sign-in policy included', async () => {
    const calls: unknown[] = [];
    const ctx = createFakeContext({
      sdk: fakeSdk({
        organizations: {
          updatePolicies: async (input: unknown) => (calls.push(input), { policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 60 }, changed: ['requireStrongSignIn', 'maximumSessionAgeMinutes'], suspended: {}, restored: {}, blocked: {}, auditRecorded: true }),
        },
      }),
    });
    expect(await orgsSetPoliciesHandler(ctx, commandIntent(['o1', 'requireStrongSignIn=on', 'maximumSessionAgeMinutes=60', '--yes']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ orgId: 'o1', requireStrongSignIn: true, maximumSessionAgeMinutes: 60 }]);
    expect(await orgsSetPoliciesHandler(createFakeContext(), commandIntent(['o1']))).toBe(EXIT_USAGE_ERROR);
  });

  it('X-1 (partial) sign-in-preview sends the candidate sign-in policy and prints the counts', async () => {
    const calls: unknown[] = [];
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      sdk: fakeSdk({ organizations: { previewSignInPolicy: async (input: unknown) => (calls.push(input), { members: 2, credentials: 1 }) } }),
    });
    expect(await orgsSignInPreviewHandler(ctx, commandIntent(['o1', '--strong', 'true', '--max-age', '60']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ orgId: 'o1', requireStrongSignIn: true, maximumSessionAgeMinutes: 60 }]);
    expect(stdout.lines.join('')).toBe('This sign-in policy would refuse 2 members (1 live credential) right now.\n');
    expect(await orgsSignInPreviewHandler(createFakeContext(), commandIntent(['o1', '--strong', 'yes']))).toBe(EXIT_USAGE_ERROR);
    expect(await orgsSignInPreviewHandler(createFakeContext(), commandIntent(['o1', '--max-age', '1h']))).toBe(EXIT_USAGE_ERROR);
  });

  it('X-1 (partial) policyChangeMayRestrict: true when any assignment can tighten access, false when every one only opens', () => {
    expect(policyChangeMayRestrict({ publishWeb: false })).toBe(true);
    expect(policyChangeMayRestrict({ requireStrongSignIn: true })).toBe(true);
    expect(policyChangeMayRestrict({ maximumSessionAgeMinutes: 60 })).toBe(true);
    expect(policyChangeMayRestrict({ guests: 'approve' })).toBe(true);
    expect(policyChangeMayRestrict({ whoCanInvite: 'admins' })).toBe(true);
    expect(policyChangeMayRestrict({ openDriveRoleFloor: 'view' })).toBe(true);
    expect(policyChangeMayRestrict({ modelAllowlist: ['m1'] })).toBe(true);
    expect(policyChangeMayRestrict({ publishWeb: true, guests: 'on', whoCanCreateDrives: 'members', requireStrongSignIn: false, maximumSessionAgeMinutes: null, modelAllowlist: null, openDriveRoleFloor: 'edit' })).toBe(false);
  });

  it('X-1 (partial) verbs that can remove or suspend access need --yes: a tightening policy change, a role set to MEMBER, a declined guest', async () => {
    let called = false;
    const sdk = fakeSdk({
      organizations: {
        updatePolicies: async () => ((called = true), { policies: {}, changed: [], suspended: {}, restored: {}, blocked: {}, auditRecorded: true }),
        changeMemberRole: async () => ((called = true), { userId: 'u2', role: 'MEMBER' }),
        answerGuestApproval: async () => ((called = true), { decided: 'declined' }),
      },
    });
    for (const [handler, argv] of [
      [orgsSetPoliciesHandler, ['o1', 'publishWeb=off']],
      [orgsSetRoleHandler, ['o1', 'u2', 'MEMBER']],
      [orgsAnswerGuestHandler, ['o1', 'h1', 'decline']],
    ] as const) {
      const stderr = createRecordingSink();
      expect(await handler(createFakeContext({ sdk, stderr }), commandIntent([...argv]))).toBe(EXIT_RUNTIME_ERROR);
      expect(stderr.lines.join('')).toContain('--yes');
    }
    expect(called).toBe(false);
    // Opening things up, promoting and approving ask nothing.
    expect(await orgsSetPoliciesHandler(createFakeContext({ sdk }), commandIntent(['o1', 'publishWeb=on']))).toBe(EXIT_SUCCESS);
    expect(await orgsSetRoleHandler(createFakeContext({ sdk }), commandIntent(['o1', 'u2', 'ADMIN']))).toBe(EXIT_SUCCESS);
    expect(await orgsAnswerGuestHandler(createFakeContext({ sdk }), commandIntent(['o1', 'h1', 'approve']))).toBe(EXIT_SUCCESS);
  });

  it('X-1 (partial) destructive verbs refuse without --yes in a non-interactive session and never call the SDK', async () => {
    let called = false;
    const sdk = fakeSdk({
      organizations: {
        removeMember: async () => ((called = true), { removed: true }),
        leave: async () => ((called = true), { left: true }),
        deleteAutomation: async () => ((called = true), { deleted: true }),
      },
    });
    for (const [handler, argv] of [
      [orgsRemoveMemberHandler, ['o1', 'u2']],
      [orgsLeaveHandler, ['o1']],
      [orgsDeleteAutomationHandler, ['o1', 'workflow', 'w1']],
    ] as const) {
      const stderr = createRecordingSink();
      expect(await handler(createFakeContext({ sdk, stderr }), commandIntent([...argv]))).toBe(EXIT_RUNTIME_ERROR);
      expect(stderr.lines.join('')).toContain('--yes');
    }
    expect(called).toBe(false);

    const stdout = createRecordingSink();
    expect(await orgsRemoveMemberHandler(createFakeContext({ sdk, stdout }), commandIntent(['o1', 'u2', '--yes']))).toBe(EXIT_SUCCESS);
    expect(called).toBe(true);
    expect(stdout.lines.join('')).toBe('Removed u2 from o1.\n');
  });

  it('X-1 (partial) the server refusal (e.g. a key below the org sign-in policy) is printed and exits 1', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk({ organizations: { acceptInvitation: async () => { throw new Error('This organization requires a strong sign-in (org_strong_sign_in_required)'); } } }),
      stderr,
    });
    expect(await orgsAcceptInviteHandler(ctx, commandIntent(['tok']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('org_strong_sign_in_required');
  });

  it('X-1 (partial) audit maps its flags to the query; the export prints the CSV as-is', async () => {
    const calls: unknown[] = [];
    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk({
        organizations: {
          getAuditLog: async (input: unknown) => (calls.push(input), { entries: [], nextCursor: null }),
          exportAuditLog: async (input: unknown) => (calls.push(input), 'timestamp,category\n'),
        },
      }),
      stdout,
    });
    expect(await orgsAuditHandler(ctx, commandIntent(['o1', '--category', 'invites', '--limit', '20', '--before', '7']))).toBe(EXIT_SUCCESS);
    expect(await orgsAuditExportHandler(ctx, commandIntent(['o1', '--drive', 'd1']))).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([{ orgId: 'o1', category: 'invites', limit: 20, before: 7 }, { orgId: 'o1', driveId: 'd1' }]);
    expect(stdout.lines.join('')).toContain('timestamp,category\n');
    expect(await orgsAuditHandler(createFakeContext(), commandIntent(['o1', '--limit', 'ten']))).toBe(EXIT_USAGE_ERROR);
    expect(await orgsAuditExportHandler(createFakeContext(), commandIntent(['o1', '--limit', '10']))).toBe(EXIT_USAGE_ERROR);
  });

  it('X-1 (partial) verify-domain by email reports where the link went', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { verifyDomain: async () => ({ sentTo: 'postmaster@northwind.com', expiresAt: '2026-09-18T00:00:00.000Z' }) } }), stdout });
    expect(await orgsVerifyDomainHandler(ctx, commandIntent(['o1', 'dom1', 'email', 'postmaster']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('Sent a verification link to postmaster@northwind.com');
  });

  it('X-1 (partial) --json prints the raw answer', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { acceptInvitation: async () => ({ orgId: 'o1', role: 'MEMBER', joined: true }) } }), stdout });
    expect(await orgsAcceptInviteHandler(ctx, commandIntent(['tok', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual({ orgId: 'o1', role: 'MEMBER', joined: true });
  });
});
