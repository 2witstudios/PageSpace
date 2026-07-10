import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { fetchAndComputeRestoreDiff } from '@/services/api/restore-diff-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; backupId: string }> },
) {
  const { driveId, backupId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const isAdmin = await isDriveOwnerOrAdmin(auth.userId, driveId);
    if (!isAdmin) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const result = await fetchAndComputeRestoreDiff(backupId, driveId, db);
    if (!result.ok) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 400 });
    }

    return NextResponse.json({ diff: result.diff });
  } catch (error) {
    loggers.api.error('Error computing restore diff', error as Error);
    return NextResponse.json({ error: 'Failed to compute diff' }, { status: 500 });
  }
}
