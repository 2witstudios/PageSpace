import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getLiveMachineInFlight } from '@pagespace/lib/billing/live-concurrency-query';
import { MACHINE_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { getCodeExecutionConcurrencyLimit } from '@pagespace/lib/services/sandbox/quota';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

const isSubscriptionTier = (value: string): value is SubscriptionTier =>
  value === 'free' || value === 'pro' || value === 'founder' || value === 'business';

/**
 * GET /api/credits/concurrency — the authenticated user's live agent-terminal
 * session count. `liveAgentSessions` is the literal COUNT the
 * `too_many_in_flight` gate checks against `MACHINE_MAX_INFLIGHT` (not an
 * approximation). `codeExecutionLimit` is the configured per-tier ceiling from
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

    const inFlight = await getLiveMachineInFlight(userId);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_concurrency',
      resourceId: 'self',
    });

    return NextResponse.json({
      liveAgentSessions: { inFlight, limit: MACHINE_MAX_INFLIGHT },
      codeExecutionLimit: getCodeExecutionConcurrencyLimit(tier),
    });
  } catch (error) {
    loggers.api.error('Error fetching concurrency status:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch concurrency status' }, { status: 500 });
  }
}
