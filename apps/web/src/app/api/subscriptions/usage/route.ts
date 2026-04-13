import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { getUserUsageSummary } from '@/lib/subscription/usage-service';
import { auditRequest } from '@pagespace/lib/server';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
    if (isAuthError(authResult)) {
      return authResult;
    }

    const { userId } = authResult;
    const usageSummary = await getUserUsageSummary(userId);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'subscription_usage', resourceId: 'self' });

    return NextResponse.json(usageSummary);

  } catch (error) {
    console.error('Error fetching usage:', error);
    return NextResponse.json(
      { error: 'Failed to fetch usage' },
      { status: 500 }
    );
  }
}