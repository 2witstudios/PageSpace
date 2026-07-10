/**
 * DELETE /api/account/oauth-grants/[grantId] (Phase 8 task
 * cg0aqe6bu21qg2tj7lgswf38).
 *
 * Session-authenticated, step-up gated revoke of a single OAuth grant by row
 * id — the write half of the connected-apps settings surface. Distinct from
 * `/api/oauth/revoke` (RFC 7009, deliberately unauthenticated-by-protocol,
 * keyed by the presented token itself): this route is identity-based, keyed
 * by the grant's row id, and requires a live session.
 *
 * Zero trust: `findOAuthGrantById` looks up by id ALONE (no userId filter in
 * the query) — ownership is checked here, in JS, against `isGrantOwnedByUser`
 * (pure), and a foreign grant produces the exact same 404 an unknown id
 * does. There is no oracle distinguishing "doesn't exist" from "not yours".
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isGrantOwnedByUser } from '@pagespace/lib/auth/oauth/grant-ownership';
import { findOAuthGrantById, revokeOAuthGrantFamily } from '@/lib/repositories/oauth-repository';
import { requireStepUpGrant } from '@/app/api/auth/mcp-tokens/step-up-gate';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// No `.min(1)` — an empty string must fail the same falsy check a missing
// field does, so `requireStepUpGrant` reports both with the identical shape
// (see step-up-gate.ts's own docstring for the bug this convention fixed).
const bodySchema = z.object({ stepUpToken: z.string().optional() });

export async function DELETE(req: NextRequest, context: { params: Promise<{ grantId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { grantId } = await context.params;

  try {
    const body = await req.json().catch(() => ({}));
    const { stepUpToken } = bodySchema.parse(body);

    const stepUpRejection = await requireStepUpGrant({
      req,
      userId,
      stepUpToken,
      actionBinding: { op: 'revoke_oauth_grant', grantId },
      missingReason: 'oauth_grant_revoke_missing_step_up',
      invalidReason: 'oauth_grant_revoke_step_up_invalid',
    });
    if (stepUpRejection) return stepUpRejection;

    const grant = await findOAuthGrantById(grantId);
    if (!isGrantOwnedByUser(grant, userId)) {
      return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
    }

    await revokeOAuthGrantFamily(grant.familyId, new Date());

    auditRequest(req, { eventType: 'auth.token.revoked', userId, details: { tokenType: 'oauth_refresh', reason: 'user_revoked' } });

    return NextResponse.json({ message: 'Grant revoked successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    loggers.auth.error('Error revoking OAuth grant:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke grant' }, { status: 500 });
  }
}
