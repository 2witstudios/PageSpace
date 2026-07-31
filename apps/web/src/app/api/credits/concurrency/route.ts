import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getLiveInFlightHolds } from '@pagespace/lib/billing/live-concurrency-query';
import { MACHINE_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { getCodeExecutionConcurrencyLimit } from '@pagespace/lib/services/sandbox/quota';
import { toSubscriptionTier, type SubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * GET /api/credits/concurrency — the authenticated user's live in-flight
 * credit-hold count. `inFlightHolds.count` is the literal COUNT the
 * `too_many_in_flight` gate checks against `MACHINE_MAX_INFLIGHT` on the
 * user's next Machine run (not an approximation) — it covers ALL of the
 * user's in-flight AI activity (chat/voice/machine alike), since
 * `credit_holds` has no per-source column to filter machine-only sessions
 * out. `codeExecutionLimit` is the configured per-tier ceiling from
 * quota.ts — that semaphore lives in server-process memory, so it has no
 * reliable cross-replica live count and is exposed as a static value only.
 *
 * Deliberately NOT audited (unlike its `/api/credits` and
 * `/api/credits/breakdown` siblings): those are one-shot page-load reads of
 * financial data, so one `data.read` audit row per view is meaningful
 * signal. This route is polled every 5s by `ConcurrencyCard` for as long as
 * the usage page stays open — auditing every poll would write ~720 rows/hour
 * per open tab into the tamper-evident audit table for a non-sensitive
 * advisory count (a user reading their own live status), drowning out
 * genuinely security-relevant events.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (isAuthError(auth)) return auth;

    const { userId } = auth;

    const rows = await db
      .select({ subscriptionTier: users.subscriptionTier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const rawTier = rows[0]?.subscriptionTier;
    const tier: SubscriptionTier = toSubscriptionTier(rawTier);

    const count = await getLiveInFlightHolds(userId);

    return NextResponse.json({
      inFlightHolds: { count, limit: MACHINE_MAX_INFLIGHT },
      codeExecutionLimit: getCodeExecutionConcurrencyLimit(tier),
    });
  } catch (error) {
    loggers.api.error('Error fetching concurrency status:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch concurrency status' }, { status: 500 });
  }
}
