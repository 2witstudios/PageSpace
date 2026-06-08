import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { streamBackupExport } from '@/services/api/backup-export-service';
import { getExportContentDisposition } from './utils';

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

  let stream: AsyncGenerator<Buffer>;
  try {
    stream = streamBackupExport(backupId, driveId, auth.userId);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== undefined && status >= 400 && status < 500) {
      return NextResponse.json({ error: (err as Error).message }, { status });
    }
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }

  const readable = new ReadableStream<Buffer>({
    async start(controller) {
      for await (const chunk of stream) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': getExportContentDisposition(backupId),
      'Cache-Control': 'no-store',
    },
  });
}
