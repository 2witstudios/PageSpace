import { collectAllUserData } from '@pagespace/lib/compliance/export/gdpr-export';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import archiver from 'archiver';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

// Rate limit: track last export time per user (in-memory, resets on deploy)
const lastExportMap = new Map<string, number>();
const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * GET /api/account/export
 *
 * GDPR Article 15/20 data subject access request.
 * Returns a ZIP archive containing all user data.
 * Rate limited to 1 export per 24 hours.
 *
 * Authentication: Session-based only.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  // Rate limiting
  const lastExport = lastExportMap.get(userId);
  if (lastExport && Date.now() - lastExport < EXPORT_COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((EXPORT_COOLDOWN_MS - (Date.now() - lastExport)) / 1000);
    return Response.json(
      { error: 'Export rate limit exceeded. You can request one export per 24 hours.' },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfterSeconds) },
      }
    );
  }

  try {
    const data = await collectAllUserData(
      db as Parameters<typeof collectAllUserData>[0],
      userId,
    );

    if (!data) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    // Record this export for rate limiting
    lastExportMap.set(userId, Date.now());

    // Build ZIP archive
    const archive = archiver('zip', { zlib: { level: 6 } });
    const dateStr = new Date().toISOString().split('T')[0];

    // Bridge Node Readable → Web ReadableStream
    const readable = new ReadableStream({
      start(controller) {
        archive.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        archive.on('end', () => {
          controller.close();
        });
        archive.on('error', (err: Error) => {
          controller.error(err);
        });
      },
    });

    // Add JSON files to archive
    archive.append(JSON.stringify(data.profile, null, 2), { name: `pagespace-export-${dateStr}/profile.json` });
    archive.append(JSON.stringify(data.drives, null, 2), { name: `pagespace-export-${dateStr}/drives.json` });
    archive.append(JSON.stringify(data.pages, null, 2), { name: `pagespace-export-${dateStr}/pages.json` });
    archive.append(JSON.stringify(data.messages, null, 2), { name: `pagespace-export-${dateStr}/messages.json` });
    archive.append(JSON.stringify(data.files, null, 2), { name: `pagespace-export-${dateStr}/files-metadata.json` });
    archive.append(JSON.stringify(data.activity, null, 2), { name: `pagespace-export-${dateStr}/activity.json` });
    archive.append(JSON.stringify(data.aiUsage, null, 2), { name: `pagespace-export-${dateStr}/ai-usage.json` });
    archive.append(JSON.stringify(data.tasks, null, 2), { name: `pagespace-export-${dateStr}/tasks.json` });

    // Finalize the archive (must be called after all data is appended)
    archive.finalize();

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="pagespace-export-${dateStr}.zip"`,
      },
    });
  } catch (error) {
    console.error('[GDPR Export] Error generating export:', error);
    return Response.json(
      { error: 'Failed to generate data export' },
      { status: 500 }
    );
  }
}
