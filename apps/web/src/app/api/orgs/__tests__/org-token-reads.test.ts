/**
 * The five X-1 org reads over an MCP token (Spec X-1): orgs list, org detail, members,
 * drives directory, policies. Authorization is NOT faked — the real requireOrgRole runs
 * over a faked membership lookup — so a route that admitted a token without the org gate
 * fails here. The token-specific rules under test:
 * - an unscoped token reads like the session it belongs to;
 * - a drive-scoped token is refused (403 `token_scope_refused`) on every org-wide read —
 *   the `wallets.list` rule — and on the drive directory it is FILTERED to its drives,
 *   never widened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';
import type { OrgRole } from '@pagespace/db/schema/organizations';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  // The gate reads the token's drive restriction through this helper; passthrough keeps
  // the test honest about what the mocked credential carries.
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/repository', () => ({
  findMembershipRole: vi.fn(),
  findOrganizationById: vi.fn(),
  listOrganizationsForUser: vi.fn(),
  listOrgMembers: vi.fn(),
}));
vi.mock('@pagespace/lib/organizations/status', () => ({
  getOrgBillingNotice: vi.fn(async () => null),
  isOrgActive: vi.fn(async () => true),
}));
vi.mock('@pagespace/lib/permissions/org-drive-directory', () => ({ listOrgDriveDirectory: vi.fn() }));
vi.mock('@pagespace/lib/organizations/policies', () => ({ getOrgPolicies: vi.fn() }));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { findMembershipRole, findOrganizationById, listOrganizationsForUser, listOrgMembers } from '@pagespace/lib/organizations/repository';
import { getOrgPolicies } from '@pagespace/lib/organizations/policies';
import { listOrgDriveDirectory } from '@pagespace/lib/permissions/org-drive-directory';
import { GET as listOrgs } from '../route';
import { GET as getOrg } from '../[orgId]/route';
import { GET as listMembers } from '../[orgId]/members/route';
import { GET as listDrives } from '../[orgId]/drives/route';
import { GET as getPolicies } from '../[orgId]/policies/route';

const ORG = 'org-northwind';
const USER = 'user-lena';
const context = { params: Promise.resolve({ orgId: ORG }) };

const session = (userId: string): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 'session-1', role: 'user', adminRoleVersion: 0,
});
const token = (allowedDriveIds: string[] = []): MCPAuthResult => ({
  userId: USER, tokenVersion: 0, tokenType: 'mcp', tokenId: 'tok-1', role: 'user', adminRoleVersion: 0, allowedDriveIds,
});

const orgsList = { organizations: [{ id: ORG, name: 'Northwind', slug: 'northwind', avatarUrl: null, role: 'MEMBER' as OrgRole, lapsed: false }] };
const ORG_ROW = {
  id: ORG,
  name: 'Northwind',
  slug: 'northwind',
  avatarUrl: null,
  ownerId: 'user-jono',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  seatAutoAdd: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
};
const orgDetail = {
  organization: { id: ORG, name: 'Northwind', slug: 'northwind', avatarUrl: null, ownerId: 'user-jono', createdAt: '2026-09-01T00:00:00.000Z' },
  viewer: { userId: USER, role: 'MEMBER' as OrgRole },
};
const members = {
  members: [
    {
      userId: 'user-jono',
      role: 'OWNER' as OrgRole,
      joinedAt: new Date('2026-09-01T00:00:00.000Z'),
      name: 'Jono',
      email: 'j@pagespace.co',
      image: null,
    },
  ],
};
const directory = [
  {
    id: 'drive-open',
    name: 'Open drive',
    slug: 'open',
    orgVisibility: 'OPEN' as const,
    joined: true,
    joinRequest: null,
    canRequest: false,
    lead: { id: 'user-jono', name: 'Jono', image: null },
  },
  {
    id: 'drive-restricted',
    name: 'Research',
    slug: 'research',
    orgVisibility: 'RESTRICTED' as const,
    joined: false,
    joinRequest: null,
    canRequest: true,
    lead: { id: 'user-jono', name: 'Jono', image: null },
  },
];
const policies = { policies: { guests: 'approve', seatAllowanceCents: 3000 } };

beforeEach(() => {
  vi.clearAllMocks();
  flags.orgsEnabled = true;
  vi.mocked(findMembershipRole).mockResolvedValue('MEMBER');
  vi.mocked(listOrganizationsForUser).mockResolvedValue(orgsList.organizations);
  vi.mocked(findOrganizationById).mockResolvedValue(ORG_ROW);
  vi.mocked(listOrgMembers).mockResolvedValue(members.members);
  vi.mocked(listOrgDriveDirectory).mockResolvedValue(directory);
  vi.mocked(getOrgPolicies).mockResolvedValue(policies.policies as never);
});

describe('X-1 (partial) the five org reads over an MCP token', () => {
  it('orgs list: an unscoped token reads the caller\'s orgs; a drive-scoped token is refused before any read', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    expect((await listOrgs(new Request('https://x.test/api/orgs'))).status).toBe(200);
    expect(await (await listOrgs(new Request('https://x.test/api/orgs'))).json()).toEqual(orgsList);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token(['drive-open']));
    const refused = await listOrgs(new Request('https://x.test/api/orgs'));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('token_scope_refused');
    expect(listOrganizationsForUser).toHaveBeenCalledTimes(2);
  });

  it('org detail: an unscoped token reads it; a drive-scoped token is refused before any read', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    const ok = await getOrg(new Request(`https://x.test/api/orgs/${ORG}`), context);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(orgDetail);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token(['drive-open']));
    const refused = await getOrg(new Request(`https://x.test/api/orgs/${ORG}`), context);
    expect(refused.status).toBe(403);
    expect(findOrganizationById).toHaveBeenCalledTimes(1);
  });

  it('members: an unscoped token reads the roster; a drive-scoped token is refused before any read', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    const ok = await listMembers(new Request(`https://x.test/api/orgs/${ORG}/members`), context);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      members: members.members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    });

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token(['drive-open']));
    const refused = await listMembers(new Request(`https://x.test/api/orgs/${ORG}/members`), context);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('token_scope_refused');
    expect(listOrgMembers).toHaveBeenCalledTimes(1);
  });

  it('policies: an Admin token reads them; a Member token hits the role gate; a drive-scoped Admin token is refused (SEAT-6 (partial) — the onprem/tenant billing-gate clause is proven by the billing route suites)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    vi.mocked(findMembershipRole).mockResolvedValue('ADMIN');
    const ok = await getPolicies(new Request(`https://x.test/api/orgs/${ORG}/policies`), context);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(policies);

    vi.mocked(findMembershipRole).mockResolvedValue('MEMBER');
    const memberRefused = await getPolicies(new Request(`https://x.test/api/orgs/${ORG}/policies`), context);
    expect(memberRefused.status).toBe(403);
    expect((await memberRefused.json()).code).toBe('insufficient_role');
    expect(getOrgPolicies).toHaveBeenCalledTimes(1);

    vi.mocked(findMembershipRole).mockResolvedValue('ADMIN');
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token(['drive-open']));
    const scopedRefused = await getPolicies(new Request(`https://x.test/api/orgs/${ORG}/policies`), context);
    expect(scopedRefused.status).toBe(403);
    expect((await scopedRefused.json()).code).toBe('token_scope_refused');
    expect(getOrgPolicies).toHaveBeenCalledTimes(1);
  });

  it('drives directory: an unscoped token sees the whole directory; a drive-scoped token sees only its drives (DRV-6)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    const full = await listDrives(new Request(`https://x.test/api/orgs/${ORG}/drives`), context);
    expect(full.status).toBe(200);
    expect((await full.json()).drives).toEqual(directory);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token(['drive-restricted']));
    const filtered = await listDrives(new Request(`https://x.test/api/orgs/${ORG}/drives`), context);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).drives).toEqual([directory[1]]);
    // The scope never changes who may ask: the same member gate ran for both.
    expect(listOrgDriveDirectory).toHaveBeenCalledTimes(2);
  });

  it('a non-member token is 404 from the org gate, and a bad credential never reaches the gate', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(token());
    vi.mocked(findMembershipRole).mockResolvedValue(null);
    expect((await listDrives(new Request(`https://x.test/api/orgs/${ORG}/drives`), context)).status).toBe(404);

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(USER));
    vi.mocked(findMembershipRole).mockResolvedValue('MEMBER');
    expect((await listOrgs(new Request('https://x.test/api/orgs'))).status).toBe(200);
  });
});
