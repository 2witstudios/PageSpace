import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getUserUsageBreakdown } from '@/lib/subscription/usage-breakdown-query';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * GET /api/credits/breakdown — the authenticated user's prepaid-credit spend for the
 * current billing period, grouped by feature (chat, pulse, memory, voice, …) and by
 * model. Powers the usage-breakdown card on /settings/usage.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (isAuthError(auth)) return auth;

    const { userId } = auth;

    const breakdown = await getUserUsageBreakdown(userId);

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'credit_usage_breakdown',
      resourceId: 'self',
    });

    return NextResponse.json(breakdown);
  } catch (error) {
    loggers.api.error('Error fetching usage breakdown:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch usage breakdown' }, { status: 500 });
  }
}
