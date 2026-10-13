import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { wallets } from '@pagespace/db/schema/wallets';
import { createAgentPage, seedUser, type SeededUser } from '../support/db';
import { resetMock } from '../support/http';
import { authedContext, gotoChatPage, sendChatMessage } from '../fixtures/chat.fixture';
import { DESKTOP_VIEWPORT, orgName, seedOrg, seedOrgDrive, seedOrgDriveWallet, type SeededOrg } from '../fixtures/org.fixture';

/**
 * UI-8 in the browser (canvas page 2): the spending-from chip and its popover, the composer strip,
 * and the refusal card, for a member of a paid org working in an org drive with a drive wallet.
 *
 * PARTIAL, and titled so: the automation state (WorkflowList's spend line and skipped badge) needs
 * a scheduled workflow run, and the fallback notice needs a drive rule that moves a call to another
 * source; both are covered by the web component tests, not here. Canvas fidelity itself is a
 * reviewer's judgement with the canvas open.
 *
 * The AI provider is Playwright's OpenRouter mock (support/mock-openrouter.ts); a refused call never
 * reaches it, which is the point of the refusal card.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(150_000);

const openContexts: BrowserContext[] = [];
test.beforeEach(async ({ request }) => {
  await resetMock(request);
});
test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

interface SpendWorld {
  org: SeededOrg;
  marcus: SeededUser;
  productId: string;
  walletId: string;
}

/** Paid Northwind: Jono leads Product, which has a drive wallet under the org pool; Marcus is a Member on it. */
async function seedSpendWorld(): Promise<SpendWorld> {
  const jono = await seedUser({ name: 'Jono' });
  const marcus = await seedUser({ name: 'Marcus Oyelaran' });
  const org = await seedOrg({ name: orgName(), ownerId: jono.userId, members: [{ userId: marcus.userId, role: 'MEMBER' }] });
  const productId = await seedOrgDrive({ orgId: org.orgId, leadId: jono.userId, name: 'Product', visibility: 'OPEN', orgMemberIds: [marcus.userId] });
  const { walletId } = await seedOrgDriveWallet({ orgId: org.orgId, driveId: productId });
  return { org, marcus, productId, walletId };
}

async function openAs(browser: Parameters<typeof authedContext>[0], user: SeededUser, baseURL: string): Promise<Page> {
  const context = await authedContext(browser, user.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

test.describe('UI-8 (partial) the spend surfaces for a member in an org drive', () => {
  test('UI-8 (partial) the header chip names the drive wallet in one short token, and its popover lists every source with who funds it', async ({ browser, baseURL }) => {
    const w = await seedSpendWorld();
    const page = await openAs(browser, w.marcus, baseURL!);
    await page.goto(`/dashboard/${w.productId}`);

    const chip = page.locator('header').getByTestId('spend-source-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('aria-label', /^Spending from Product wallet: ([\d,]+ credits|No cap)$/);
    // One token: a count, never the wallet's name (the name is in the popover and the label).
    await expect(chip.getByTestId('spend-source-chip-text')).toHaveText(/^([\d,]+ credits|No cap)$/);

    await chip.click();
    const popover = page.getByRole('dialog').filter({ hasText: 'Your credits' });
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Product wallet');
    await expect(popover).toContainText(`Funded by ${w.org.name}`);
    await expect(popover).toContainText(`${w.org.name} seat`);
    await expect(popover).toContainText(`Your seat allowance from ${w.org.name}`);
    await expect(popover).toContainText('Personal balance · not billed to an organization');
  });

  test('UI-8 (partial) the composer strip names the source before the first message, turns to "paused" when the drive wallet is, and the refusal card offers the other sources; choosing one lets the message through', async ({ browser, baseURL }) => {
    const w = await seedSpendWorld();
    const pageId = await createAgentPage(w.productId, w.marcus.userId);
    const page = await openAs(browser, w.marcus, baseURL!);
    await gotoChatPage(page, w.productId, pageId);
    const chat = page.getByTestId('session-chat');

    const strip = chat.getByTestId('composer-spend-strip');
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip).toContainText(/Spending from Product wallet · ([\d,]+ credits left|No cap)/);
    await expect(strip.getByRole('button', { name: 'Change' })).toBeVisible();

    // The Owner pauses the wallet (WAL-7). Stored directly: this spec is about what the member sees.
    await db.update(wallets).set({ status: 'paused' }).where(eq(wallets.id, w.walletId));
    await page.reload();
    await expect(strip).toContainText('Product wallet: paused · choose another source', { timeout: 30_000 });

    // A send is refused by name, charged nothing, and the card offers the other sources.
    await sendChatMessage(chat, 'Summarize the launch plan');
    const card = chat.getByTestId('spend-refusal-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Product wallet is paused');
    await expect(card.getByRole('button', { name: new RegExp(`^${w.org.name} seat`) })).toBeVisible();
    const ownCredits = card.getByRole('button', { name: 'Your credits' });
    await expect(ownCredits).toBeVisible();

    // Choosing a source switches THIS conversation; the person sends again and it goes through.
    await ownCredits.click();
    await expect(page.getByText('This conversation now spends from Your credits. Send your message again.')).toBeVisible();
    await sendChatMessage(chat, 'Summarize the launch plan');
    await expect(chat.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(0);
  });
});
