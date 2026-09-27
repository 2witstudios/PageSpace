/**
 * processZoomWebhook end to end against a real Postgres (Spec SPEND-6, point-guard ruling on
 * #2731): who pays for a transcript's AI enrichment, and that no refusal blocks the page.
 *
 * apps/web loads @pagespace/lib from its built dist, whose ORGS_ENABLED is the shipped constant
 * (false): this suite proves the path production runs today. The org cases — an org destination's
 * wallet pays, and empty/paused/missing skips with the lead's notice and no fallback to the
 * connection owner — run with orgs ON through the same payer seam (destinationDriveSpend) in
 * packages/lib automation-spend.integration.test.ts, where the flag reaches the gate.
 *
 *   (b) the connection owner's own personal drive: their own wallet pays both calls, as on master;
 *   (c) a refusal, and a gate that cannot be checked, both create the page without enrichment and
 *       record why (#2729).
 *
 * REAL: the credit gate, holds, and settlement (AIMonitoring.trackUsage → consumeCredits). Faked:
 * Zoom's API, the model, and page creation (it only receives the page and its metadata).
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { notifications } from '@pagespace/db/schema/notifications';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { automationSkipNotices, wallets } from '@pagespace/db/schema/wallets';
import type { ZoomConnection } from '@pagespace/db/schema/zoom';
import { factories } from '@pagespace/db/test/factories';
import { ensureTestDb } from '@/test/ensure-test-db';

const { flags, mockGenerateText, mockCreatePage } = vi.hoisted(() => ({
  flags: { orgsEnabled: false },
  mockGenerateText: vi.fn(),
  mockCreatePage: vi.fn(),
}));

// Pinned to the shipped value for process-webhook's own read (the lib dist reads its constant).
vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({ model: {}, provider: 'anthropic', modelName: 'claude-3-haiku-20240307' })),
  isProviderError: (p: unknown) => typeof p === 'object' && p !== null && 'error' in p,
}));
vi.mock('@/services/api', () => ({ pageService: { createPage: mockCreatePage } }));
vi.mock('../token-refresh', () => ({
  getValidZoomAccessToken: vi.fn(async () => ({ success: true, accessToken: 'tok' })),
}));
vi.mock('../zoom-api-client', () => ({
  getRecordings: vi.fn(async () => ({
    success: true,
    data: { recording_files: [{ file_type: 'TRANSCRIPT', download_url: 'https://zoom.example/t.vtt' }] },
  })),
  downloadTranscript: vi.fn(async () => ({
    success: true,
    data: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAda: We ship Friday.\n',
  })),
}));

import { processZoomWebhook } from '../process-webhook';

interface World {
  orgId: string;
  productId: string;
  marcusDriveId: string;
  marcusId: string;
  jonoId: string;
  poolId: string;
  productWalletId: string | null;
  marcusWalletId: string;
  userIds: string[];
}

let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;
const MARCUS_CENTS = 5_000;

/**
 * Northwind: Jono owns the org and leads Product (Open); Marcus, an org member, connected Zoom
 * and holds his own well-funded credits and a personal drive with no drive wallet.
 */
async function build(product: { allocationCents: number; status?: 'active' | 'paused' } | 'no-wallet'): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const productDrive = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(productDrive.id, marcus.id, { source: 'org' });
  const marcusDrive = await factories.createDrive(marcus.id, { name: 'Marcus notes', slug: `marcus-${createId()}` });

  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 5_000 }).returning();
  const productWalletId = product === 'no-wallet'
    ? null
    : (await db.insert(wallets).values({
        ownerType: 'org',
        orgId: org.id,
        subjectType: 'drive',
        subjectId: productDrive.id,
        parentWalletId: pool.id,
        monthlyAllowanceCents: product.allocationCents,
        status: product.status ?? 'active',
      }).returning())[0].id;
  const [marcusWallet] = await db.insert(wallets).values({
    userId: marcus.id,
    monthlyRemainingCents: MARCUS_CENTS,
    monthlyAllowanceCents: MARCUS_CENTS,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return {
    orgId: org.id,
    productId: productDrive.id,
    marcusDriveId: marcusDrive.id,
    marcusId: marcus.id,
    jonoId: jono.id,
    poolId: pool.id,
    productWalletId,
    marcusWalletId: marcusWallet.id,
    userIds: [jono.id, marcus.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(notifications).where(inArray(notifications.userId, w.userIds));
  await db.delete(automationSkipNotices).where(inArray(automationSkipNotices.driveId, [w.productId, w.marcusDriveId]));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.marcusDriveId]));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const connectionFor = (w: World, targetDriveId: string) => ({
  userId: w.marcusId,
  zoomUserId: 'zoom-host',
  zoomAccountId: 'acct',
  targetDriveId,
  targetFolderId: null,
  status: 'active',
  includeTranscript: false,
  includeAiSummary: true,
  includeActionItems: true,
}) as unknown as ZoomConnection;

const event = {
  event: 'recording.transcript_completed',
  payload: {
    account_id: 'acct',
    object: { uuid: 'meeting-uuid', host_id: 'zoom-host', host_email: 'host@example.com', topic: 'Standup', start_time: '2026-09-01T10:00:00Z', duration: 15 },
  },
};

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const ledgerOf = (userIds: string[]) => db.select().from(creditLedger).where(inArray(creditLedger.userId, userIds));
const liveHoldsOf = (userIds: string[]) => db.select().from(creditHolds).where(inArray(creditHolds.userId, userIds));
const createdMetadata = () => mockCreatePage.mock.calls[0][2].context.metadata as Record<string, unknown>;
const createdContent = () => mockCreatePage.mock.calls[0][1].content as string;

/** Both enrichment calls settle asynchronously (fire-and-forget usage tracking): wait for both usage rows. */
async function settledUsage(w: World) {
  await vi.waitFor(async () => {
    const ledger = await ledgerOf(w.userIds);
    expect(ledger.filter((r) => r.entryType === 'usage')).toHaveLength(2);
  }, { timeout: 10_000, interval: 100 });
  return (await ledgerOf(w.userIds)).filter((r) => r.entryType === 'usage');
}

/** The skip decided nothing was spent: no model call, no usage, no hold left on anyone. */
async function expectNothingSpent(w: World) {
  expect(mockGenerateText).not.toHaveBeenCalled();
  expect((await ledgerOf(w.userIds)).filter((r) => r.entryType === 'usage')).toEqual([]);
  expect((await walletRow(w.marcusWalletId)).monthlyRemainingCents).toBe(MARCUS_CENTS);
}

describe('Zoom enrichment: the destination drive\'s payer pays (real Postgres)', () => {
  beforeAll(async () => {
    await ensureTestDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    flags.orgsEnabled = false;
    process.env.DEPLOYMENT_MODE = 'cloud';
    mockCreatePage.mockResolvedValue({ success: true, page: { id: 'page-1' } });
    mockGenerateText.mockImplementation(async ({ system }: { system: string }) => ({
      text: system.startsWith('Extract') ? '[{"text":"Ship it"}]' : '- Decided to ship Friday',
      usage: { inputTokens: 100_000, outputTokens: 20_000 },
    }));
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  it('SPEND-6 (partial) (b) the connection owner\'s own personal drive: their own wallet pays both calls, as on master', async () => {
    world = await build({ allocationCents: 1_000 });

    await processZoomWebhook(event, connectionFor(world, world.marcusDriveId));

    const usage = await settledUsage(world);
    expect(usage.map((r) => [r.userId, r.walletId])).toEqual([[world.marcusId, world.marcusWalletId], [world.marcusId, world.marcusWalletId]]);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBeLessThan(MARCUS_CENTS);
    expect((await walletRow(world.productWalletId as string)).spentCents).toBe(0);
    expect(createdMetadata()).not.toHaveProperty('aiEnrichmentSkipped');
  });

  it('(c) a refusal still creates the page, without enrichment or charge, and records why', async () => {
    world = await build({ allocationCents: 1_000 });
    await db.update(wallets).set({ monthlyRemainingCents: 0 }).where(eq(wallets.id, world.marcusWalletId));

    await processZoomWebhook(event, connectionFor(world, world.marcusDriveId));

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect((await ledgerOf(world.userIds)).filter((r) => r.entryType === 'usage')).toEqual([]);
    expect(await liveHoldsOf(world.userIds)).toEqual([]);
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdMetadata().aiEnrichmentSkipped).toEqual(expect.any(String));
    expect(createdMetadata().aiEnrichmentSkipped).not.toBe('gate_error');
    expect(createdContent()).not.toContain('Decided to ship Friday');
  });

  it('(c) a gate that cannot be checked still creates the page, without enrichment or charge, and records why', async () => {
    world = await build({ allocationCents: 1_000 });

    // The destination drive vanished between the connection's setup and the webhook: the payer
    // lookup throws inside the gate step.
    await expect(processZoomWebhook(event, connectionFor(world, createId()))).resolves.toBeUndefined();

    await expectNothingSpent(world);
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    expect(createdMetadata()).toMatchObject({ aiEnrichmentSkipped: 'gate_error' });
  });
});
