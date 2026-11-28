import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { seedUser, type SeededUser } from '../support/db';
import { authedContext } from '../fixtures/chat.fixture';
import {
  DESKTOP_VIEWPORT,
  expectSameDocument,
  markDocument,
  openDrivePicker,
  orgName,
  seedOrg,
  seedOrgDrive,
  seedOrgDriveWallet,
  type SeededOrg,
} from '../fixtures/org.fixture';

/**
 * X-4: "Realtime events for membership, visibility, and wallet state so sidebar, picker, and chip
 * update without refresh" — in two browser windows on the production build, with realtime reached
 * SAME-ORIGIN through the e2e proxy (see 16-dispatch-multiplayer.spec.ts and the `e2e` job in
 * ci.yml: a cross-origin socket is blocked by the shipped CSP and the specs would pass off a
 * mount-time fetch instead).
 *
 * Window A is the org's Owner, acting through the product's own controls. Window B is a Member
 * who only watches. Each assertion proves the update arrived in B's SAME document (markDocument):
 * B never reloads or navigates, and none of the reads involved poll — `GET /api/orgs` and the
 * spend reads revalidate on events only (revalidateOnFocus off, no refresh interval), and the
 * drive list refetches on drive member events — so the change can only have come over the socket.
 *
 * The three tests together are the requirement: membership (org:changed → the org list and the
 * role), visibility (the org membership sync's drive member event → the sidebar's drive picker),
 * and wallet state (wallet:changed → the header's spending-from chip).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(150_000);

const LIVE_MS = 20_000;

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

interface LiveWorld {
  org: SeededOrg;
  jono: SeededUser;
  marcus: SeededUser;
  productId: string;
  financeId: string;
}

/** Paid Northwind: Jono owns it and leads Product (Open, with a wallet) and Finance (Private); Marcus is a Member. */
async function seedLiveWorld(): Promise<LiveWorld> {
  const jono = await seedUser({ name: 'Jono' });
  const marcus = await seedUser({ name: 'Marcus Oyelaran' });
  const org = await seedOrg({ name: orgName(), ownerId: jono.userId, members: [{ userId: marcus.userId, role: 'MEMBER' }] });
  const productId = await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Product', visibility: 'OPEN', orgMemberIds: [marcus.userId] });
  const financeId = await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Finance', visibility: 'PRIVATE' });
  await seedOrgDriveWallet({ orgId: org.orgId, driveId: productId });
  return { org, jono, marcus, productId, financeId };
}

async function openWindow(browser: Parameters<typeof authedContext>[0], user: SeededUser, baseURL: string): Promise<Page> {
  // Service workers blocked for the same reason as 18-sidebar-directory-live: a fetch through
  // `/sw.js` is a second, uncontrolled cache between the app and the assertion.
  const context = await authedContext(browser, user.sessionToken, baseURL, { serviceWorkers: 'block' });
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

/**
 * Go to `path` in the watching window and wait for its socket: armed BEFORE navigation, since the
 * handshake starts during first paint. The personal rooms (notifications, drives) are joined at
 * connect, so this is the readiness signal for "an event can reach this page".
 */
async function watch(page: Page, path: string): Promise<void> {
  const socket = page.waitForEvent('websocket', { timeout: 60_000 });
  await page.goto(path);
  await socket;
}

test.describe('X-4 membership, visibility and wallet state reach another member\'s org list, drive picker and spending-from chip without refresh', () => {
  test('membership: the Owner renames the org and makes the Member an Admin; the Member\'s Account Settings follow live', async ({ browser, baseURL }) => {
    const w = await seedLiveWorld();
    const member = await openWindow(browser, w.marcus, baseURL!);
    await watch(member, '/settings');
    const row = member.locator(`a[href="/orgs/${w.org.orgId}/settings"]`);
    await expect(row).toContainText(w.org.name);
    await expect(row).toContainText('Member');
    await markDocument(member);

    const owner = await openWindow(browser, w.jono, baseURL!);
    await owner.goto(`/orgs/${w.org.orgId}/settings/general`);
    const renamed = orgName('Northwind Industries');
    const name = owner.getByLabel('Name', { exact: true });
    await expect(name).toHaveValue(w.org.name);
    await name.fill(renamed);
    await owner.getByRole('button', { name: 'Save' }).click();
    await expect(owner.getByText('Saved', { exact: true })).toBeVisible();

    await expect(row).toContainText(renamed, { timeout: LIVE_MS });
    await expectSameDocument(member);

    await owner.goto(`/orgs/${w.org.orgId}/settings/members`);
    await owner.getByRole('combobox', { name: 'Org role for Marcus Oyelaran' }).click();
    await owner.getByRole('option', { name: 'Admin' }).click();
    await expect(owner.getByText('Marcus Oyelaran is now an Admin')).toBeVisible();

    await expect(row).toContainText('Admin', { timeout: LIVE_MS });
    await expect(row).not.toContainText('Member');
    await expectSameDocument(member);
  });

  test('visibility: the Owner opens a Private drive; it appears under the org in the Member\'s sidebar drive picker live', async ({ browser, baseURL }) => {
    const w = await seedLiveWorld();
    const member = await openWindow(browser, w.marcus, baseURL!);
    await watch(member, `/dashboard/${w.productId}`);
    const picker = await openDrivePicker(member, 'Product');
    const orgGroup = picker.locator('[cmdk-group]').filter({ has: member.getByTestId('picker-group-org').filter({ hasText: w.org.name }) });
    await expect(orgGroup.getByRole('option', { name: /^Product/ })).toBeVisible();
    await expect(picker.getByRole('option', { name: /^Finance/ })).toHaveCount(0);
    await markDocument(member);

    const owner = await openWindow(browser, w.jono, baseURL!);
    await owner.goto(`/dashboard/${w.financeId}/settings/general`);
    const visibility = owner.getByTestId('org-drive-card').getByRole('radiogroup', { name: 'Visibility' });
    await expect(visibility.getByRole('radio', { name: /^Private/ })).toHaveAttribute('aria-checked', 'true');
    await visibility.getByRole('radio', { name: /^Open/ }).click();
    await expect(visibility.getByRole('radio', { name: /^Open/ })).toHaveAttribute('aria-checked', 'true');

    // The picker is still open in B's window, and the drive arrives in it under the org's header.
    await expect(orgGroup.getByRole('option', { name: /^Finance/ })).toBeVisible({ timeout: LIVE_MS });
    await expectSameDocument(member);
  });

  test('wallet state: the Owner pauses the drive wallet; the Member\'s spending-from chip turns to Paused live', async ({ browser, baseURL }) => {
    const w = await seedLiveWorld();
    const member = await openWindow(browser, w.marcus, baseURL!);
    await watch(member, `/dashboard/${w.productId}`);
    const chip = member.locator('header').getByTestId('spend-source-chip');
    await expect(chip).toHaveAttribute('aria-label', /^Spending from Product wallet: ([\d,]+ credits|No cap)$/, { timeout: 30_000 });
    await markDocument(member);

    const owner = await openWindow(browser, w.jono, baseURL!);
    await owner.goto(`/dashboard/${w.productId}/settings/wallet`);
    const pause = owner.getByRole('switch', { name: 'Pause spending' });
    await expect(pause).toHaveAttribute('aria-checked', 'false');
    await pause.click();
    await expect(owner.getByText('Spending from this wallet is paused')).toBeVisible();

    await expect(chip).toHaveAttribute('aria-label', 'Spending from Product wallet: Paused', { timeout: LIVE_MS });
    await expect(chip.getByTestId('spend-source-chip-text')).toHaveText('Paused');
    await expectSameDocument(member);
  });
});
