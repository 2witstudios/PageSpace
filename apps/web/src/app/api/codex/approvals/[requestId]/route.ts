import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { hasBetaFeature, BETA_FEATURES } from '@pagespace/lib/services/beta-features';
import { resolveApproval } from '@/lib/codex/process-manager';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteContext = { params: Promise<{ requestId: string }> };

const BodySchema = z.object({
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
});

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
  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const resolved = resolveApproval(auth.userId, requestId, parsed.data.decision);
  if (!resolved) {
    return NextResponse.json({ error: 'Approval request not found or already resolved' }, { status: 404 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: 'codex_approval',
    resourceId: requestId,
    details: { action: 'resolve_approval', decision: parsed.data.decision },
  });

  return NextResponse.json({ ok: true });
}
