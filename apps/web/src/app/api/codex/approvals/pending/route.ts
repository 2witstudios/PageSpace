import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { hasBetaFeature, BETA_FEATURES } from '@pagespace/lib/services/beta-features';
import { getPendingApprovals } from '@/lib/codex/process-manager';

const AUTH_OPTIONS = { allow: ['session'] as const };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { betaFeatures: true },
  });

  if (!hasBetaFeature(user ?? { betaFeatures: [] }, BETA_FEATURES.CODEX)) {
    return NextResponse.json({ error: 'Codex access not enabled' }, { status: 403 });
  }

  const approvals = getPendingApprovals(auth.userId);
  return NextResponse.json({ approvals });
}
