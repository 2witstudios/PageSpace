import { randomBytes } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { creditBalances, creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { conversations } from '@pagespace/db/schema/conversations';
import { sessionService } from '../../../packages/lib/src/auth/session-service';
import { generateCSRFToken } from '../../../packages/lib/src/auth/csrf-utils';
import { hashToken } from '../../../packages/lib/src/auth/token-utils';

import type { SubscriptionTier as Tier } from '@pagespace/lib/billing/subscription-tiers';

export type { Tier };

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeededUser {
  userId: string;
  driveId: string;
  /** Raw opaque session token to put in the `session` cookie. */
  sessionToken: string;
  /** Valid X-CSRF-Token header value bound to the session. */
  csrf: string;
}

export interface SeedOptions {
  tier?: Tier;
  /** AI provider for this user. Defaults to 'openrouter' so calls hit the mock stub. */
  provider?: string;
  model?: string;
  monthlyRemainingCents?: number;
  monthlyAllowanceCents?: number;
  topupRemainingCents?: number;
  /** How far in the future the monthly window ends. Default +30d (active window). */
  monthlyWindowDays?: number;
}

/**
 * Create a fully provisioned user: row + owned drive + credit balance + a live session
 * (with matching CSRF token). Provider defaults to 'openrouter' so any AI call this user
 * makes is served by the mock stub.
 */
export async function seedUser(opts: SeedOptions = {}): Promise<SeededUser> {
  const tier = opts.tier ?? 'pro';
  const user = await factories.createUser({
    subscriptionTier: tier,
    currentAiProvider: opts.provider ?? 'openrouter',
    currentAiModel: opts.model ?? 'e2e/stub-model',
  });
  const drive = await factories.createDrive(user.id);

  await setBalance(user.id, {
    monthlyRemainingCents: opts.monthlyRemainingCents ?? 10_000,
    monthlyAllowanceCents: opts.monthlyAllowanceCents ?? 10_000,
    topupRemainingCents: opts.topupRemainingCents ?? 0,
    monthlyWindowDays: opts.monthlyWindowDays ?? 30,
  });

  const sessionToken = await sessionService.createSession({
    userId: user.id,
    type: 'user',
    scopes: [],
    expiresInMs: 7 * DAY_MS,
  });
  const claims = await sessionService.validateSession(sessionToken);
  if (!claims) throw new Error('seedUser: session did not validate');
  const csrf = generateCSRFToken(claims.sessionId);

  return { userId: user.id, driveId: drive.id, sessionToken, csrf };
}

export async function setBalance(
  userId: string,
  b: {
    monthlyRemainingCents: number;
    monthlyAllowanceCents: number;
    topupRemainingCents: number;
    monthlyWindowDays?: number;
  },
): Promise<void> {
  const now = Date.now();
  const windowMs = (b.monthlyWindowDays ?? 30) * DAY_MS;
  const row = {
    userId,
    monthlyRemainingCents: b.monthlyRemainingCents,
    monthlyAllowanceCents: b.monthlyAllowanceCents,
    topupRemainingCents: b.topupRemainingCents,
    pendingMillicents: 0,
    monthlyPeriodStart: new Date(now - DAY_MS),
    monthlyPeriodEnd: new Date(now + windowMs),
    updatedAt: new Date(now),
  };
  await db
    .insert(creditBalances)
    .values(row)
    .onConflictDoUpdate({ target: creditBalances.userId, set: row });
}

export async function getBalance(userId: string) {
  const [row] = await db
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId));
  return row ?? null;
}

export async function getLedger(userId: string, entryType?: string) {
  const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, userId));
  return entryType ? rows.filter((r) => r.entryType === entryType) : rows;
}

export async function getHolds(userId: string) {
  return db.select().from(creditHolds).where(eq(creditHolds.userId, userId));
}

/** Pre-seed N active (non-expired) holds to simulate concurrent in-flight calls. */
export async function seedHolds(userId: string, count: number, estCents = 25): Promise<void> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  for (let i = 0; i < count; i++) {
    await db.insert(creditHolds).values({ userId, estCents, expiresAt });
  }
}

/**
 * Create an AI_CHAT page in the given drive and grant the user view+edit on it, so the
 * route's permission check passes and we reach the credit gate (chatId/agentId/pageId).
 */
export async function createAgentPage(driveId: string, userId: string): Promise<string> {
  const page = await factories.createPage(driveId, { type: 'AI_CHAT' });
  await factories.createPagePermission(page.id, userId, { canView: true, canEdit: true });
  return page.id;
}

/**
 * Seed one AI_CHAT conversation: a `conversations` row plus the `chat_messages` rows sharing
 * its id, alternating user/assistant from `contents`, each a second apart so the loader's
 * createdAt ordering is unambiguous.
 *
 * The `conversations` row is NOT optional. `conversationRepository.listConversations` (and
 * `countConversations`) LEFT JOIN `conversations` and then filter
 * `WHERE conv."userId" = $user OR conv."isShared" = true` — with no row the join yields NULL,
 * both predicates are NULL, and the conversation is invisible to the history list even though
 * its messages exist. The page would open a fresh empty conversation instead of the seeded
 * one. Shape mirrors the app's own `createConversation` (type 'page', contextId = pageId).
 *
 * Plain-text `content` is deliberate and safe: `parseStructuredContent` returns null for
 * non-JSON and the loader falls back to a simple text part
 * (apps/web/src/lib/ai/core/message-utils.ts) — so these rows render as ordinary bubbles.
 *
 * Returns the conversationId.
 */
export async function seedChatConversation(
  pageId: string,
  userId: string,
  opts: {
    /** Message bodies, alternating user → assistant → user … Defaults to a 4-turn exchange. */
    contents?: string[];
    conversationId?: string;
    /** createdAt of the first row; each subsequent row is +1s. Default: a minute ago. */
    startedAt?: Date;
  } = {},
): Promise<string> {
  const conversationId = opts.conversationId ?? createId();
  const contents = opts.contents ?? [
    'first user message',
    'first assistant reply',
    'second user message',
    'second assistant reply',
  ];
  const startedAt = opts.startedAt ?? new Date(Date.now() - 60_000);
  const lastMessageAt = new Date(startedAt.getTime() + (contents.length - 1) * 1000);

  await db
    .insert(conversations)
    .values({
      id: conversationId,
      userId,
      type: 'page',
      contextId: pageId,
      isShared: false,
      lastMessageAt,
      updatedAt: lastMessageAt,
    })
    .onConflictDoNothing();

  for (let i = 0; i < contents.length; i++) {
    await factories.createChatMessage(pageId, {
      conversationId,
      userId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: contents[i],
      createdAt: new Date(startedAt.getTime() + i * 1000),
    });
  }
  return conversationId;
}

export interface SeededChatPage {
  pageId: string;
  /** The older conversation. */
  conversationA: string;
  /** The newer conversation — what the page opens on. */
  conversationB: string;
}

/**
 * An AI_CHAT page with TWO seeded conversations, both non-empty. This is the shape the
 * switch-and-return spec (7.3) and the history specs (7.5) need: switching between two
 * conversations that each have enough messages to visibly render is what makes a blanked
 * list detectable.
 */
export async function seedChatPage(userId: string, driveId: string): Promise<SeededChatPage> {
  const pageId = await createAgentPage(driveId, userId);
  const conversationA = await seedChatConversation(pageId, userId, {
    contents: ['conversation A: user asks', 'conversation A: assistant answers'],
    startedAt: new Date(Date.now() - 120_000),
  });
  const conversationB = await seedChatConversation(pageId, userId, {
    contents: ['conversation B: user asks', 'conversation B: assistant answers'],
    startedAt: new Date(Date.now() - 60_000),
  });
  return { pageId, conversationA, conversationB };
}

/** Create a global conversation owned by the user (for /api/ai/global/[id]/messages). */
export async function createGlobalConversation(userId: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ userId, type: 'global', title: 'e2e' })
    .returning();
  return row.id;
}

/**
 * Seed a billed OpenRouter chat call that is still awaiting cost reconcile: an
 * `ai_usage_logs` row (provider=openrouter, reconcileStatus='pending', carrying the
 * generation id in metadata.generationIds, timestamped past the reconcile grace window)
 * plus its base `usage` credit_ledger row (reconcile only CORRECTS an already-billed
 * call). `billedCostDollars` is what we charged inline; the cron will fetch the
 * authoritative `/generation` cost and correct any drift. Returns the row ids.
 */
export async function seedPendingReconcileCall(
  userId: string,
  opts: { generationId: string; billedCostDollars: number; chargedCents: number },
): Promise<{ aiUsageLogId: string; generationId: string }> {
  // Older than cost-reconcile's 2-minute grace window so it's eligible immediately.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const [log] = await db
    .insert(aiUsageLogs)
    .values({
      userId,
      provider: 'openrouter',
      model: 'e2e/stub-model',
      cost: opts.billedCostDollars,
      timestamp: tenMinAgo,
      reconcileStatus: 'pending',
      reconcileAttempts: 0,
      metadata: { generationIds: [opts.generationId] },
    })
    .returning({ id: aiUsageLogs.id });

  await db.insert(creditLedger).values({
    userId,
    entryType: 'usage',
    bucket: 'monthly',
    amountCents: -opts.chargedCents,
    appliedCents: -opts.chargedCents,
    chargeMillicents: opts.chargedCents * 1000,
    realCostCents: Math.round(opts.billedCostDollars * 100),
    aiUsageLogId: log.id,
  });

  return { aiUsageLogId: log.id, generationId: opts.generationId };
}

/** Read the ai_usage_logs row for a given id (to assert reconcileStatus transitions). */
export async function getAiUsageLog(id: string) {
  const [row] = await db.select().from(aiUsageLogs).where(eq(aiUsageLogs.id, id));
  return row ?? null;
}

/** Insert an MCP bearer token for the user; returns the raw `mcp_...` token. */
export async function createMcpToken(userId: string): Promise<string> {
  const raw = `mcp_${randomBytes(24).toString('hex')}`;
  await db.insert(mcpTokens).values({
    userId,
    tokenHash: hashToken(raw),
    tokenPrefix: raw.slice(0, 12),
    name: 'e2e',
    isScoped: false,
  });
  return raw;
}
