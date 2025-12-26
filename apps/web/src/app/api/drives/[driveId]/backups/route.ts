import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createDriveBackup, listDriveBackups } from '@/services/api/drive-backup-service';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

const createBackupSchema = z.object({
  label: z.string().optional(),
  reason: z.string().optional(),
  source: z.enum(['manual', 'scheduled', 'pre_restore', 'system']).optional(),
  includeTrashed: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit');
    const offset = searchParams.get('offset');

    const result = await listDriveBackups(driveId, auth.userId, {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 403 });
    }

    return NextResponse.json({ backups: result.backups });
  } catch (error) {
    loggers.api.error('Error fetching drive backups', error as Error);
    return NextResponse.json({ error: 'Failed to fetch backups' }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const body = await request.json();
    const parsed = createBackupSchema.parse(body);

    const result = await createDriveBackup(driveId, auth.userId, parsed);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 403 });
    }

    return NextResponse.json({
      backupId: result.backupId,
      status: result.status,
      counts: result.counts,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    loggers.api.error('Error creating drive backup', error as Error);
    return NextResponse.json({ error: 'Failed to create backup' }, { status: 500 });
  }
}
