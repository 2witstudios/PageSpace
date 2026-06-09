import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveBackupDetail } from '@/services/api/drive-backup-service';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

function safeFilePart(s: string | null | undefined): string {
  return (s ?? '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ driveId: string; backupId: string }> },
) {
  const { driveId, backupId } = await params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  try {
    const result = await getDriveBackupDetail(backupId, driveId, auth.userId);
    if (!result.success || !result.detail) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: result.status ?? 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { detail } = result;
    const datePart = detail.createdAt.toISOString().slice(0, 10);
    const slugPart = safeFilePart(detail.driveSlug ?? detail.driveName);
    const labelPart = safeFilePart(detail.label ?? detail.id);
    const filename = [slugPart, datePart, labelPart].filter(Boolean).join('_') + '.json';

    return new Response(JSON.stringify(detail, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    loggers.api.error('Error downloading backup', error as Error);
    return new Response(JSON.stringify({ error: 'Failed to download backup' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
