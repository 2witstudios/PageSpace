import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { drives } from '@pagespace/db/schema/core';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { seedUser, type SeededUser } from '../support/db';
import { sessionPost, sessionDelete } from '../support/http';
import { authedContext } from '../fixtures/chat.fixture';
import {
  DESKTOP_VIEWPORT,
  captureOrgEvidence,
  inviteeEmail,
  orgName,
  seedOrg,
  seedOrgDrive,
  seedOrgInvitation,
  type OrgBilling,
  type SeededOrg,
} from '../fixtures/org.fixture';

/**
 * SEAT-9 in the browser: a lapsed org keeps its drives readable, refuses what adds access or
 * spend, still lets Admins restrict, and tells each role so — Owner and Admins a reactivate
 * banner on every org surface, members a read-only notice.
 *
 * PARTIAL by construction, and titled so. The requirement lists capabilities a browser in this
 * job does not fully cover (storage charged nothing while lapsed, sandboxes, the org pool
 * and allocations, approving guests); those are proven together on real Postgres by
 * seat-9-matrix.integration. What this spec adds is the part only a browser shows: the banners on
 * the real surfaces per role, the refused controls with the lapsed copy, a restriction that still
 * goes through, and that none of it deleted anything.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(150_000);

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

async function openAs(browser: Parameters<typeof authedContext>[0], user: SeededUser, baseURL: string): Promise<Page> {
  const context = await authedContext(browser, user.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

interface LapsedWorld {
  org: SeededOrg;
  jono: SeededUser;
  priya: SeededUser;
  marcus: SeededUser;
  productId: string;
  financeId: string;
  designId: string;
  invitee: string;
}

/** Northwind, lapsed: Jono owns it, Priya is an Admin, Marcus a Member; three drives and an open invite. */
async function seedLapsedNorthwind(billing: Exclude<OrgBilling, 'paid'>): Promise<LapsedWorld> {
  const jono = await seedUser({ name: 'Jono' });
  const priya = await seedUser({ name: 'Priya Nair' });
  const marcus = await seedUser({ name: 'Marcus Oyelaran' });
  const org = await seedOrg({
    name: orgName(),
    ownerId: jono.userId,
    members: [
      { userId: priya.userId, role: 'ADMIN' },
      { userId: marcus.userId, role: 'MEMBER' },
    ],
    billing,
  });
  const everyone = [jono.userId, priya.userId, marcus.userId];
  const productId = await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Product', visibility: 'OPEN', orgMemberIds: everyone });
  const designId = await seedOrgDrive({ orgId: org.orgId, leadId: priya.userId, name: 'Design System', visibility: 'OPEN', orgMemberIds: everyone });
  const financeId = await seedOrgDrive({ orgId: org.orgId, leadId: priya.userId, name: 'Finance', visibility: 'PRIVATE' });
  const invitee = inviteeEmail();
  await seedOrgInvitation(org.orgId, priya.userId, invitee);
  return { org, jono, priya, marcus, productId, financeId, designId, invitee };
}

const reactivateBanner = (page: Page, org: SeededOrg) => page.getByRole('status').filter({ hasText: `${org.name} is unpaid and read-only` });
const readOnlyNotice = (page: Page, org: SeededOrg) => page.getByRole('status').filter({ hasText: `${org.name} is read-only` });

/**
 * What a lapse must never delete: the org's drives and its members. (Drive member rows are not
 * counted: restricting a drive retires its implicit org rows by design, which is the restriction.)
 */
async function footprint(orgId: string) {
  const [d] = await db.select({ n: sql<number>`count(*)::int` }).from(drives).where(eq(drives.orgId, orgId));
  const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(orgMembers).where(eq(orgMembers.orgId, orgId));
  return { drives: d.n, members: m.n };
}

test.describe('SEAT-9 (partial) a lapsed org in the browser: banners per role, refused controls, restricting still works, nothing deleted', () => {
  test('SEAT-9 (partial) never paid: Owner and Admin see the reactivate banner on org settings and on an org drive; a Member sees the read-only notice and still opens the drive', async ({ browser, baseURL }) => {
    const w = await seedLapsedNorthwind('never_paid');

    const owner = await openAs(browser, w.jono, baseURL!);
    await owner.goto(`/orgs/${w.org.orgId}/settings`);
    await expect(reactivateBanner(owner, w.org)).toBeVisible();
    await expect(reactivateBanner(owner, w.org).getByRole('button', { name: 'Reactivate' })).toBeVisible();
    await captureOrgEvidence(owner, 'org-settings-lapsed-owner');
    await owner.goto(`/dashboard/${w.productId}`);
    await expect(reactivateBanner(owner, w.org)).toBeVisible();

    const admin = await openAs(browser, w.priya, baseURL!);
    await admin.goto(`/orgs/${w.org.orgId}/settings/members`);
    await expect(reactivateBanner(admin, w.org)).toBeVisible();
    await admin.goto(`/orgs/${w.org.orgId}/settings/drives`);
    await expect(reactivateBanner(admin, w.org)).toBeVisible();
    await admin.goto(`/dashboard/${w.productId}`);
    await expect(reactivateBanner(admin, w.org)).toBeVisible();

    // The Member: read-only notice, no reactivate and no billing detail, and the drive still opens.
    const member = await openAs(browser, w.marcus, baseURL!);
    await member.goto(`/dashboard/${w.productId}`);
    await expect(readOnlyNotice(member, w.org)).toBeVisible();
    await expect(readOnlyNotice(member, w.org)).toContainText('You can open and read every drive you could before.');
    await expect(member.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);
    await expect(reactivateBanner(member, w.org)).toHaveCount(0);
    await expect(member.locator('aside').getByRole('button', { name: 'Product' })).toBeVisible();
    const read = await member.request.get(`/api/drives/${w.productId}`);
    expect(read.status()).toBe(200);
  });

  test('SEAT-9 (partial) canceled: inviting, creating or moving in org drives and opening a drive further are refused with the lapsed copy, and the invite route answers 402 org_lapsed', async ({ browser, baseURL, request }) => {
    const w = await seedLapsedNorthwind('canceled');
    const admin = await openAs(browser, w.priya, baseURL!);

    await admin.goto(`/orgs/${w.org.orgId}/settings/members`);
    await expect(reactivateBanner(admin, w.org)).toBeVisible();
    await expect(admin.getByRole('button', { name: 'Invite people' })).toBeDisabled();
    await expect(admin.getByText(/Inviting is paused while unpaid\./)).toBeVisible();

    // The UI is not the only gate: the route itself refuses, with the SEAT-9 code and copy.
    const invite = await sessionPost(request, `/api/orgs/${w.org.orgId}/invitations`, w.priya, { email: inviteeEmail('gita') });
    expect(invite.status()).toBe(402);
    const body = (await invite.json()) as { code?: string; error?: string };
    expect(body.code).toBe('org_lapsed');
    expect(body.error).toMatch(/subscription has lapsed/);

    await admin.goto(`/orgs/${w.org.orgId}/settings/drives`);
    await expect(admin.getByRole('button', { name: 'New drive' })).toBeDisabled();
    await expect(admin.getByRole('button', { name: 'Move a drive in' })).toBeDisabled();
    await expect(admin.getByText(/creating org drives are paused while unpaid/)).toBeVisible();

    // Opening the Private drive further is paused on its Organization card; making it less open is not offered.
    await admin.goto(`/dashboard/${w.financeId}/settings/general`);
    const card = admin.getByTestId('org-drive-card');
    await expect(card).toBeVisible();
    const visibility = card.getByRole('radiogroup', { name: 'Visibility' });
    await expect(visibility.getByRole('radio', { name: /^Private/ })).toHaveAttribute('aria-checked', 'true');
    await expect(visibility.getByRole('radio', { name: /^Open/ })).toBeDisabled();
    await expect(visibility.getByRole('radio', { name: /^Restricted/ })).toBeDisabled();
    await expect(card.getByTestId('lapsed-loosen-note')).toContainText('Making it less open still works.');
  });

  test('SEAT-9 (partial) while lapsed an Admin still restricts — revokes an invitation and makes an Open drive Restricted — and nothing is deleted', async ({ browser, baseURL }) => {
    const w = await seedLapsedNorthwind('never_paid');
    const before = await footprint(w.org.orgId);
    const admin = await openAs(browser, w.priya, baseURL!);

    // D-OW-33: billing never blocks security. Revoke is offered and goes through.
    await admin.goto(`/orgs/${w.org.orgId}/settings/members`);
    const invitation = admin.locator('div').filter({ hasText: w.invitee }).filter({ has: admin.getByRole('button', { name: 'Revoke' }) }).last();
    await expect(invitation.getByRole('button', { name: 'Resend' })).toBeDisabled();
    await invitation.getByRole('button', { name: 'Revoke' }).click();
    await expect(admin.getByText(w.invitee)).toHaveCount(0);

    // Making a drive LESS open is allowed while lapsed.
    await admin.goto(`/dashboard/${w.designId}/settings/general`);
    const visibility = admin.getByTestId('org-drive-card').getByRole('radiogroup', { name: 'Visibility' });
    await expect(visibility.getByRole('radio', { name: /^Open/ })).toHaveAttribute('aria-checked', 'true');
    await visibility.getByRole('radio', { name: /^Restricted/ }).click();
    await expect(visibility.getByRole('radio', { name: /^Restricted/ })).toHaveAttribute('aria-checked', 'true');
    // ...and opening it again is now the paused direction.
    await expect(visibility.getByRole('radio', { name: /^Open/ })).toBeDisabled();
    const [design] = await db.select({ v: drives.orgVisibility }).from(drives).where(eq(drives.id, w.designId));
    expect(design.v).toBe('RESTRICTED');

    // Nothing deleted: every drive and every org member is still there, and the Member still reads Product.
    expect(await footprint(w.org.orgId)).toEqual(before);
    const member = await openAs(browser, w.marcus, baseURL!);
    await member.goto(`/dashboard/${w.productId}`);
    await expect(readOnlyNotice(member, w.org)).toBeVisible();
    expect((await member.request.get(`/api/drives/${w.productId}`)).status()).toBe(200);
  });

  for (const billing of ['unpaid', 'past_due'] as const) {
    test(`SEAT-9 (partial) ${billing}: actual publish and environment entrypoints refuse access expansion, reads and security restriction remain available`, async ({ request }) => {
      const w = await seedLapsedNorthwind(billing);
      const canvas = await factories.createPage(w.productId, { type: 'CANVAS', title: 'Launch canvas', content: '<p>Launch plan</p>' });
      const before = await footprint(w.org.orgId);
      const publishedBefore = await db.select().from(publishedPages).where(eq(publishedPages.driveId, w.productId));
      const envsBefore = await db.select().from(driveEnvs).where(eq(driveEnvs.driveId, w.productId));

      const publish = await sessionPost(request, `/api/pages/${canvas.id}/publish`, w.jono, {});
      expect(publish.status(), await publish.text()).toBe(402);
      expect((await publish.json()).error).toMatch(/subscription has lapsed/);
      const env = await sessionPost(request, `/api/drives/${w.productId}/envs`, w.jono, { name: 'Blocked environment' });
      expect(env.status(), await env.text()).toBe(402);
      expect(await env.json()).toMatchObject({ code: 'org_lapsed' });
      const invite = await sessionPost(request, `/api/orgs/${w.org.orgId}/invitations`, w.priya, { email: inviteeEmail('blocked') });
      expect(invite.status()).toBe(402);
      expect(await invite.json()).toMatchObject({ code: 'org_lapsed' });

      expect(await db.select().from(publishedPages).where(eq(publishedPages.driveId, w.productId))).toEqual(publishedBefore);
      expect(await db.select().from(driveEnvs).where(eq(driveEnvs.driveId, w.productId))).toEqual(envsBefore);
      expect(await footprint(w.org.orgId)).toEqual(before);

      // D-OW-33: the same Admin's credential may still revoke access while unpaid.
      const invitationId = await seedOrgInvitation(w.org.orgId, w.priya.userId, inviteeEmail('revoke'));
      const revoke = await sessionDelete(request, `/api/orgs/${w.org.orgId}/invitations/${invitationId}`, w.priya);
      expect(revoke.ok(), await revoke.text()).toBe(true);
      const tighten = await request.patch(`/api/orgs/${w.org.orgId}/policies`, {
        headers: { cookie: `session=${w.priya.sessionToken}`, 'x-csrf-token': w.priya.csrf },
        data: { publicShareLinks: false },
      });
      expect(tighten.ok(), await tighten.text()).toBe(true);
      const read = await request.get(`/api/drives/${w.productId}`, { headers: { cookie: `session=${w.marcus.sessionToken}` } });
      expect(read.status()).toBe(200);
      expect(await footprint(w.org.orgId)).toEqual(before);
    });
  }

});
