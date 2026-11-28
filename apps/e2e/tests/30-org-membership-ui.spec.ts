import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { seedUser } from '../support/db';
import { authedContext } from '../fixtures/chat.fixture';
import { DESKTOP_VIEWPORT, openDrivePicker, orgName, seedOrg, seedOrgDrive } from '../fixtures/org.fixture';

/**
 * ORG-2 in a real browser, against the production build: "Org membership roles: Owner, Admin,
 * Member. A user may belong to many orgs. A user in no org sees no org UI."
 *
 * The lib integration test proves the roles and the many-orgs rows and a no-org person's empty
 * list on Postgres; the web unit test renders the no-org surfaces on an empty list. Neither runs
 * the two together. Here one person in no org walks every surface that would carry org UI, and
 * one person holding all three roles in three orgs sees each org with its role, and each role
 * opens exactly what it should.
 *
 * Ruling carried from the web test (no-org-ui.test.tsx): the Create organization entry in Account
 * Settings is the ONE org affordance a no-org person sees, because UI-6 needs a way in.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(120_000);

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

async function openAs(browser: Parameters<typeof authedContext>[0], sessionToken: string, baseURL: string): Promise<Page> {
  const context = await authedContext(browser, sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

/** Every link into an org surface on the page. */
const orgLinks = (page: Page) => page.locator('a[href^="/orgs/"]');

test.describe('ORG-2 Owner, Admin and Member roles; one person in many orgs; no org UI for a person in none', () => {
  test('a person in no org sees no org UI: no org group or link in the picker, no org crumb, no Organization card, only Create organization in Account Settings', async ({ browser, baseURL }) => {
    const driveName = `Notes ${Date.now()}`;
    const loner = await seedUser({ name: 'Omar Solo', driveName });
    // An org that exists, which this person is not in: it must not reach them anywhere.
    const stranger = await seedUser({ name: 'Jono' });
    const foreign = await seedOrg({ name: orgName(), ownerId: stranger.userId });

    const page = await openAs(browser, loner.sessionToken, baseURL!);

    // The server's answer every org surface reads: no organizations.
    const mine = await page.request.get('/api/orgs');
    expect(mine.ok()).toBe(true);
    expect(((await mine.json()) as { organizations: unknown[] }).organizations).toEqual([]);

    // The drive picker: the personal drive is listed, ungrouped, with no org header or org link.
    await page.goto(`/dashboard/${loner.driveId}`);
    const picker = await openDrivePicker(page, driveName);
    await expect(picker.getByText(driveName).first()).toBeVisible();
    await expect(picker.getByText(/^All drives · \d+$/)).toBeVisible();
    await expect(picker.getByTestId('picker-group-org')).toHaveCount(0);
    await expect(picker.getByTestId('picker-group-personal')).toHaveCount(0);
    await expect(picker.getByRole('option', { name: / settings$/ })).toHaveCount(0);
    await expect(orgLinks(page)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The header crumb is the drive alone: its tooltip names no org.
    await expect(page.locator('header').getByTitle(driveName, { exact: true })).toBeVisible();
    await expect(orgLinks(page)).toHaveCount(0);

    // Drive Settings › General: no Organization card, neither the org-owned one nor "move into an org".
    await page.goto(`/dashboard/${loner.driveId}/settings/general`);
    await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
    await expect(page.getByText('Drive Name', { exact: true })).toBeVisible();
    await expect(page.getByTestId('org-drive-card')).toHaveCount(0);
    await expect(page.getByTestId('org-move-in-card')).toHaveCount(0);
    await expect(orgLinks(page)).toHaveCount(0);

    // Account Settings: the Organizations section holds only Create organization.
    const orgList = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/orgs' && r.request().method() === 'GET');
    await page.goto('/settings');
    await orgList;
    await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create organization/ })).toBeVisible();
    await expect(orgLinks(page)).toHaveCount(0);

    // An org they are not in does not load for them, by URL either.
    await page.goto(`/orgs/${foreign.orgId}/settings`);
    await expect(page.getByRole('heading', { name: 'Organization Settings' })).toBeVisible();
    await expect(page.getByText(foreign.name)).toHaveCount(0);
    await expect(page.getByText('Members & seats')).toHaveCount(0);
  });

  test('one person is Owner of one org, Admin of a second and Member of a third: each is listed with that role and each role opens what it should', async ({ browser, baseURL }) => {
    const driveName = `Scratch ${Date.now()}`;
    const priya = await seedUser({ name: 'Priya Nair', driveName });
    const jono = await seedUser({ name: 'Jono' });
    const dana = await seedUser({ name: 'Dana Kim' });

    const owned = await seedOrg({ name: orgName('Priya Studio'), ownerId: priya.userId, members: [{ userId: dana.userId, role: 'MEMBER' }] });
    const admin = await seedOrg({ name: orgName(), ownerId: jono.userId, members: [{ userId: priya.userId, role: 'ADMIN' }] });
    const member = await seedOrg({ name: orgName('Globex Research'), ownerId: dana.userId, members: [{ userId: priya.userId, role: 'MEMBER' }] });
    // One Open drive in each, so every org has a group in the picker.
    await seedOrgDrive({ orgId: owned.orgId, leadId: priya.userId, name: 'Studio', visibility: 'OPEN', orgMemberIds: [dana.userId] });
    await seedOrgDrive({ orgId: admin.orgId, leadId: jono.userId, name: 'Product', visibility: 'OPEN', orgMemberIds: [priya.userId] });
    await seedOrgDrive({ orgId: member.orgId, leadId: dana.userId, name: 'Field Notes', visibility: 'OPEN', orgMemberIds: [priya.userId] });

    const page = await openAs(browser, priya.sessionToken, baseURL!);

    // Account Settings › Organizations: all three, each with Priya's own role in it.
    await page.goto('/settings');
    const rows = page.locator('a[href^="/orgs/"]');
    await expect(rows).toHaveCount(3);
    const row = (name: string) => rows.filter({ hasText: name });
    await expect(row(owned.name)).toContainText('Owner');
    await expect(row(admin.name)).toContainText('Admin');
    await expect(row(member.name)).toContainText('Member');
    await expect(page.getByRole('button', { name: /Create organization/ })).toBeVisible();

    // The drive picker groups the drives under each org, plus her personal drives.
    await page.goto(`/dashboard/${priya.driveId}`);
    const picker = await openDrivePicker(page, driveName);
    for (const org of [owned, admin, member]) {
      await expect(picker.getByTestId('picker-group-org').filter({ hasText: org.name })).toBeVisible();
      await expect(picker.getByRole('option', { name: `${org.name} settings` })).toBeVisible();
    }
    await expect(picker.getByTestId('picker-group-personal')).toBeVisible();
    await page.keyboard.press('Escape');

    // What each role opens. Owner: the Owner-only Danger Zone.
    await page.goto(`/orgs/${owned.orgId}/settings/danger`);
    await expect(page.getByRole('heading', { name: 'Danger Zone' })).toBeVisible();
    await expect(page.getByText(`Transfer ownership of ${owned.name}, or delete it.`)).toBeVisible();

    // Admin: the org's member settings, but not the Owner's page.
    await page.goto(`/orgs/${admin.orgId}/settings/members`);
    await expect(page.getByRole('button', { name: 'Invite people' })).toBeVisible();
    await page.goto(`/orgs/${admin.orgId}/settings/danger`);
    await expect(page.getByText(`Only the Owner of ${admin.name} can see this page.`)).toBeVisible();

    // Member: no org settings (UI-11), but the org itself, with their role, and the way to leave.
    await page.goto(`/orgs/${member.orgId}/settings/members`);
    await expect(page.getByText(`Only the Owner or an Admin of ${member.name} can see this page.`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
  });
});
