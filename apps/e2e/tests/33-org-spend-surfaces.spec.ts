import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
 * Focused scenarios retain their partial titles. The full journey below executes
 * every scenario together; canvas fidelity also needs review against the live canvas.
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

async function openAs(browser: Parameters<typeof authedContext>[0], user: SeededUser, baseURL: string, interceptRequests = false): Promise<Page> {
  const context = await authedContext(browser, user.sessionToken, baseURL, interceptRequests ? { serviceWorkers: 'block' } : {});
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
  const priorLedgerIds = new Set(before.ledger.map(row => row.id));
  const usage = (await getLedger(w.marcus.userId, 'usage')).filter(row => !priorLedgerIds.has(row.id));
  expect(usage).toHaveLength(1);
  expect(usage[0].walletId).toBe(personal!.id);
  expect(usage[0].appliedCents).toBeLessThan(0);
  const after = await financialState(w);
  expect(after.wallets.filter((wallet) => wallet.orgId === w.org.orgId)).toEqual(before.wallets.filter((wallet) => wallet.orgId === w.org.orgId));
  expect(after.usage.length).toBeGreaterThan(0);
  expect(after.usage.every((row) => row.walletId === personal!.id)).toBe(true);
  expect(await getHolds(w.marcus.userId)).toEqual([]);
}

interface SpendJourneyContext {
  browser: Browser;
  baseURL?: string;
  request: APIRequestContext;
}

async function chipAndPopoverJourney({ browser, baseURL }: Pick<SpendJourneyContext, 'browser' | 'baseURL'>) {
  const w = await seedSpendWorld();
  const page = await openAs(browser, w.marcus, baseURL!);
  const pulseResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pulse/generate' && response.request().method() === 'POST');
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
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await captureOrgEvidence(page, 'spend-chip-canvas-overview');
  // Finish background generation before the next isolated journey.
  expect((await pulseResponse).ok()).toBe(true);
  await expect.poll(async () => {
    const state = await financialState(w);
    return { pulse: state.usage.filter(row => row.source === 'pulse').length, ledger: state.ledger.filter(row => row.entryType === 'usage').length, holds: state.holds.length };
  }).toEqual({ pulse: 1, ledger: 1, holds: 0 });
}

async function pausedRefusalAndSwitchJourney({ browser, baseURL, request }: SpendJourneyContext) {
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
}

async function freshGlobalChoiceJourney({ browser, baseURL, request }: SpendJourneyContext) {
  const w = await seedSpendWorld();
  const page = await openAs(browser, w.marcus, baseURL!);
  const pulseResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/pulse/generate' && response.request().method() === 'POST');
  await page.goto(`/dashboard/${w.productId}`);
  const globalChat = page.getByTestId('global-assistant-view');
  await expect(globalChat).toBeVisible();
  const strip = globalChat.getByTestId('composer-spend-strip');
  await expect(strip).toContainText('Spending from Product wallet', { timeout: 30_000 });
  const draftId = await globalChat.evaluate((node) => node.closest('[data-spend-surface]')?.getAttribute('data-spend-surface'));
  expect(draftId).toBeTruthy();
  expect(await db.select().from(conversations).where(eq(conversations.id, draftId!))).toEqual([]);
  // The global dashboard generates a personal Pulse before any chat send.
  // Wait for its asynchronous billing too, so the choice has its own baseline.
  expect((await pulseResponse).ok()).toBe(true);
  await expect.poll(async () => {
    const state = await financialState(w);
    return { pulse: state.usage.filter(row => row.source === 'pulse').length, ledger: state.ledger.filter(row => row.entryType === 'usage').length, holds: state.holds.length };
  }).toEqual({ pulse: 1, ledger: 1, holds: 0 });
  expect(await mockCallCount(request)).toBe(1);
  const before = await financialState(w);
  const callsBefore = await mockCallCount(request);
  const callsUrl = `${process.env.E2E_MOCK_OPENROUTER_URL ?? 'http://127.0.0.1:4998'}/__calls`;
  expect(await (await request.get(callsUrl)).json()).toMatchObject({ requests: [{ stream: false, messageCount: 2 }] });

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
  expect(await mockCallCount(request)).toBe(callsBefore);
  expect(await financialState(w)).toEqual(before);
  await expect(choices).toHaveCount(0);
  await captureOrgEvidence(page, 'fresh-global-draft-own-choice');

  await sendChatMessage(globalChat, 'Summarize the launch plan');
  await expect(globalChat.locator('[data-testid="chat-message"][data-role="assistant"]').first()).toBeVisible({ timeout: 60_000 });
  expect(await mockCallCount(request)).toBe(callsBefore + 1);
  expect(await (await request.get(callsUrl)).json()).toMatchObject({ requests: [{ stream: false }, { stream: true }] });
  await expectPersonalCharge(w, before);
  const visibleHistory = await page.request.get('/api/ai/global');
  expect(((await visibleHistory.json()) as { id: string }[]).some((row) => row.id === draftId)).toBe(true);
  await captureOrgEvidence(page, 'fresh-global-draft-first-reply');
}

async function personalFallbackJourney({ browser, baseURL, request }: SpendJourneyContext, unavailableSource: 'paused' | 'empty') {
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
}

async function automationStatesJourney({ browser, baseURL }: Pick<SpendJourneyContext, 'browser' | 'baseURL'>) {
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
}

test.describe('UI-8 (partial) the spend surfaces for a member in an org drive', () => {
  test('UI-8 (partial) the header chip names the drive wallet in one short token, and its popover lists every source with who funds it', async ({ browser, baseURL }) => {
    await chipAndPopoverJourney({ browser, baseURL });
  });

  test('UI-8 (partial) the composer strip names the source before the first message, turns to "paused" when the drive wallet is, and the refusal card offers the other sources; choosing one lets the message through', async ({ browser, baseURL, request }) => {
    await pausedRefusalAndSwitchJourney({ browser, baseURL, request });
  });

  test('SPEND-2 (partial) SPEND-3 (partial) a fresh global draft chooses its wallet before the first message, remains out of history until sent, and charges the chosen personal wallet', async ({ browser, baseURL, request }) => {
    await freshGlobalChoiceJourney({ browser, baseURL, request });
  });

  for (const unavailableSource of ['paused', 'empty'] as const) {
    test(`UI-8 (partial) an allowed ${unavailableSource}-wallet fallback discloses personal spend in the strip, chip and reply and charges only that wallet`, async ({ browser, baseURL, request }) => {
      await personalFallbackJourney({ browser, baseURL, request }, unavailableSource);
    });
  }

  test('UI-8 (partial) persisted scheduled-workflow states show the creator and wallet, explain a skipped run and disable a departed creator', async ({ browser, baseURL }) => {
    await automationStatesJourney({ browser, baseURL });
  });

});

// New org/user fixtures and closed contexts isolate each provider and money baseline.
test('UI-8 Spending-from chip and popover, composer strip, refusal card, automation state per canvas page 2', async ({ browser, baseURL, request }) => {
  const context = { browser, baseURL, request };
  const isolatedStep = async (name: string, journey: () => Promise<void>) => {
    await test.step(name, async () => {
      await resetMock(request);
      try {
        await journey();
      } finally {
        await Promise.all(openContexts.splice(0).map(browserContext => browserContext.close()));
      }
    });
  };
  await isolatedStep('Chip and every funded source in the popover', () => chipAndPopoverJourney(context));
  await isolatedStep('Composer, paused refusal, source switch and personal charge', () => pausedRefusalAndSwitchJourney(context));
  await isolatedStep('Fresh global source choice before the first charged turn', () => freshGlobalChoiceJourney(context));
  await isolatedStep('Paused wallet fallback disclosed in composer, chip and reply', () => personalFallbackJourney(context, 'paused'));
  await isolatedStep('Empty wallet fallback disclosed in composer, chip and reply', () => personalFallbackJourney(context, 'empty'));
  await isolatedStep('Automation creator, wallet, skipped run and departed owner', () => automationStatesJourney(context));
});

test('JOURNEYS-1 the visible absolute global switch survives reload and charges personal credits on an org conversation', async ({ browser, baseURL, request }) => {
  const w = await seedSpendWorld();
  const pageId = await createAgentPage(w.productId, w.marcus.userId);
  const page = await openAs(browser, w.marcus, baseURL!);
  await page.goto('/settings/usage/wallets');
  const absolute = page.getByRole('switch', { name: 'Always my own credits, globally', exact: true });
  await expect(absolute).toBeEnabled();
  await absolute.click();
  await expect(absolute).toBeChecked();
  await page.reload();
  await expect(absolute).toBeChecked();
  await gotoChatPage(page, w.productId, pageId);
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('composer-spend-strip')).toContainText('Your credits');
  const before = await financialState(w);
  await resetMock(request);
  await sendChatMessage(chat, 'Summarize the launch plan');
  await expectPersonalCharge(w, before);
});

test('JOURNEYS-2 failed source previews pause Send and Enter without charging; retry shows the source before sending', async ({ browser, baseURL, request }) => {
  const w = await seedSpendWorld();
  const pageId = await createAgentPage(w.productId, w.marcus.userId);
  const page = await openAs(browser, w.marcus, baseURL!, true);
  let failPreview = true;
  let refusedPreviews = 0;
  await page.route('**/api/wallets/**', async route => {
    if (failPreview && route.request().method() === 'GET') {
      refusedPreviews += 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Preview unavailable"}' });
    } else await route.continue();
  });
  await gotoChatPage(page, w.productId, pageId);
  const chat = page.getByTestId('session-chat');
  await expect(chat.getByTestId('composer-spend-strip-error')).toBeVisible();
  expect(refusedPreviews).toBeGreaterThan(0);
  const before = await financialState(w);
  const callsBefore = await mockCallCount(request);
  await chat.getByTestId('chat-textarea').fill('Do not send while the source is unresolved');
  await expect(chat.getByTestId('chat-send')).toBeDisabled();
  await chat.getByTestId('chat-textarea').press('Enter');
  expect(await financialState(w)).toEqual(before);
  expect(await mockCallCount(request)).toBe(callsBefore);
  failPreview = false;
  await chat.getByTestId('composer-spend-retry').click();
  await expect(chat.getByTestId('composer-spend-strip')).toContainText('Product wallet');
  await sendChatMessage(chat, 'Summarize the launch plan');
  const prior = new Set(before.ledger.map(row => row.id));
  await expect.poll(async () => (await getLedger(w.marcus.userId, 'usage')).filter(row => !prior.has(row.id)).map(row => row.walletId)).toEqual([w.walletId]);
});

test('JOURNEYS-3 two independent windows show the persisted source change before the second window charges it', async ({ browser, baseURL, request }) => {
  const w = await seedSpendWorld();
  const pageId = await createAgentPage(w.productId, w.marcus.userId);
  const first = await openAs(browser, w.marcus, baseURL!);
  const previewRead = first.waitForResponse(response => response.request().method() === 'GET' && response.ok() && new URL(response.url()).pathname.startsWith('/api/wallets/conversations/') && !new URL(response.url()).searchParams.has('driveId'));
  await gotoChatPage(first, w.productId, pageId);
  const { conversationId } = await (await previewRead).json() as { conversationId: string };
  const firstChat = first.getByTestId('session-chat');
  await expect(firstChat.getByTestId('composer-spend-strip')).toContainText('Product wallet');
  const second = await openAs(browser, w.marcus, baseURL!);
  await second.goto(`/dashboard/${w.productId}/${pageId}?conversationId=${encodeURIComponent(conversationId)}`);
  const secondChat = second.getByTestId('session-chat');
  await expect(secondChat.getByTestId('composer-spend-strip')).toContainText('Product wallet');
  await firstChat.getByTestId('composer-spend-strip').getByRole('button', { name: 'Change', exact: true }).click();
  await first.getByRole('radiogroup', { name: 'Spending source', exact: true }).getByRole('radio', { name: /^Your credits/ }).click();
  await expect(firstChat.getByTestId('composer-spend-strip')).toContainText('Your credits');
  // No reload or focus-based refetch: the preference announcement must reach this window.
  await expect(secondChat.getByTestId('composer-spend-strip')).toContainText('Your credits', { timeout: 15_000 });
  const before = await financialState(w);
  await resetMock(request);
  await sendChatMessage(secondChat, 'Summarize the launch plan');
  await expectPersonalCharge(w, before);
});
