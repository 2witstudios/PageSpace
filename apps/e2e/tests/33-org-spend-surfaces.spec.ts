import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { db } from '@pagespace/db/db';
import { eq, inArray, or } from '@pagespace/db/operators';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations } from '@pagespace/db/schema/organizations';
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { conversations, messages as chatMessages } from '@pagespace/db/schema/conversations';
import { createAgentPage, getBalance, getLedger, getHolds, seedUser, type SeededUser } from '../support/db';
import { mockCallCount, resetMock } from '../support/http';
import { authedContext, gotoChatPage, sendChatMessage } from '../fixtures/chat.fixture';
import { DESKTOP_VIEWPORT, captureOrgEvidence, orgName, seedOrg, seedOrgDrive, seedOrgDriveWallet, type SeededOrg } from '../fixtures/org.fixture';

/**
 * UI-8 in the browser (canvas page 2): the spending-from chip and its popover, the composer strip,
 * and the refusal card, for a member of a paid org working in an org drive with a drive wallet.
 *
 * PARTIAL, and titled so: these exercise live spend refusal, fallback disclosure and persisted
 * automation states, not canvas fidelity itself, which needs a reviewer with the canvas open.
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
  jono: SeededUser;
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
  return { org, jono, marcus, productId, walletId };
}

async function openAs(browser: Parameters<typeof authedContext>[0], user: SeededUser, baseURL: string): Promise<Page> {
  const context = await authedContext(browser, user.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return page;
}

/** All payer legs and billing writes a refusal must leave untouched, including the org pool. */
async function financialState(w: SpendWorld) {
  const payerWallets = await db.select().from(wallets).where(or(eq(wallets.orgId, w.org.orgId), eq(wallets.userId, w.marcus.userId))).orderBy(wallets.id);
  const walletIds = payerWallets.map((wallet) => wallet.id);
  return {
    wallets: payerWallets,
    holds: await db.select().from(creditHolds).where(or(eq(creditHolds.userId, w.marcus.userId), inArray(creditHolds.walletId, walletIds))).orderBy(creditHolds.id),
    ledger: await db.select().from(creditLedger).where(or(eq(creditLedger.userId, w.marcus.userId), inArray(creditLedger.walletId, walletIds))).orderBy(creditLedger.id),
    usage: await db.select().from(aiUsageLogs).where(or(eq(aiUsageLogs.userId, w.marcus.userId), inArray(aiUsageLogs.walletId, walletIds))).orderBy(aiUsageLogs.id),
  };
}

async function expectPersonalCharge(w: SpendWorld, before: Awaited<ReturnType<typeof financialState>>) {
  const personal = await getBalance(w.marcus.userId);
  expect(personal).not.toBeNull();
  const initial = before.wallets.find((wallet) => wallet.id === personal!.id)!;
  await expect.poll(async () => (await getBalance(w.marcus.userId))!.monthlyRemainingCents, { timeout: 15_000 }).toBeLessThan(initial.monthlyRemainingCents);
  const usage = await getLedger(w.marcus.userId, 'usage');
  expect(usage).toHaveLength(1);
  expect(usage[0].walletId).toBe(personal!.id);
  expect(usage[0].appliedCents).toBeLessThan(0);
  const after = await financialState(w);
  expect(after.wallets.filter((wallet) => wallet.orgId === w.org.orgId)).toEqual(before.wallets.filter((wallet) => wallet.orgId === w.org.orgId));
  expect(after.usage.length).toBeGreaterThan(0);
  expect(after.usage.every((row) => row.walletId === personal!.id)).toBe(true);
  expect(await getHolds(w.marcus.userId)).toEqual([]);
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
    await captureOrgEvidence(page, 'spend-chip-popover');
  });

  test('UI-8 (partial) the composer strip names the source before the first message, turns to "paused" when the drive wallet is, and the refusal card offers the other sources; choosing one lets the message through', async ({ browser, baseURL, request }) => {
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
    const before = await financialState(w);
    const callsBefore = await mockCallCount(request);
    await sendChatMessage(chat, 'Summarize the launch plan');
    const card = chat.getByTestId('spend-refusal-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Product wallet is paused');
    await expect(card).toContainText('Nothing was charged.');
    await expect(card.getByRole('button', { name: new RegExp(`^${w.org.name} seat`) })).toBeVisible();
    const ownCredits = card.getByRole('button', { name: 'Your credits' });
    await expect(ownCredits).toBeVisible();
    expect(await mockCallCount(request)).toBe(callsBefore);
    expect(await financialState(w)).toEqual(before);
    await captureOrgEvidence(page, 'spend-refusal-paused');

    // Choosing a source switches THIS conversation; the person sends again and it goes through.
    await ownCredits.click();
    await expect(page.getByText('This conversation now spends from Your credits. Send your message again.')).toBeVisible();
    await sendChatMessage(chat, 'Summarize the launch plan');
    await expect(chat.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(card).toHaveCount(0);
    expect(await mockCallCount(request)).toBe(callsBefore + 1);
    await expectPersonalCharge(w, before);
  });

  test('SPEND-2 (partial) SPEND-3 (partial) a fresh global draft chooses its wallet before the first message, remains out of history until sent, and charges the chosen personal wallet', async ({ browser, baseURL, request }) => {
    const w = await seedSpendWorld();
    const page = await openAs(browser, w.marcus, baseURL!);
    await page.goto(`/dashboard/${w.productId}`);
    const globalChat = page.getByTestId('global-assistant-view');
    await expect(globalChat).toBeVisible();
    const strip = globalChat.getByTestId('composer-spend-strip');
    await expect(strip).toContainText('Spending from Product wallet', { timeout: 30_000 });
    const draftId = await globalChat.evaluate((node) => node.closest('[data-spend-surface]')?.getAttribute('data-spend-surface'));
    expect(draftId).toBeTruthy();
    expect(await db.select().from(conversations).where(eq(conversations.id, draftId!))).toEqual([]);
    const before = await financialState(w);

    await strip.getByRole('button', { name: 'Change' }).click();
    const choices = page.getByRole('dialog').filter({ hasText: 'Your credits' });
    await choices.getByRole('radio', { name: /^Your credits/ }).click();
    await expect(strip).toContainText('Spending from Your credits');
    await expect(page.locator('header').getByTestId('spend-source-chip')).toHaveAttribute('aria-label', /^Spending from Your credits:/);
    const personal = await getBalance(w.marcus.userId);
    const [draft] = await db.select().from(conversations).where(eq(conversations.id, draftId!));
    expect(draft).toMatchObject({ userId: w.marcus.userId, type: 'global', chosenWalletId: personal!.id });
    expect(await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.conversationId, draftId!))).toEqual([]);
    const hiddenHistory = await page.request.get('/api/ai/global');
    expect(hiddenHistory.ok()).toBe(true);
    expect(((await hiddenHistory.json()) as { id: string }[]).some((row) => row.id === draftId)).toBe(false);
    expect(await mockCallCount(request)).toBe(0);
    expect(await financialState(w)).toEqual(before);
    await captureOrgEvidence(page, 'fresh-global-draft-own-choice');

    await sendChatMessage(globalChat, 'Summarize the launch plan');
    await expect(globalChat.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible({ timeout: 60_000 });
    expect(await mockCallCount(request)).toBe(1);
    await expectPersonalCharge(w, before);
    const visibleHistory = await page.request.get('/api/ai/global');
    expect(((await visibleHistory.json()) as { id: string }[]).some((row) => row.id === draftId)).toBe(true);
    await captureOrgEvidence(page, 'fresh-global-draft-first-reply');
  });

  for (const unavailableSource of ['paused', 'empty'] as const) {
    test(`UI-8 (partial) an allowed ${unavailableSource}-wallet fallback discloses personal spend in the strip, chip and reply and charges only that wallet`, async ({ browser, baseURL, request }) => {
      const w = await seedSpendWorld();
      await db.update(organizations).set({ policies: { walletFallback: 'own_credits' } }).where(eq(organizations.id, w.org.orgId));
      await db.update(wallets).set({
        status: unavailableSource === 'paused' ? 'paused' : 'active',
        ...(unavailableSource === 'empty' ? { monthlyAllowanceCents: 0 } : {}),
        fallbackRule: 'own_credits',
      }).where(eq(wallets.id, w.walletId));
      const pageId = await createAgentPage(w.productId, w.marcus.userId);
      const page = await openAs(browser, w.marcus, baseURL!);
      await gotoChatPage(page, w.productId, pageId);
      const chat = page.getByTestId('session-chat');
      await expect(chat.getByTestId('composer-spend-strip')).toContainText('Spending from Your credits');
      await expect(chat.getByTestId('composer-spend-strip')).toContainText('Product wallet cannot cover this');
      await expect(page.locator('header').getByTestId('spend-source-chip')).toHaveAttribute('aria-label', /^Spending from Your credits:/);
      const before = await financialState(w);
      await sendChatMessage(chat, 'Summarize the launch plan');
      const fallbackNotice = chat.getByRole('status').filter({ hasText: "Used your own credits because Product wallet couldn't cover this." });
      await expect(fallbackNotice).toBeVisible({ timeout: 60_000 });
      await expect(fallbackNotice.getByRole('button', { name: 'Change' })).toBeVisible();
      await expect(chat.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible();
      expect(await mockCallCount(request)).toBe(1);
      await expectPersonalCharge(w, before);
      await captureOrgEvidence(page, `spend-fallback-${unavailableSource}`);
    });
  }

  test('UI-8 (partial) persisted scheduled-workflow states show the creator and wallet, explain a skipped run and disable a departed creator', async ({ browser, baseURL }) => {
    const w = await seedSpendWorld();
    const agentPageId = await createAgentPage(w.productId, w.jono.userId);
    const [scheduled, departed] = await db.insert(workflows).values([
      { driveId: w.productId, createdBy: w.jono.userId, name: 'Weekly digest', agentPageId, prompt: 'Summarize', cronExpression: '0 9 * * 1', isEnabled: true },
      { driveId: w.productId, createdBy: null, name: 'Departed creator digest', agentPageId, prompt: 'Summarize', cronExpression: '0 9 * * 1', isEnabled: false, ownerLeftAt: new Date() },
    ]).returning({ id: workflows.id });
    await db.insert(workflowRuns).values({ workflowId: scheduled.id, sourceTable: 'cron', status: 'cancelled', error: 'AI credit gate denied: source_refused (drive_wallet_empty)', endedAt: new Date() });
    const page = await openAs(browser, w.jono, baseURL!);
    await page.goto(`/dashboard/${w.productId}/workflows`);
    const scheduledRow = page.getByRole('row').filter({ hasText: 'Weekly digest' });
    await expect(scheduledRow.getByTestId('automation-spends-as')).toContainText('Created by Jono');
    await scheduledRow.getByText('As Jono', { exact: true }).hover();
    const spendDetail = page.getByRole('tooltip');
    await expect(spendDetail).toContainText('Each scheduled run spends only Product wallet, as Jono under their caps');
    await expect(spendDetail).toContainText("never falls back to anyone's own credits");
    await expect(spendDetail).toContainText('A channel mention or a manual Run counts against whoever triggered it.');
    await expect(scheduledRow.getByTestId('automation-skipped')).toHaveAttribute('aria-label', 'Skipped: Product wallet was empty.');
    const departedRow = page.getByRole('row').filter({ hasText: 'Departed creator digest' });
    await expect(departedRow.getByTestId('automation-owner-left')).toContainText('Disabled until an org Owner or Admin reassigns or deletes it.');
    await expect(departedRow.getByRole('switch')).toBeDisabled();
    await expect(departedRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await expect(departedRow.getByRole('button', { name: 'Run workflow' })).toBeDisabled();
    expect((await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, departed.id)))).toEqual([]);
    await captureOrgEvidence(page, 'workflow-spend-states');
  });

});
