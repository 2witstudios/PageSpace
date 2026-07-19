import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getLiveInFlightHolds } from '@pagespace/lib/billing/live-concurrency-query';
import { MACHINE_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { getCodeExecutionConcurrencyLimit } from '@pagespace/lib/services/sandbox/quota';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

const isSubscriptionTier = (value: string): value is SubscriptionTier =>
  value === 'free' || value === 'pro' || value === 'founder' || value === 'business';

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
    const tier: SubscriptionTier = rawTier && isSubscriptionTier(rawTier) ? rawTier : 'free';

    const count = await getLiveInFlightHolds(userId);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_concurrency',
      resourceId: 'self',
    });

    return NextResponse.json({
      inFlightHolds: { count, limit: MACHINE_MAX_INFLIGHT },
      codeExecutionLimit: getCodeExecutionConcurrencyLimit(tier),
    });
  } catch (error) {
    loggers.api.error('Error fetching concurrency status:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch concurrency status' }, { status: 500 });
  }
}
