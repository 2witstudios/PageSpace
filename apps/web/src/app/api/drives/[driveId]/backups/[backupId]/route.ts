import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveBackupDetail } from '@/services/api/drive-backup-service';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ driveId: string; backupId: string }> },
) {
  const { driveId, backupId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    const result = await getDriveBackupDetail(backupId, driveId, auth.userId);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 403 });
    }
    return NextResponse.json(result.detail);
  } catch (error) {
    loggers.api.error('Error fetching backup detail', error as Error);
    return NextResponse.json({ error: 'Failed to fetch backup detail' }, { status: 500 });
  }
}
