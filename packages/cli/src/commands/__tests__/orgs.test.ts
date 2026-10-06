import { describe, expect, it } from 'vitest';
import { listOperations } from '@pagespace/sdk';
import {
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  buildOperationRegistry,
  directoryStanding,
  extractOrgArgs,
  extractOrgsListArgs,
  parseArgv,
  policyValueLabel,
  renderOrg,
  renderOrgDrives,
  renderOrgMembers,
  renderOrgPolicies,
  renderOrgsList,
  orgsDrivesHandler,
  orgsGetHandler,
  orgsListHandler,
  orgsMembersHandler,
  orgsPoliciesHandler,
} from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const ORGS_LIST = {
  organizations: [
    { id: 'o1', name: 'Northwind', slug: 'northwind', avatarUrl: null, role: 'MEMBER' as const, lapsed: false },
    { id: 'o2', name: 'Ampersand', slug: 'amp', avatarUrl: null, role: 'ADMIN' as const, lapsed: true },
  ],
};

const ORG = {
  organization: { id: 'o1', name: 'Northwind', slug: 'northwind', avatarUrl: null, ownerId: 'u1', createdAt: '2026-09-01T12:00:00.000Z' },
  viewer: { userId: 'u2', role: 'MEMBER' as const },
  billingNotice: { kind: 'read_only', canManageBilling: false },
};

const MEMBERS = {
  members: [
    { userId: 'u1', role: 'OWNER' as const, joinedAt: '2026-09-01T12:00:00.000Z', name: 'Jono', email: 'j@pagespace.co', image: null },
    { userId: 'u2', role: 'MEMBER' as const, joinedAt: '2026-09-03T12:00:00.000Z', name: 'Lena', email: 'l@pagespace.co', image: null },
  ],
};

const DRIVES = {
  drives: [
    { id: 'd1', name: 'Research', slug: 'research', orgVisibility: 'RESTRICTED' as const, joined: false, joinRequest: null, canRequest: true, lead: { id: 'u1', name: 'Jono', image: null } },
    { id: 'd2', name: 'Company Home', slug: 'home', orgVisibility: 'OPEN' as const, joined: true, joinRequest: null, canRequest: false, lead: { id: 'u1', name: null, image: null } },
    { id: 'd3', name: 'Private Portion', slug: 'private', orgVisibility: 'PRIVATE' as const, joined: false, joinRequest: 'pending' as const, canRequest: false, lead: { id: 'u1', name: 'Jono', image: null } },
  ],
};

const POLICIES = {
  policies: {
    guests: 'approve' as const,
    publicShareLinks: false,
    publishWeb: true,
    customDomains: true,
    whoCanInvite: 'admins' as const,
    whoCanCreateDrives: 'members' as const,
    openDriveRoleFloor: 'view' as const,
    seatAllowanceCents: 3000,
    walletFallback: 'refuse' as const,
    modelAllowlist: ['m1'],
    providerAllowlist: null,
    agentsAutonomous: true,
    crossDriveAgents: true,
    cloudSandbox: true,
    persistentEnvironments: true,
    publishedApps: false,
    integrationsAllowlist: [] as string[],
  },
};

describe('orgs argv', () => {
  it('X-1 (partial) orgs list takes nothing; the org verbs take exactly one <orgId>', () => {
    expect(extractOrgsListArgs([]).ok).toBe(true);
    expect(extractOrgsListArgs(['o1']).ok).toBe(false);

    expect(extractOrgArgs(['o1'])).toEqual({ ok: true, value: { orgId: 'o1' } });
    expect(extractOrgArgs([]).ok).toBe(false);
    expect(extractOrgArgs(['o1', 'o2']).ok).toBe(false);
    expect(extractOrgArgs(['--flag']).ok).toBe(false);
  });
});

describe('orgs rendering', () => {
  it('X-1 (partial) lists orgs with role and lapse, empty as its own line', () => {
    const text = renderOrgsList({ organizations: ORGS_LIST.organizations });
    expect(text).toContain('2 organizations:');
    expect(text).toContain('o1  [MEMBER]  Northwind (northwind)');
    expect(text).toContain('o2  [ADMIN]  Ampersand (amp)  · lapsed: read-only');
    expect(renderOrgsList({ organizations: [] })).toBe('You belong to no organization.\n');
  });

  it('X-1 (partial) renders the org, its viewer role, and the billing notice kind when present', () => {
    const text = renderOrg(ORG);
    expect(text).toContain('Northwind (northwind)  o1');
    expect(text).toContain('your role: MEMBER');
    expect(text).toContain('billing notice: read_only');
    const quiet = renderOrg({ ...ORG, billingNotice: undefined });
    expect(quiet).not.toContain('billing notice');
  });

  it('X-1 (partial) renders members with role, name, email and join date', () => {
    const text = renderOrgMembers(MEMBERS);
    expect(text).toContain('2 members:');
    expect(text).toContain('[OWNER]  Jono <j@pagespace.co>  u1  joined 2026-09-01');
    expect(renderOrgMembers({ members: [] })).toBe('No members.\n');
  });

  it('X-1 (partial) renders the directory with visibility and standing per drive (DRV-6)', () => {
    expect(directoryStanding(DRIVES.drives[0])).toBe('can request to join');
    expect(directoryStanding(DRIVES.drives[1])).toBe('joined');
    expect(directoryStanding(DRIVES.drives[2])).toBe('join request pending');
    const text = renderOrgDrives(DRIVES);
    expect(text).toContain('Restricted  d1  Research (research)  can request to join  lead: Jono');
    expect(text).toContain('Open  d2  Company Home (home)  joined  lead: u1');
    expect(text).toContain('Private  d3  Private Portion (private)  join request pending');
    expect(renderOrgDrives({ drives: [] })).toContain('No drives');
  });

  it('X-1 (partial) renders every policy key; null, empty allowlist, booleans as words', () => {
    const text = renderOrgPolicies(POLICIES);
    expect(text).toContain('guests: approve');
    expect(text).toContain('publicShareLinks: off');
    expect(text).toContain('seatAllowanceCents: 3000');
    expect(text).toContain('modelAllowlist: m1');
    expect(text).toContain('providerAllowlist: (none)');
    expect(text).toContain('integrationsAllowlist: (nothing allowed)');
    expect(text).toContain('publishedApps: off');
    expect(Object.keys(POLICIES.policies).length).toBe((text.match(/^\s{2}\w/gm) ?? []).length);
  });

  it('X-1 (partial) policyValueLabel handles every shape', () => {
    expect(policyValueLabel(null)).toBe('(none)');
    expect(policyValueLabel([])).toBe('(nothing allowed)');
    expect(policyValueLabel(['a', 'b'])).toBe('a, b');
    expect(policyValueLabel(true)).toBe('on');
    expect(policyValueLabel(false)).toBe('off');
    expect(policyValueLabel(42)).toBe('42');
    expect(policyValueLabel('approve')).toBe('approve');
  });
});

describe('pagespace orgs list', () => {
  it('X-1 (partial) lists my orgs, or prints JSON with --json', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { list: async () => ORGS_LIST } }), stdout });
    expect(await orgsListHandler(ctx, commandIntent([]))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('[MEMBER]  Northwind');
  });

  it('X-1 (partial) refuses stray arguments with usage', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });
    expect(await orgsListHandler(ctx, commandIntent(['extra']))).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('Usage: pagespace orgs list');
  });
});

describe('pagespace orgs get|members|drives|policies', () => {
  it('X-1 (partial) reads the org detail and prints it', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { get: async ({ orgId }: { orgId: string }) => (expect(orgId).toBe('o1'), ORG) } }), stdout });
    expect(await orgsGetHandler(ctx, commandIntent(['o1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('your role: MEMBER');
  });

  it('X-1 (partial) lists the members of the org named', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { listMembers: async ({ orgId }: { orgId: string }) => (expect(orgId).toBe('o1'), MEMBERS) } }), stdout });
    expect(await orgsMembersHandler(ctx, commandIntent(['o1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('[OWNER]  Jono');
  });

  it('X-1 (partial) lists the drive directory of the org named', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { listDrives: async () => DRIVES } }), stdout });
    expect(await orgsDrivesHandler(ctx, commandIntent(['o1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('Restricted  d1  Research');
  });

  it('X-1 (partial) reads the policies of the org named', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { getPolicies: async () => POLICIES } }), stdout });
    expect(await orgsPoliciesHandler(ctx, commandIntent(['o1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('guests: approve');
  });

  it('X-1 (partial) a missing org is a runtime error, not a crash', async () => {
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { get: async () => { throw new Error('Organization not found'); } } }), stderr });
    expect(await orgsGetHandler(ctx, commandIntent(['nope']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Organization not found');
  });

  it('X-1 (partial) each verb demands exactly one <orgId>', async () => {
    for (const [verb, handler] of [['members', orgsMembersHandler], ['drives', orgsDrivesHandler], ['policies', orgsPoliciesHandler]] as const) {
      const stderr = createRecordingSink();
      const ctx = createFakeContext({ stderr });
      expect(await handler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
      expect(stderr.lines.join('')).toContain('Usage: pagespace orgs get|members|drives|policies <orgId>');
    }
  });

  it('X-1 (partial) --json prints the raw payload', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk({ organizations: { getPolicies: async () => POLICIES } }), stdout });
    expect(await orgsPoliciesHandler(ctx, commandIntent(['o1', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.lines.join(''))).toEqual(POLICIES);
  });
});

describe('pagespace mcp — org tools', () => {
  it('X-1 (partial) serves the five org reads and no org write', () => {
    const orgOps = listOperations(buildOperationRegistry()).filter((op) => op.name.startsWith('organizations.'));
    expect(orgOps.map((op) => op.name).sort()).toEqual([
      'organizations.get',
      'organizations.getPolicies',
      'organizations.list',
      'organizations.listDrives',
      'organizations.listMembers',
    ]);
    expect(orgOps.every((op) => op.method === 'GET')).toBe(true);
  });
});
