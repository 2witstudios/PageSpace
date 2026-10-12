// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import type { AuthResult } from '../index';
import {
  canPrincipalViewPage, getPrincipalDriveAccess, getPrincipalDriveIds, getPrincipalBatchPagePermissions,
} from '../principal-permissions';

const userIds: string[] = [];
const orgIds: string[] = [];

async function fixture() {
  const owner = await factories.createUser();
  userIds.push(owner.id);
  const [org] = await db.insert(organizations).values({ name: 'Policy test', slug: createId(), ownerId: owner.id,
    policies: { requireStrongSignIn: true, maximumSessionAgeMinutes: 15 },
  }).returning();
  orgIds.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: 'OWNER' });
  const drive = await factories.createDrive(owner.id, { orgId: org.id, orgVisibility: 'OPEN' });
  const page = await factories.createPage(drive.id);
  const personal = await factories.createDrive(owner.id);
  const personalPage = await factories.createPage(personal.id);
  const auth: AuthResult = { tokenType: 'session', userId: owner.id, sessionId: createId(), role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
  return { org, drive, page, personal, personalPage, auth };
}

afterEach(async () => {
  if (orgIds.length) await db.delete(drives).where(inArray(drives.orgId, orgIds));
  if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds.splice(0)));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

describe('SEC-2 (partial) SEC-3 (partial) organization credential policy against PostgreSQL', () => {
  it('denies org content to an old credential while preserving its personal access and permitting a separate fresh credential', async () => {
    const f = await fixture();
    const old: AuthResult = { ...f.auth, authentication: { authenticatedAtMs: Date.now() - 3600000, assurance: 'user_verified_passkey' } };
    const fresh: AuthResult = { ...f.auth, sessionId: createId(), authentication: { authenticatedAtMs: Date.now(), assurance: 'user_verified_passkey' } };
    expect(await canPrincipalViewPage(old, f.page.id)).toBe(false);
    expect(await getPrincipalDriveAccess(old, f.drive.id)).toBe(false);
    expect(await canPrincipalViewPage(old, f.personalPage.id)).toBe(true);
    expect(await canPrincipalViewPage(fresh, f.page.id)).toBe(true);
    expect(await canPrincipalViewPage(old, f.page.id)).toBe(false);
    expect(await getPrincipalDriveIds(old)).not.toContain(f.drive.id);
    expect(await getPrincipalDriveIds(old)).toContain(f.personal.id);
    const batch = await getPrincipalBatchPagePermissions(old, [f.page.id, f.personalPage.id]);
    expect(batch.get(f.page.id)?.canView).toBe(false);
    expect(batch.get(f.personalPage.id)?.canView).toBe(true);
  });

  it('applies policy changes immediately and never treats a magic link as strong sign-in', async () => {
    const f = await fixture();
    const magic: AuthResult = { ...f.auth, authentication: { authenticatedAtMs: Date.now(), assurance: 'single_factor' } };
    expect(await canPrincipalViewPage(magic, f.page.id)).toBe(false);
    await db.update(organizations).set({ policies: { requireStrongSignIn: false, maximumSessionAgeMinutes: 15 } }).where(eq(organizations.id, f.org.id));
    expect(await canPrincipalViewPage(magic, f.page.id)).toBe(true);
    expect(await canPrincipalViewPage(f.auth, f.page.id)).toBe(false);
    await db.update(organizations).set({ policies: {} }).where(eq(organizations.id, f.org.id));
    expect(await canPrincipalViewPage(f.auth, f.page.id)).toBe(true);
  });
});
