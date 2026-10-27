/**
 * Where an agent's spend lands (Spec SPEND-7) — real Postgres, the real gate and settle.
 *
 * Northwind has two org drives, each with its own drive wallet under the pool: Product (drive A),
 * where Marcus is working, and Research (drive B), where the agent page lives. An agent's spend is
 * attributed to the drive of the SESSION it runs in, never merely the drive the agent page lives
 * in: a consultation or completion named from a session in A, an API client thread opened in A,
 * and an ask_agent follow-on of a turn in A all reserve and settle on A's wallet and never touch
 * B's — and a stored source on the agent page's conversation (B's wallet) does not travel into A.
 * With no other session named, the agent's own conversation is the session: B pays (control).
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one. Deletes every row it
 * creates, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { drives, pages } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { agentCallSpend, conversationSpend, resolvedSpend, type SpendTarget } from '../spend-target';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  marcusId: string;
  jonoId: string;
  productId: string;
  researchId: string;
  agentPageId: string;
  poolId: string;
  productWalletId: string;
  researchWalletId: string;
  marcusWalletId: string;
  agentConversationId: string;
  clientThreadId: string;
  userIds: string[];
}

let world: World | null = null;

async function build(): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const research = await factories.createDrive(jono.id, { name: 'Research', slug: `research-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(research.id, marcus.id, { source: 'org' });
  const agent = await factories.createPage(research.id, { type: 'AI_CHAT', title: 'Research agent' });

  const [pool] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: 20_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  const driveWallet = async (driveId: string) => (await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    subjectType: 'drive',
    subjectId: driveId,
    parentWalletId: pool.id,
    monthlyAllowanceCents: 2_000,
  }).returning())[0].id;
  const productWalletId = await driveWallet(product.id);
  const researchWalletId = await driveWallet(research.id);
  const [marcusWallet] = await db.insert(wallets).values({
    userId: marcus.id,
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();

  // The agent's own conversation on its page (drive B), its source already stored as B's wallet;
  // and an API client thread Marcus opened in drive A.
  const agentConversationId = createId();
  const clientThreadId = createId();
  await db.insert(conversations).values([
    { id: agentConversationId, userId: marcus.id, type: 'page', contextId: agent.id, chosenWalletId: researchWalletId },
    { id: clientThreadId, userId: marcus.id, type: 'client', contextId: product.id, agentPageId: agent.id },
  ]);

  return {
    orgId: org.id,
    marcusId: marcus.id,
    jonoId: jono.id,
    productId: product.id,
    researchId: research.id,
    agentPageId: agent.id,
    poolId: pool.id,
    productWalletId,
    researchWalletId,
    marcusWalletId: marcusWallet.id,
    agentConversationId,
    clientThreadId,
    userIds: [jono.id, marcus.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(conversations).where(inArray(conversations.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(pages).where(eq(pages.id, w.agentPageId));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const ledgerOn = (walletId: string) => db.select().from(creditLedger).where(eq(creditLedger.walletId, walletId));
const holdsOn = (walletId: string) => db.select().from(creditHolds).where(eq(creditHolds.walletId, walletId));

/** Gate and settle one agent call on `spend`, its usage row attributed to `driveId`; returns the wallet it named. */
async function runAgentCall(w: World, spend: SpendTarget, driveId: string): Promise<string | undefined> {
  const gate = await canConsumeAI(w.marcusId, 'free', { spend, estCostCents: 5 });
  expect(gate.allowed).toBe(true);
  const [log] = await db.insert(aiUsageLogs).values({ userId: w.marcusId, provider: 'openrouter', model: 'm', cost: 0.1, pageId: w.agentPageId, driveId }).returning({ id: aiUsageLogs.id });
  expect(await consumeCredits({ aiUsageLogId: log.id, userId: w.marcusId, costDollars: 0.1, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
  return gate.walletId;
}

describe('SPEND-7 an agent\'s spend lands in the drive of the session it runs in', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('agent-session-spend.integration.test.ts', error);
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  it('SPEND-7 an agent living in drive B, consulted from a session in drive A, reserves and settles on drive A\'s wallet — never drive B\'s, and B\'s stored source on the agent\'s conversation does not travel into A', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    const researchBefore = await walletRow(w.researchWalletId);

    const spend = agentCallSpend({ agentDriveId: w.researchId, conversationId: w.agentConversationId, clientThreadDriveId: null, namedSessionDriveId: w.productId });
    const walletId = await runAgentCall(w, spend, w.productId);

    expect(walletId).toBe(w.productWalletId);
    expect((await ledgerOn(w.productWalletId)).filter((r) => r.entryType === 'usage')).toHaveLength(1);
    expect(await ledgerOn(w.researchWalletId)).toEqual([]);
    expect(await holdsOn(w.researchWalletId)).toEqual([]);
    expect(await walletRow(w.researchWalletId)).toMatchObject({ spentCents: researchBefore.spentCents });
    expect(await ledgerOn(w.marcusWalletId)).toEqual([]);
    const [usage] = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, w.marcusId));
    expect(usage).toMatchObject({ driveId: w.productId, pageId: w.agentPageId });
    // The agent's conversation keeps its own drive's stored source; A's wallet was never pinned onto it.
    expect((await db.select().from(conversations).where(eq(conversations.id, w.agentConversationId)))[0]?.chosenWalletId).toBe(w.researchWalletId);
  });

  it('SPEND-7 an API client thread is a session opened in drive A: a /v1 completion on it spends A\'s wallet, whatever drive the agent lives in', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const spend = agentCallSpend({ agentDriveId: w.researchId, conversationId: w.clientThreadId, clientThreadDriveId: w.productId, namedSessionDriveId: null });
    expect(await runAgentCall(w, spend, w.productId)).toBe(w.productWalletId);
    expect(await ledgerOn(w.researchWalletId)).toEqual([]);
  });

  it('SPEND-7 ask_agent from a turn in drive A follows that turn\'s resolved source in A — the consulted agent\'s drive B is never charged', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const turn = conversationSpend(w.productId, null);
    const first = await canConsumeAI(w.marcusId, 'free', { spend: turn, estCostCents: 5 });
    expect(first).toMatchObject({ allowed: true, walletId: w.productWalletId, spendSource: 'drive_wallet' });
    const followOn = resolvedSpend(turn, first.spendSource, first.fallbackFromWalletId);

    expect(await runAgentCall(w, followOn, w.productId)).toBe(w.productWalletId);
    expect(await ledgerOn(w.researchWalletId)).toEqual([]);
  });

  it('with no other session named, the agent\'s own conversation is the session: drive B pays, on its stored source (control)', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const spend = agentCallSpend({ agentDriveId: w.researchId, conversationId: w.agentConversationId, clientThreadDriveId: null, namedSessionDriveId: null });
    expect(await runAgentCall(w, spend, w.researchId)).toBe(w.researchWalletId);
    expect(await ledgerOn(w.productWalletId)).toEqual([]);
  });
});
