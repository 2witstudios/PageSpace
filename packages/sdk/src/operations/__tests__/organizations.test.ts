/**
 * `operations/organizations.ts` (Spec X-1) — the five org READ operations. The
 * decision parts live in the schemas: inputs are strict (an unknown argument
 * fails before the network), outputs are open-world (an unknown field is
 * stripped, never rejected, per ADR 0001 D5) while every declared field keeps
 * its type. Drift vs `@pagespace/lib` is pinned separately in
 * `organizations-drift-guard.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  getOrgPolicies,
  getOrganization,
  listMyOrganizations,
  listOrgDriveDirectory,
  listOrgMembers,
} from '../organizations.js';

const SUMMARY = {
  id: 'o1',
  name: 'Northwind',
  slug: 'northwind',
  avatarUrl: null,
  role: 'MEMBER',
  lapsed: false,
};

const ORG_DETAIL = {
  organization: { id: 'o1', name: 'Northwind', slug: 'northwind', avatarUrl: null, ownerId: 'u1', createdAt: '2026-09-01T00:00:00.000Z' },
  viewer: { userId: 'u2', role: 'MEMBER' },
  billingNotice: { kind: 'read_only', canManageBilling: false },
};

const MEMBERS = {
  members: [{ userId: 'u1', role: 'OWNER', joinedAt: '2026-09-01T00:00:00.000Z', name: 'Jono', email: 'j@pagespace.co', image: null }],
};

const DIRECTORY = {
  drives: [
    {
      id: 'd1',
      name: 'Research',
      slug: 'research',
      orgVisibility: 'RESTRICTED',
      joined: false,
      joinRequest: null,
      canRequest: true,
      lead: { id: 'u1', name: 'Jono', image: null },
    },
  ],
};

const POLICIES = {
  policies: {
    guests: 'approve',
    publicShareLinks: true,
    publishWeb: true,
    customDomains: true,
    whoCanInvite: 'admins',
    whoCanCreateDrives: 'members',
    openDriveRoleFloor: 'view',
    seatAllowanceCents: 3000,
    walletFallback: 'refuse',
    modelAllowlist: null,
    providerAllowlist: null,
    agentsAutonomous: true,
    crossDriveAgents: true,
    cloudSandbox: true,
    persistentEnvironments: true,
    publishedApps: true,
    integrationsAllowlist: null,
  },
};

describe('operations/organizations.ts — the five org reads', () => {
  it('X-1 (partial) all five are GETs on the org routes with account scope', () => {
    expect(listMyOrganizations.method).toBe('GET');
    expect(listMyOrganizations.path).toBe('/api/orgs');
    expect(getOrganization.path).toBe('/api/orgs/:orgId');
    expect(listOrgMembers.path).toBe('/api/orgs/:orgId/members');
    expect(listOrgDriveDirectory.path).toBe('/api/orgs/:orgId/drives');
    expect(getOrgPolicies.path).toBe('/api/orgs/:orgId/policies');
    for (const op of [listMyOrganizations, getOrganization, listOrgMembers, listOrgDriveDirectory, getOrgPolicies]) {
      expect(op.requiredScope, op.name).toBe('account');
      expect(op.method, op.name).toBe('GET');
      expect(op.description.length, op.name).toBeGreaterThan(0);
    }
  });

  it('X-1 (partial) reads only: the file declares no non-GET operation', async () => {
    const source = await import('node:fs').then((fs) => fs.promises.readFile(new URL('../organizations.ts', import.meta.url), 'utf-8'));
    const methods = [...source.matchAll(/method: '(\w+)'/g)].map((m) => m[1]);
    expect(methods.length).toBe(5);
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });

  it('X-1 (partial) orgs.list parses the route response and strips unknown fields', () => {
    const parsed = listMyOrganizations.outputSchema.parse({ organizations: [{ ...SUMMARY, someFutureField: 1 }] });
    expect(parsed).toEqual({ organizations: [SUMMARY] });
  });

  it('X-1 (partial) orgs.get keeps the billing notice without vouching for its shape', () => {
    const parsed = getOrganization.outputSchema.parse(ORG_DETAIL);
    expect(parsed.viewer).toEqual({ userId: 'u2', role: 'MEMBER' });
    expect(parsed.billingNotice).toEqual({ kind: 'read_only', canManageBilling: false });
    expect(getOrganization.outputSchema.safeParse({ ...ORG_DETAIL, billingNotice: { kind: 'something_new' } }).success).toBe(true);
  });

  it('X-1 (partial) members.list requires every roster field and rejects a malformed role', () => {
    expect(listOrgMembers.outputSchema.safeParse(MEMBERS).success).toBe(true);
    expect(listOrgMembers.outputSchema.safeParse({ members: [{ ...MEMBERS.members[0], role: 'LEAD' }] }).success).toBe(false);
  });

  it('X-1 (partial) the directory entry types a Restricted drive line exactly (DRV-6)', () => {
    const parsed = listOrgDriveDirectory.outputSchema.parse(DIRECTORY);
    expect(parsed.drives[0]).toEqual(DIRECTORY.drives[0]);
    expect(parsed.drives[0].joinRequest).toBeNull();
    expect(listOrgDriveDirectory.outputSchema.safeParse({ drives: [{ ...DIRECTORY.drives[0], orgVisibility: 'SECRET' }] }).success).toBe(false);
  });

  it('X-1 (partial) policies parse with every key present (defaults filled in server-side)', () => {
    expect(getOrgPolicies.outputSchema.safeParse(POLICIES).success).toBe(true);
    expect(getOrgPolicies.outputSchema.safeParse({ policies: { ...POLICIES.policies, guests: 'sometimes' } }).success).toBe(false);
  });

  it('X-1 (partial) inputs are strict: an unknown argument is a client-side validation error', () => {
    expect(listMyOrganizations.inputSchema.safeParse({ extra: true }).success).toBe(false);
    expect(getOrganization.inputSchema.safeParse({ orgId: 'o1', extra: true }).success).toBe(false);
    expect(listOrgMembers.inputSchema.safeParse({}).success).toBe(false);
  });
});
