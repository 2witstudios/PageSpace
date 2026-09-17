/**
 * Organizations & Wallets epic, Wave B1 — the org schema's constraints proven
 * against a REAL Postgres (a schema test cannot see whether a constraint
 * actually refuses a row). Uses the Northwind Labs fixture names; slugs carry a
 * cuid suffix because rows accumulate across a CI run.
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/db' test:integration -- organizations
 */
import { describe, it, expect, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '../test/factories';
import { db } from '../db';
import { users } from '../schema/auth';
import { drives } from '../schema/core';
import { driveMembers } from '../schema/members';
import { organizations, orgMembers, orgInvitations } from '../schema/organizations';

/** drizzle 0.45 wraps driver errors; the Postgres SQLSTATE lives on `.cause`. */
function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return pgCode(error);
  }
  return undefined;
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

describe('organizations schema (real Postgres)', () => {
  const createdUsers: string[] = [];
  const createdDrives: string[] = [];
  const createdOrgs: string[] = [];

  async function seedNorthwind() {
    const owner = await factories.createUser({ name: 'Jono' });
    createdUsers.push(owner.id);
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: owner.id })
      .returning();
    createdOrgs.push(org.id);
    return { owner, org };
  }

  async function seedDrive(ownerId: string, values: Partial<typeof drives.$inferInsert>) {
    const drive = await factories.createDrive(ownerId, values);
    createdDrives.push(drive.id);
    return drive;
  }

  afterEach(async () => {
    const driveIds = createdDrives.splice(0);
    if (driveIds.length) await db.delete(drives).where(inArray(drives.id, driveIds)).catch(() => {});
    const orgIds = createdOrgs.splice(0);
    if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds)).catch(() => {});
    const userIds = createdUsers.splice(0);
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds)).catch(() => {});
  });

  it('ORG-1 creates an org with an empty policy object and no Stripe customer by default', async () => {
    const { org, owner } = await seedNorthwind();
    expect(org.ownerId).toBe(owner.id);
    expect(org.policies).toEqual({});
    expect(org.stripeCustomerId).toBeNull();
  });

  it('ORG-1 refuses deleting a user who owns an org (ORG-6)', async () => {
    const { owner } = await seedNorthwind();
    expect(await sqlstateOf(() => db.delete(users).where(eq(users.id, owner.id)))).toBe(FK_VIOLATION);
  });

  it('ORG-2 lets one user join many orgs, but only once per org', async () => {
    const { org: northwind, owner } = await seedNorthwind();
    const { org: other } = await seedNorthwind();
    await db.insert(orgMembers).values({ orgId: northwind.id, userId: owner.id, role: 'OWNER' });
    await db.insert(orgMembers).values({ orgId: other.id, userId: owner.id });
    expect(
      await sqlstateOf(() => db.insert(orgMembers).values({ orgId: northwind.id, userId: owner.id, role: 'ADMIN' })),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('ORG-3 allows one open invite per org and email, and a new one once the old is accepted', async () => {
    const { org } = await seedNorthwind();
    const invite = (tokenHash: string) => ({
      orgId: org.id,
      email: 'priya.nair@northwind.test',
      role: 'ADMIN' as const,
      tokenHash,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [first] = await db.insert(orgInvitations).values(invite(createId())).returning();
    expect(await sqlstateOf(() => db.insert(orgInvitations).values(invite(createId())))).toBe(UNIQUE_VIOLATION);
    await db.update(orgInvitations).set({ acceptedAt: new Date() }).where(eq(orgInvitations.id, first.id));
    await db.insert(orgInvitations).values(invite(createId()));
  });

  it('DRV-1 refuses giving a Home drive an orgId (CHECK drives_home_never_org_check)', async () => {
    const { org, owner } = await seedNorthwind();
    expect(await sqlstateOf(() => seedDrive(owner.id, { kind: 'HOME', orgId: org.id }))).toBe(CHECK_VIOLATION);
    const home = await seedDrive(owner.id, { kind: 'HOME' });
    expect(
      await sqlstateOf(() => db.update(drives).set({ orgId: org.id }).where(eq(drives.id, home.id))),
    ).toBe(CHECK_VIOLATION);
  });

  it('DRV-1 refuses deleting an org that still owns drives, rather than orphaning them (ORG-6)', async () => {
    const { org, owner } = await seedNorthwind();
    await seedDrive(owner.id, { name: 'Product', slug: 'product', orgId: org.id });
    expect(await sqlstateOf(() => db.delete(organizations).where(eq(organizations.id, org.id)))).toBe(FK_VIOLATION);
  });

  it('DRV-1 keeps drive slugs unique within an org while personal drives may share a slug', async () => {
    const { org, owner } = await seedNorthwind();
    await seedDrive(owner.id, { name: 'Product', slug: 'product', orgId: org.id });
    expect(await sqlstateOf(() => seedDrive(owner.id, { name: 'Product', slug: 'product', orgId: org.id }))).toBe(
      UNIQUE_VIOLATION,
    );
    await seedDrive(owner.id, { name: 'Product', slug: 'product' });
    await seedDrive(owner.id, { name: 'Product', slug: 'product' });
  });

  it('DRV-4 defaults a drive to Open visibility', async () => {
    const { org, owner } = await seedNorthwind();
    const product = await seedDrive(owner.id, { name: 'Product', slug: 'product', orgId: org.id });
    expect(product.orgVisibility).toBe('OPEN');
    const finance = await seedDrive(owner.id, { name: 'Finance', slug: 'finance', orgId: org.id, orgVisibility: 'PRIVATE' });
    expect(finance.orgVisibility).toBe('PRIVATE');
  });

  it("DRV-8 records a directly added member (a guest) with source 'invite' by default", async () => {
    const { org, owner } = await seedNorthwind();
    const product = await seedDrive(owner.id, { name: 'Product', slug: 'product', orgId: org.id });
    const guest = await factories.createUser({ name: 'Chris Rowe' });
    createdUsers.push(guest.id);
    const member = await factories.createDriveMember(product.id, guest.id);
    expect(member.source).toBe('invite');
    const [materialized] = await db
      .insert(driveMembers)
      .values({ driveId: product.id, userId: owner.id, role: 'ADMIN', source: 'org' })
      .returning();
    expect(materialized.source).toBe('org');
  });
});
