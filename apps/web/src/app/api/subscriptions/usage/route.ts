import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getUserUsageSummary } from '@/lib/subscription/usage-service';
import { loggers, securityAudit } from '@pagespace/lib/server';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) {
      return authResult;
    }

    const { userId } = authResult;
    const usageSummary = await getUserUsageSummary(userId);

    securityAudit.logDataAccess(userId, 'read', 'subscription_usage', 'self', { userId }).catch((error) => {
      loggers.security.warn('[Stripe] audit log failed', { error: error instanceof Error ? error.message : String(error), userId });
    });

    return NextResponse.json(usageSummary);

  } catch (error) {
    console.error('Error fetching usage:', error);
    return NextResponse.json(
      { error: 'Failed to fetch usage' },
      { status: 500 }
    );
  }
}