import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listAllUserBackups } from '@/services/api/drive-backup-service';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit');
    const offset = searchParams.get('offset');
    const parsedLimit = limit !== null ? Number.parseInt(limit, 10) : null;
    const parsedOffset = offset !== null ? Number.parseInt(offset, 10) : null;

    if (parsedLimit !== null && (Number.isNaN(parsedLimit) || parsedLimit < 0)) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }
    if (parsedOffset !== null && (Number.isNaN(parsedOffset) || parsedOffset < 0)) {
      return NextResponse.json({ error: 'Invalid offset parameter' }, { status: 400 });
    }

    const result = await listAllUserBackups(auth.userId, {
      limit: parsedLimit ?? undefined,
      offset: parsedOffset ?? undefined,
    });

    auditRequest(request, {
      eventType: 'data.read',
      userId: auth.userId,
      resourceType: 'backup',
      details: { operation: 'list_all_backups', count: result.backups.length },
    });

    return NextResponse.json({ backups: result.backups, total: result.total });
  } catch (error) {
    loggers.api.error('Error fetching user backups', error as Error);
    return NextResponse.json({ error: 'Failed to fetch backups' }, { status: 500 });
  }
}
