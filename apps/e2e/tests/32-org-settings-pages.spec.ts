import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { seedUser, type SeededUser } from '../support/db';
import { sessionGet } from '../support/http';
import { authedContext } from '../fixtures/chat.fixture';
import {
  DESKTOP_VIEWPORT,
  captureOrgEvidence,
  inviteeEmail,
  orgName,
  seedOrg,
  seedOrgDrive,
  seedOrgDriveWallet,
  seedOrgInvitation,
  type SeededOrg,
} from '../fixtures/org.fixture';

/**
 * UI-7: the org's Members & seats, Drives, Policies, Security, Plan & seats and Audit log pages
 * (canvas page 1), as the Owner of a paid Northwind sees them on the production build. Each page
 * is asserted on the sections the canvas gives it, filled from the seeded org — not on a heading
 * alone — and the Security page is driven: a sign-in requirement changed there is stored
 * (PATCH /api/orgs/:id/policies) and is still there after a reload.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(150_000);

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

interface PaidWorld {
  org: SeededOrg;
  jono: SeededUser;
  invitee: string;
}

async function seedPaidNorthwind(): Promise<PaidWorld> {
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
  });
  const everyone = [jono.userId, priya.userId, marcus.userId];
  const productId = await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Product', visibility: 'OPEN', orgMemberIds: everyone });
  await seedOrgDrive({ orgId: org.orgId, leadId: priya.userId, name: 'Customer Research', visibility: 'RESTRICTED' });
  await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Finance', visibility: 'PRIVATE' });
  await seedOrgDriveWallet({ orgId: org.orgId, driveId: productId });
  const invitee = inviteeEmail();
  await seedOrgInvitation(org.orgId, jono.userId, invitee);
  return { org, jono, invitee };
}

async function openOwner(browser: Parameters<typeof authedContext>[0], world: PaidWorld, baseURL: string): Promise<Page> {
  const context = await authedContext(browser, world.jono.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

const title = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });

test.describe('UI-7 the Owner\'s org pages: Members & seats, Drives, Policies, Security, Plan & seats, Audit log', () => {
  test('each of the six pages renders its canvas sections, filled from the org', async ({ browser, baseURL }) => {
    const w = await seedPaidNorthwind();
    const page = await openOwner(browser, w, baseURL!);
    const base = `/orgs/${w.org.orgId}/settings`;

    // Members & seats: the seat stats, the tabs, every member with their role, the pending invite, Invite.
    await page.goto(`${base}/members`);
    await expect(title(page, 'Members & seats')).toBeVisible();
    await expect(page.getByText(/Seats in use · 1 reserved by pending invites/)).toBeVisible();
    for (const tab of ['All', 'Admins', 'Pending', 'Guests']) {
      await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toBeVisible();
    }
    await expect(page.getByText('Priya Nair', { exact: true })).toBeVisible();
    await expect(page.getByText('Marcus Oyelaran', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Org role for Priya Nair' })).toHaveText('Admin');
    await expect(page.getByRole('combobox', { name: 'Org role for Marcus Oyelaran' })).toHaveText('Member');
    await expect(page.getByText(w.invitee)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite people' })).toBeEnabled();
    await captureOrgEvidence(page, 'org-members-seats');

    // Drives: every org drive with its visibility and lead, the actions, and the visibility legend.
    await page.goto(`${base}/drives`);
    await expect(title(page, 'Drives')).toBeVisible();
    for (const drive of ['Product', 'Customer Research', 'Finance']) {
      await expect(page.getByRole('combobox', { name: `Visibility of ${drive}` })).toBeVisible();
    }
    await expect(page.getByRole('combobox', { name: 'Visibility of Customer Research' })).toContainText('Restricted');
    await expect(page.getByText('Lead: Priya Nair')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New drive' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Move a drive in' })).toBeEnabled();
    await expect(page.getByText('What visibility means', { exact: true })).toBeVisible();
    await captureOrgEvidence(page, 'org-drives');

    // Policies: the four groups of org policy.
    await page.goto(`${base}/policies`);
    await expect(title(page, 'Policies')).toBeVisible();
    for (const group of ['Sharing & access', 'Membership', 'AI & agents', 'Compute & integrations']) {
      await expect(page.getByRole('heading', { name: group })).toBeVisible();
    }
    await expect(page.getByText('Who can invite new members', { exact: true })).toBeVisible();
    await expect(page.getByText('When a drive wallet runs out', { exact: true })).toBeVisible();
    await captureOrgEvidence(page, 'org-policies');

    // Security: verified domains, removed people, sign-in requirements, and SSO/SCIM out of scope.
    await page.goto(`${base}/security`);
    await expect(title(page, 'Security')).toBeVisible();
    await expect(page.getByText('Verified domains', { exact: true })).toBeVisible();
    await expect(page.getByText('Removed people', { exact: true })).toBeVisible();
    await expect(page.getByText('Sign-in requirements', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Single sign-on and SCIM' })).toBeVisible();
    await captureOrgEvidence(page, 'org-security');

    // Plan & seats: the plan with its state, seats, the pool with the drive wallet, invoices.
    await page.goto(`${base}/billing`);
    await expect(title(page, 'Plan & seats')).toBeVisible();
    await expect(page.getByText('Business plan', { exact: true })).toBeVisible();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Seats in use' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Add seats automatically' })).toBeEnabled();
    await expect(page.getByText('Credits pool', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Pause the credits pool' })).toBeVisible();
    await expect(page.locator('#pool').getByText('Product', { exact: true })).toBeVisible();
    await expect(page.getByText('Invoices', { exact: true })).toBeVisible();
    await captureOrgEvidence(page, 'org-plan-seats');

    // Audit log: filter by type, drive and time; CSV export; the list itself answers.
    await page.goto(`${base}/audit`);
    await expect(title(page, 'Audit log')).toBeVisible();
    for (const filter of ['Event type', 'Drive', 'Time']) {
      await expect(page.getByRole('combobox', { name: filter })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 30_000 });
    await captureOrgEvidence(page, 'org-audit');
  });

  test('Security: the strong sign-in and maximum sign-in age controls, and a changed maximum age persists after reload', async ({ browser, baseURL, request }) => {
    const w = await seedPaidNorthwind();
    const page = await openOwner(browser, w, baseURL!);
    await page.goto(`/orgs/${w.org.orgId}/settings/security`);
    await expect(page.getByText('Sign-in requirements', { exact: true })).toBeVisible();

    const strong = page.getByRole('switch', { name: 'Require strong sign-in (passkey)' });
    const age = page.getByRole('combobox', { name: 'Maximum sign-in age' });
    await expect(strong).toHaveAttribute('aria-checked', 'false');
    await expect(age).toHaveText('No limit');
    await expect(page.getByRole('button', { name: 'Save sign-in requirements' })).toBeDisabled();

    // Tightening needs no passkey ceremony: this session was signed in moments ago.
    await age.click();
    await page.getByRole('option', { name: '7 days' }).click();
    await expect(age).toHaveText('7 days');
    const saved = page.waitForResponse((r) => r.url().endsWith(`/api/orgs/${w.org.orgId}/policies`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Save sign-in requirements' }).click();
    expect((await saved).status()).toBe(200);

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Maximum sign-in age' })).toHaveText('7 days');
    await expect(page.getByRole('switch', { name: 'Require strong sign-in (passkey)' })).toHaveAttribute('aria-checked', 'false');
    const stored = await sessionGet(request, `/api/orgs/${w.org.orgId}/policies`, w.jono);
    const body = (await stored.json()) as { policies: { maximumSessionAgeMinutes: number | null; requireStrongSignIn: boolean } };
    expect(body.policies.maximumSessionAgeMinutes).toBe(7 * 24 * 60);
    expect(body.policies.requireStrongSignIn).toBe(false);
  });
});
