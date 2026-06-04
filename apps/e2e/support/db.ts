import { randomBytes } from 'crypto';
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

export type Tier = 'free' | 'pro' | 'founder' | 'business';

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
