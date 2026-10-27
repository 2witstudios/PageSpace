/**
 * Org writes over an MCP key (Spec X-1) obey the org's sign-in policy (SEC-2/3, D-OW-43: web, CLI and
 * MCP obey the same policy) against a REAL Postgres: the org, its members, its stored policies, the org
 * drive and the services are real; only the credential is faked (an MCP key or a session carrying the
 * server-verified evidence it would carry). The policy is read from the org row at the moment of the
 * request, so the refusal follows the stored policy, never a cached one.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import type { MCPAuthResult, SessionAuthResult } from '@/lib/auth';
import type { VerifiedAuthentication } from '@pagespace/lib/auth/authentication-evidence';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getAllowedDriveIds: (auth: { allowedDriveIds?: string[] }) => auth.allowedDriveIds ?? [],
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/organizations/org-change-events', () => ({ announceOrgChange: vi.fn(async () => {}) }));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { resetAuditDbBindingForTests } from '@pagespace/lib/audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '@pagespace/lib/audit/security-audit';
import { PATCH as patchOrg } from '../[orgId]/route';
import { PATCH as patchPolicies } from '../[orgId]/policies/route';
import { POST as requestToJoin } from '../../drives/[driveId]/join-requests/route';

/** The policy write audits through the org chain: pin it to the main db, as the audit route suite does. */
const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
function pinAuditToMainDb(): () => void {
  const saved = new Map<string, string | undefined>(AUDIT_ENV.map((key) => [key, process.env[key]]));
  for (const key of AUDIT_ENV) delete process.env[key];
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditDbBindingForTests();
    resetDefaultSecurityAuditForTests();
  };
}

const created = { orgs: [] as string[], users: [] as string[] };

const passkeyNow = (): VerifiedAuthentication => ({ authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' });
const magicLinkNow = (): VerifiedAuthentication => ({ authenticatedAtMs: Date.now(), assurance: 'single_factor' });
const key = (userId: string, authentication: VerifiedAuthentication | null, allowedDriveIds: string[] = []): MCPAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'mcp', tokenId: `tok_${createId()}`, role: 'user', adminRoleVersion: 0, allowedDriveIds,
  ...(authentication ? { authentication } : {}),
});
const session = (userId: string, authentication: VerifiedAuthentication): SessionAuthResult => ({
  userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0, authentication,
});
const as = (auth: MCPAuthResult | SessionAuthResult) => vi.mocked(authenticateRequestWithOptions).mockResolvedValue(auth);

async function northwind() {
  const [owner, member] = await Promise.all(['Jono', 'Marcus'].map((n) => factories.createUser({ name: n })));
  created.users.push(owner.id, member.id);
  const [org] = await db.insert(organizations).values({
    name: 'Northwind', slug: `northwind-${createId()}`, ownerId: owner.id,
    policies: { requireStrongSignIn: true },
  }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: owner.id, role: 'OWNER' },
    { orgId: org.id, userId: member.id, role: 'MEMBER' },
  ]);
  const research = await factories.createDrive(owner.id, { orgId: org.id, orgVisibility: 'RESTRICTED' });
  return { orgId: org.id, owner, member, research };
}

const json = (method: string, url: string, body: unknown) =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const orgCtx = (orgId: string) => ({ params: Promise.resolve({ orgId }) });

describe('X-1 (partial) SEC-2 (partial) org writes over an MCP key obey the org sign-in policy (real Postgres)', () => {
  let dbAvailable = false;
  let restoreAudit: () => void = () => {};

  beforeAll(async () => {
    restoreAudit = pinAuditToMainDb();
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-token-sign-in-policy.integration.test.ts', error);
    }
    vi.mocked(isAuthError).mockImplementation((result) => 'error' in result);
  });

  afterAll(async () => {
    restoreAudit();
    if (!dbAvailable) return;
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(drives).where(inArray(drives.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('an Owner key without passkey evidence cannot rename the org; the same Owner with a fresh passkey key can', async () => {
    if (!dbAvailable) return;
    const north = await northwind();
    const rename = (name: string) => patchOrg(json('PATCH', `https://x.test/api/orgs/${north.orgId}`, { name }), orgCtx(north.orgId));

    as(key(north.owner.id, magicLinkNow()));
    const weak = await rename('Renamed by a weak key');
    expect(weak.status).toBe(403);
    expect((await weak.json()).code).toBe('org_strong_sign_in_required');
    expect(auditRequest).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ eventType: 'authz.access.denied', resourceId: north.orgId, details: { reason: 'org_strong_sign_in_required' } }));

    as(key(north.owner.id, null));
    expect((await (await rename('Renamed by a key with no evidence')).json()).code).toBe('org_strong_sign_in_required');

    as(key(north.owner.id, passkeyNow(), [north.research.id]));
    expect((await (await rename('Renamed by a scoped key')).json()).code).toBe('token_scope_refused');

    const [before] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, north.orgId));
    expect(before.name).toBe('Northwind');

    as(key(north.owner.id, passkeyNow()));
    expect((await rename('Northwind Labs')).status).toBe(200);
    const [after] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, north.orgId));
    expect(after.name).toBe('Northwind Labs');
  });

  it('a weak credential cannot change the policies, key or session alike; a passkey credential can', async () => {
    if (!dbAvailable) return;
    const north = await northwind();
    // A restricting change, which even a lapsed (unsubscribed, as here) org may make ([D-OW-33]).
    const tighten = () => patchPolicies(json('PATCH', `https://x.test/api/orgs/${north.orgId}/policies`, { maximumSessionAgeMinutes: 60 }), orgCtx(north.orgId));

    as(key(north.owner.id, magicLinkNow()));
    expect((await tighten()).status).toBe(403);
    as(session(north.owner.id, magicLinkNow()));
    expect((await tighten()).status).toBe(403);
    const [still] = await db.select({ policies: organizations.policies }).from(organizations).where(eq(organizations.id, north.orgId));
    expect(still.policies).toEqual({ requireStrongSignIn: true });

    as(key(north.owner.id, passkeyNow()));
    const ok = await tighten();
    expect(ok.status).toBe(200);
    expect((await ok.json()).policies).toMatchObject({ requireStrongSignIn: true, maximumSessionAgeMinutes: 60 });
  });

  it("a member's key below the drive's org policy cannot ask to join a Restricted drive; with a passkey it can", async () => {
    if (!dbAvailable) return;
    const north = await northwind();
    const ask = () => requestToJoin(json('POST', `https://x.test/api/drives/${north.research.id}/join-requests`, {}), { params: Promise.resolve({ driveId: north.research.id }) });

    as(key(north.member.id, magicLinkNow()));
    const weak = await ask();
    expect(weak.status).toBe(403);
    expect((await weak.json()).code).toBe('org_strong_sign_in_required');
    expect(await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.driveId, north.research.id))).toHaveLength(0);

    as(key(north.member.id, passkeyNow()));
    expect((await ask()).status).toBe(201);
  });
});
