/**
 * Northwind Labs (Sequence Spec fixture) for the org-aware drive resolver suites, with every membership
 * shape the resolvers must tell apart. Shared by org-drive-resolvers.integration.test.ts (B7) and
 * org-drive-sibling-resolvers.integration.test.ts (B7b).
 */
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

export async function createUser(name: string) {
  const user = await factories.createUser({ name });
  createdUserIds.push(user.id);
  return user;
}

export async function createOrg(name: string, ownerId: string) {
  const [org] = await db.insert(organizations).values({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${createId()}`, ownerId }).returning();
  createdOrgIds.push(org.id);
  return org;
}

/**
 * Northwind Labs (Sequence Spec fixture), with every membership shape the resolvers must tell apart.
 * Lena leads every Northwind drive, so the org Owner (Jono) and Admin (Priya) reach them only
 * through org power, never through drives.ownerId.
 */
export async function northwind() {
  const jono = await createUser('Jono');
  const priya = await createUser('Priya Nair');
  const omar = await createUser('Omar Haddad');
  const lena = await createUser('Lena Park');
  const marcus = await createUser('Marcus Oyelaran');
  const nina = await createUser('Nina Brandt');
  const eve = await createUser('Eve Santos');
  const chris = await createUser('Chris Rowe');
  const dana = await createUser('Dana Whit');
  const fred = await createUser('Fred Olsen');
  const kai = await createUser('Kai Moreno');
  const lu = await createUser('Lu Chen');

  const org = await createOrg('Northwind Labs', jono.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: omar.id, role: 'ADMIN' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: nina.id, role: 'MEMBER' },
    { orgId: org.id, userId: eve.id, role: 'MEMBER' },
    { orgId: org.id, userId: kai.id, role: 'MEMBER' },
  ]);

  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const research = await factories.createDrive(lena.id, { name: 'Customer Research', slug: `research-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  const finance = await factories.createDrive(lena.id, { name: 'Finance', slug: `finance-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });

  const productPage = await factories.createPage(product.id, { title: 'Roadmap' });
  const productPrivatePage = await factories.createPage(product.id, { title: 'Hiring', isPrivate: true });
  const researchPage = await factories.createPage(research.id, { title: 'Interviews' });
  const financePage = await factories.createPage(finance.id, { title: 'Runway' });
  const financePrivatePage = await factories.createPage(finance.id, { title: 'Salaries', isPrivate: true });

  // Product's default role lets implicit members edit (DRV-5, POL-6); a plain row could not.
  const [defaultRole] = await db
    .insert(driveRoles)
    .values({
      driveId: product.id,
      name: 'Contributor',
      isDefault: true,
      permissions: {},
      driveWidePermissions: { canView: true, canEdit: true, canShare: false },
    })
    .returning();

  // Marcus: synced org row on Product; STALE org rows on Research and Finance (the #2661 P1 shape).
  await factories.createDriveMember(product.id, marcus.id, { source: 'org', customRoleId: defaultRole.id });
  await factories.createDriveMember(research.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(finance.id, marcus.id, { source: 'org' });
  // Nina joined the org after the last sync: no row anywhere.
  // Eve joined Research (an approved join is an invite row).
  await factories.createDriveMember(research.id, eve.id, { source: 'invite' });
  // Omar is an org Admin who was also invited to Finance as ADMIN: his row, not org power, opens it.
  await factories.createDriveMember(finance.id, omar.id, { source: 'invite', role: 'ADMIN' });
  // Chris is a guest on Product (DRV-8), and holds a page share inside Finance.
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  await factories.createPagePermission(financePage.id, chris.id);
  // Priya also holds a stale org row on Finance: org power, not the row, must still open it.
  await factories.createDriveMember(finance.id, priya.id, { source: 'org' });
  // Fred led Research, then left Northwind: the lead moved to Lena, but his owner self-heal row
  // (role OWNER, source invite) was never an invitation and must open nothing.
  await factories.createDriveMember(research.id, fred.id, { source: 'invite', role: 'OWNER' });
  // Kai (org MEMBER) once led Product and still holds that OWNER row: it is stale, so Kai must
  // resolve Product exactly like any row-less member, through Product's default role.
  await factories.createDriveMember(product.id, kai.id, { source: 'invite', role: 'OWNER' });
  // Jono (org Owner) holds a leftover OWNER row on Finance: org power, not the row, must open it.
  await factories.createDriveMember(finance.id, jono.id, { source: 'invite', role: 'OWNER' });
  // Jono also joined Research as a plain invited MEMBER: org power must not lift that row's authority.
  await factories.createDriveMember(research.id, jono.id, { source: 'invite', role: 'MEMBER' });

  // Dana is not in Northwind. She left it (a stale org row on Product the sync has not removed),
  // belongs to Acme, and is invited to Marcus's personal drive.
  await factories.createDriveMember(product.id, dana.id, { source: 'org' });
  const acme = await createOrg('Acme', dana.id);
  await db.insert(orgMembers).values({ orgId: acme.id, userId: dana.id, role: 'OWNER' });
  const acmeWiki = await factories.createDrive(dana.id, { name: 'Acme Wiki', slug: `acme-wiki-${createId()}`, orgId: acme.id, orgVisibility: 'OPEN' });

  // Southwind: an OPEN drive whose default role denies viewing (POL-6). Lu is a plain member with no
  // row; Kai also holds a former lead's OWNER row there. Both must resolve through the default role.
  const southwind = await createOrg('Southwind', jono.id);
  await db.insert(orgMembers).values([
    { orgId: southwind.id, userId: jono.id, role: 'OWNER' },
    { orgId: southwind.id, userId: lu.id, role: 'MEMBER' },
    { orgId: southwind.id, userId: kai.id, role: 'MEMBER' },
  ]);
  const handbook = await factories.createDrive(jono.id, { name: 'Handbook', slug: `handbook-${createId()}`, orgId: southwind.id, orgVisibility: 'OPEN' });
  const handbookPage = await factories.createPage(handbook.id, { title: 'Policies' });
  await db.insert(driveRoles).values({
    driveId: handbook.id,
    name: 'No access',
    isDefault: true,
    permissions: {},
    driveWidePermissions: { canView: false, canEdit: false, canShare: false },
  });
  await factories.createDriveMember(handbook.id, kai.id, { source: 'invite', role: 'OWNER' });

  const personal = await factories.createDrive(marcus.id, { name: 'Marcus Notes', slug: `notes-${createId()}` });
  const personalPage = await factories.createPage(personal.id, { title: 'Scratch' });
  const personalPrivatePage = await factories.createPage(personal.id, { title: 'Diary', isPrivate: true });
  await factories.createDriveMember(personal.id, dana.id, { source: 'invite' });
  await factories.createDriveMember(personal.id, nina.id, { source: 'invite', role: 'ADMIN' });

  return {
    people: { jono, priya, omar, lena, marcus, nina, eve, chris, dana, fred, kai, lu },
    org, acme, southwind,
    drives: { product, research, finance, acmeWiki, handbook, personal },
    pages: { productPage, productPrivatePage, researchPage, financePage, financePrivatePage, handbookPage, personalPage, personalPrivatePage },
  };
}

export type Fixture = Awaited<ReturnType<typeof northwind>>;

/** Org drives, then orgs (drives.orgId and organizations.ownerId RESTRICT), then users (cascading the rest). */
export async function cleanupNorthwind(): Promise<void> {
  const orgIds = createdOrgIds.splice(0);
  if (orgIds.length > 0) {
    await db.delete(drives).where(inArray(drives.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  const userIds = createdUserIds.splice(0);
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
}
