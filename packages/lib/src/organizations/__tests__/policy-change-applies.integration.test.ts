/**
 * POL-1 end to end against a real Postgres and the real audit chain: "a change applies immediately; anything newly
 * forbidden is suspended, not deleted, and listed in the audit log". One org with a guest from outside, a live share
 * link, a published site and a published app. One policy change turns all four off; the very next request through
 * each real enforcement point is refused; the rows are all still there, marked; and the org's audit log lists every
 * one of them. Turning the policies back on restores exactly what was suspended.
 *
 * The two sign-in keys (requireStrongSignIn, maxSessionAgeHours) are decided at check time and suspend nothing; the
 * count of members they would block is lane S2's, so this test does not cover them.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/policy-change-applies.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgMembers, orgSubscriptions, organizations } from '@pagespace/db/schema/organizations';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveShareLinks } from '@pagespace/db/schema/share-links';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../../audit/security-audit';
import { queryOrgAuditEvents } from '../../audit/org-audit-query';
import { parseOrgAuditFilter } from '../../audit/org-audit-query-core';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';
import { redeemDriveShareLink } from '../../permissions/share-link-service';
import { getUserDriveAccess } from '../../permissions/permissions';
import { isPrefixVisible } from '../published-visibility';
import { defaultAppUnparkDeps } from '../../services/app-hosting/app-unpark';
import { updateOrgPolicies } from '../policies';
import { credentialActor } from '../../permissions/access-actor';

const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedEnv = new Map<string, string | undefined>();
const created = { users: [] as string[], drives: [] as string[], orgId: '' };

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

async function person() {
  const u = await factories.createUser();
  created.users.push(u.id);
  return u.id;
}

type Listed = { kind: string; type: string; id: string };
const listedIn = async (orgId: string, eventType: string): Promise<Listed[]> => {
  const parsed = parseOrgAuditFilter({ type: eventType, limit: '50' });
  if (!parsed.ok) throw new Error(parsed.error);
  const page = await queryOrgAuditEvents(orgId, parsed.filter);
  return page.entries.flatMap((e) => (e.details.listed as Listed[] | undefined) ?? []);
};

beforeAll(() => {
  for (const key of AUDIT_ENV) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
});

afterAll(async () => {
  if (created.drives.length) await db.delete(drives).where(inArray(drives.id, created.drives));
  if (created.orgId) {
    await db.delete(orgMembers).where(eq(orgMembers.orgId, created.orgId));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, created.orgId));
    await db.delete(organizations).where(eq(organizations.id, created.orgId));
  }
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

describe('a policy change', () => {
  it('POL-1 applies on the very next request, and what it newly forbids (guests, share links, publishing, published apps) is suspended, not deleted, and listed in the audit log', async () => {
    const run = createId().slice(0, 8);
    const owner = await person();
    const guest = await person();
    const redeemer = await person();
    const orgId = createId();
    created.orgId = orgId;
    await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${run}`, ownerId: owner });
    await factories.createOrgSubscription(orgId);
    await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });
    const drive = await factories.createDrive(owner);
    created.drives.push(drive.id);
    const subdomain = `nw-${run}`;
    await db.update(drives).set({ orgId, orgVisibility: 'OPEN', publishSubdomain: subdomain }).where(eq(drives.id, drive.id));

    // What exists before the change: a guest from outside, a live link, a published page, a published app.
    await db.insert(driveMembers).values({ driveId: drive.id, userId: guest, role: 'MEMBER', acceptedAt: new Date(), invitedBy: owner });
    const [link] = await db.insert(driveShareLinks).values({ driveId: drive.id, token: createId(), createdBy: owner }).returning();
    const page = await factories.createPage(drive.id, { isPrivate: false });
    const [published] = await db.insert(publishedPages).values({ driveId: drive.id, pageId: page.id, path: `p-${run}`, artifactKey: 'k', updatedAt: new Date() }).returning({ id: publishedPages.id });
    const envId = createId();
    await db.insert(driveEnvs).values({ id: envId, driveId: drive.id, name: `env-${envId}`, createdBy: owner, costOwnerId: null, sandboxId: `sbx-${envId}` });
    const appId = createId();
    await db.insert(publishedApps).values({
      id: appId, envId, driveId: drive.id, ownerId: owner, costOwnerId: owner, flyAppName: `pgs-${appId}`, networkName: 'published-apps',
      subdomain: `app-${appId}`.toLowerCase(), machineId: `m-${appId}`, imageDigest: 'sha256:abc', status: 'stopped', tier: 'metered', updatedAt: new Date(),
    });

    expect(await getUserDriveAccess(credentialActor(guest, null), drive.id)).toBe(true);
    expect(await isPrefixVisible(subdomain)).toBe(true);
    expect(await defaultAppUnparkDeps.publishedAppsAllowed(drive.id)).toBe(true);

    const changed = await updateOrgPolicies({ actorAuthentication: null, orgId, actorId: owner, patch: { guests: 'off', publicShareLinks: false, publishWeb: false, publishedApps: false } });
    expect(changed.ok).toBe(true);

    // The very next request, through each real enforcement point, is refused: no restart, no cache to expire.
    expect(await getUserDriveAccess(credentialActor(guest, null), drive.id)).toBe(false);
    expect(await redeemDriveShareLink(ctxFor(redeemer), link.token)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await isPrefixVisible(subdomain)).toBe(false);
    expect(await defaultAppUnparkDeps.publishedAppsAllowed(drive.id)).toBe(false);

    // Suspended, not deleted: every row is still there, marked (the app, which cannot be suspended, untouched).
    expect((await db.select().from(driveShareLinks).where(eq(driveShareLinks.id, link.id)))[0]).toMatchObject({ isActive: true, suspendedByPolicy: 'publicShareLinks' });
    expect((await db.select().from(publishedPages).where(eq(publishedPages.id, published.id)))[0].suspendedByPolicy).toBe('publishedPages');
    expect((await db.select().from(publishedApps).where(eq(publishedApps.id, appId)))[0].status).toBe('stopped');

    // Listed in the audit log: the change, each suspended item, and the app it now blocks.
    const changes = await queryOrgAuditEvents(orgId, (() => { const p = parseOrgAuditFilter({ type: 'org.policy.changed', limit: '10' }); if (!p.ok) throw new Error(p.error); return p.filter; })());
    expect(changes.entries).toHaveLength(1);
    expect((changes.entries[0].details.changes as Array<{ key: string }>).map((c) => c.key).sort()).toEqual(['guests', 'publicShareLinks', 'publishWeb', 'publishedApps']);
    const suspended = await listedIn(orgId, 'org.policy.suspended');
    expect(suspended.map((i) => i.kind).sort()).toEqual(['guests', 'publicShareLinks', 'publishedPages']);
    expect(suspended.find((i) => i.kind === 'publicShareLinks')?.id).toBe(link.id);
    expect(suspended.find((i) => i.kind === 'publishedPages')?.id).toBe(published.id);
    expect(await listedIn(orgId, 'org.policy.blocked')).toEqual([expect.objectContaining({ kind: 'publishedApps', type: 'published_app', id: appId })]);

    // Turning them back on restores exactly what was suspended, on the next request again.
    const restored = await updateOrgPolicies({ actorAuthentication: null, orgId, actorId: owner, patch: { guests: 'on', publicShareLinks: true, publishWeb: true, publishedApps: true } });
    expect(restored.ok).toBe(true);
    expect(await getUserDriveAccess(credentialActor(guest, null), drive.id)).toBe(true);
    expect(await isPrefixVisible(subdomain)).toBe(true);
    expect(await defaultAppUnparkDeps.publishedAppsAllowed(drive.id)).toBe(true);
    expect(await redeemDriveShareLink(ctxFor(redeemer), link.token)).toMatchObject({ ok: true });
    expect((await listedIn(orgId, 'org.policy.restored')).map((i) => i.kind).sort()).toEqual(['guests', 'publicShareLinks', 'publishedPages']);
  }, 60_000);
});
