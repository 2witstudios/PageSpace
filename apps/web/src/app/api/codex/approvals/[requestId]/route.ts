import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { hasBetaFeature, BETA_FEATURES } from '@pagespace/lib/services/beta-features';
import { resolveApproval } from '@/lib/codex/process-manager';
import type { ApprovalDecision } from '@/lib/codex/types';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ requestId: string }> };

const VALID_DECISIONS: ApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

export async function POST(request: Request, context: RouteContext) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { betaFeatures: true },
  });

  if (!hasBetaFeature(user ?? { betaFeatures: [] }, BETA_FEATURES.CODEX)) {
    return NextResponse.json({ error: 'Codex access not enabled' }, { status: 403 });
  }

  const { requestId } = await context.params;
  const body = await request.json() as { decision?: string };
  const decision = body.decision as ApprovalDecision | undefined;

  if (!decision || !VALID_DECISIONS.includes(decision)) {
    return NextResponse.json(
      { error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` },
      { status: 400 },
    );
  }

  const resolved = resolveApproval(auth.userId, requestId, decision);
  if (!resolved) {
    return NextResponse.json({ error: 'Approval request not found or already resolved' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
