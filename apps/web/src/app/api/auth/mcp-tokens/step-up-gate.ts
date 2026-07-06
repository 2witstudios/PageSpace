import { NextRequest, NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';

export interface RequireStepUpGrantParams {
  readonly req: NextRequest;
  readonly userId: string;
  readonly stepUpToken: string | undefined;
  readonly actionBinding: Record<string, string>;
  readonly missingReason: string;
  readonly invalidReason: string;
}

/**
 * Shared step-up gate for the mcp-tokens mint (POST) and update (PATCH)
 * routes — both are credential-escalation operations requiring a live
 * step-up grant bound to this exact action before anything is read or
 * written. Extracted so the missing-token check, audit logging, and
 * grant-consumption handling can't independently drift between the two
 * routes the way it once did (one route dropped `.min(1)` from its
 * `stepUpToken` schema while the other kept it, reopening the empty-string
 * oracle in only one place).
 */
export async function requireStepUpGrant({
  req,
  userId,
  stepUpToken,
  actionBinding,
  missingReason,
  invalidReason,
}: RequireStepUpGrantParams): Promise<NextResponse | null> {
  if (!stepUpToken) {
    auditRequest(req, { eventType: 'authz.access.denied', userId, details: { reason: missingReason } });
    return NextResponse.json({ error: 'step_up_required' }, { status: 401 });
  }

  const stepUpResult = await consumeStepUpGrant({ userId, token: stepUpToken, actionBinding });
  if (!stepUpResult.ok) {
    auditRequest(req, { eventType: 'authz.access.denied', userId, details: { reason: invalidReason } });
    return NextResponse.json({ error: 'step_up_required' }, { status: 401 });
  }

  return null;
}
