import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations } from '@pagespace/db/schema/conversations';
import { users } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { wallets } from '@pagespace/db/schema/wallets';
import { createAgentPage, getBalance, getLedger, setBalance } from '../support/db';
import { freshBrowser, hydrated, imagoPath, imagoUser, signIn, type ImagoUser } from '../fixtures/imago.fixture';
import { browserGet } from '../fixtures/browser-api.fixture';
import { orgName, seedOrg, seedOrgDrive, seedOrgDriveWallet } from '../fixtures/org.fixture';

/** Native destinations and the actual first-call payer, served by production Imago on the shared origin. */
test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(150_000);
const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
async function viewer(name: string): Promise<ImagoUser> {
  const user = await imagoUser(name, { currentAiProvider: 'openrouter', currentAiModel: 'e2e/stub-model' });
  await db.update(users).set({ subscriptionTier: 'pro' }).where(eq(users.id, user.id));
  await setBalance(user.id, { monthlyRemainingCents: 10_000, monthlyAllowanceCents: 10_000, topupRemainingCents: 0 });
  return user;
}
async function open(browser: Parameters<typeof freshBrowser>[0], baseURL: string, user: ImagoUser, path: string): Promise<Page> {
  const { context, page } = await freshBrowser(browser, baseURL); contexts.push(context);
  await signIn(page, user, path); await hydrated(page);
  return page;
}
async function world() {
  const user = await viewer('Native org owner');
  const org = await seedOrg({ name: orgName('Native Northwind'), ownerId: user.id });
  const driveId = await seedOrgDrive({ orgId: org.orgId, leadId: user.id, name: 'Product', visibility: 'OPEN' });
  const { walletId } = await seedOrgDriveWallet({ orgId: org.orgId, driveId });
  return { user, org, driveId, walletId };
}

test('UI-2 (partial) UI-9 (partial) a user without org memberships has Wallets and only the Create organization affordance', async ({ browser, baseURL }) => {
  const user = await viewer('Native personal owner');
  const page = await open(browser, baseURL!, user, '/imago/account');
  await expect(page.getByRole('link', { name: 'Organizations', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Create organization/ }).first()).toBeVisible();
  await page.getByRole('link', { name: /^Wallets/ }).first().click();
  await expect(page).toHaveURL(/\/imago\/account\/wallets$/);
  await expect(page.getByRole('heading', { name: 'Wallets', exact: true })).toBeVisible();
  await expect(page.getByText('Open in classic', { exact: true })).toHaveCount(0);
});

test('UI-1 (partial) UI-2 (partial) UI-9 (partial) org hub and drive wallet destinations remain under the native shell', async ({ browser, baseURL }) => {
  const w = await world();
  const page = await open(browser, baseURL!, w.user, '/imago/account/organizations');
  await page.getByRole('link').filter({ hasText: w.org.name }).click();
  await expect(page).toHaveURL(new RegExp(`/imago/orgs/${w.org.orgId}/settings$`));
  await expect(page.getByRole('heading', { name: 'Organization Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Switch workspace: ${w.org.name}`, exact: true })).toBeVisible();
  for (const suffix of ['general', 'members', 'drives', 'policies', 'security', 'audit', 'billing', 'attention', 'danger']) {
    await page.goto(`/imago/orgs/${w.org.orgId}/settings/${suffix}`);
    await hydrated(page);
    await expect(page.getByText('Open in classic', { exact: true })).toHaveCount(0);
    await expect(page.locator('h1')).toHaveCount(1);
  }
  await page.goto(imagoPath(w.driveId, 'settings/wallet')); await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Wallet', exact: true })).toBeVisible();
  await expect(page.getByText('Product wallet', { exact: true }).first()).toBeVisible();
});

test('SPEND-1 (partial) UI-8 (partial) opening an org drive keeps the global Imago agent on its actual personal source', async ({ browser, baseURL }) => {
  const w = await world();
  const page = await open(browser, baseURL!, w.user, imagoPath(w.driveId, 'files'));
  const chat = page.getByRole('complementary', { name: 'Imago', exact: true });
  await expect(chat.locator('header').getByTestId('spend-source-chip')).toHaveAttribute('aria-label', /^Spending from Your credits:/);
  const roster = JSON.parse((await browserGet(page, '/api/user/builtin-agents')).body) as { agents: { key: string; pageId: string | null }[] };
  const imagoId = roster.agents.find(agent => agent.key === 'imago')?.pageId;
  expect(imagoId).toBeTruthy();
  const [agent] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, imagoId!));
  expect(agent.driveId).toBe(w.user.homeDriveId);
});

test('SPEND-1 (partial) SPEND-3 (partial) UI-8 (partial) a native org agent chooses personal credits atomically before its first billed turn', async ({ browser, baseURL }) => {
  const w = await world();
  const agentId = await createAgentPage(w.driveId, w.user.id);
  await db.update(pages).set({ title: 'Native org source proof' }).where(eq(pages.id, agentId));
  const page = await open(browser, baseURL!, w.user, imagoPath(w.driveId, 'files'));
  const chat = page.getByRole('complementary', { name: 'Imago', exact: true });
  await chat.getByLabel('Choose agent: Imago', { exact: true }).click();
  await chat.getByRole('radiogroup', { name: 'Agent', exact: true }).getByRole('radio', { name: /^Native org source proof/ }).click();
  await expect(chat.locator('header').getByTestId('spend-source-chip')).toHaveAttribute('aria-label', /^Spending from Product wallet:/);
  const composerStrip = chat.getByRole('status', { name: 'Spending from', exact: true });
  await expect(composerStrip).toContainText('Product wallet');
  const beforeRows = await db.select().from(conversations).where(eq(conversations.contextId, agentId));
  expect(beforeRows).toEqual([]);
  await composerStrip.getByRole('button', { name: 'Change', exact: true }).click();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/ai/page-agents/${agentId}/conversations`);
  await page.getByRole('radiogroup', { name: 'Spending source', exact: true }).getByRole('radio', { name: /Your credits/ }).click();
  const response = await created; expect(response.ok()).toBe(true);
  const own = await getBalance(w.user.id);
  expect(response.request().postDataJSON()).toEqual({ walletId: own!.id });
  const body = await response.json() as { conversationId: string };
  const [stored] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId));
  expect(stored.chosenWalletId).toBe(own!.id);
  expect(await getLedger(w.user.id, 'usage')).toEqual([]);
  await expect(chat.locator('header').getByTestId('spend-source-chip')).toHaveAttribute('aria-label', /^Spending from Your credits:/);
  await expect(composerStrip).toContainText('Your credits');
  const [orgBefore] = await db.select().from(wallets).where(eq(wallets.id, w.walletId));
  const input = chat.getByLabel('Message Native org source proof', { exact: true });
  await input.fill('Summarize the launch plan'); await input.press('Enter');
  await expect(chat.locator('[data-role="assistant"]').first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await getLedger(w.user.id, 'usage')).length, { timeout: 15_000 }).toBe(1);
  const [charge] = await getLedger(w.user.id, 'usage'); expect(charge.walletId).toBe(own!.id); expect(charge.appliedCents).toBeLessThan(0);
  const [orgAfter] = await db.select().from(wallets).where(eq(wallets.id, w.walletId));
  expect(orgAfter).toEqual(orgBefore);
});
