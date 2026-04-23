import { collectAllUserData } from '@pagespace/lib/compliance/export/gdpr-export';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit, resetDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security';
import { auditRequest } from '@pagespace/lib/server';
import archiver from 'archiver';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

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

  // Rate limiting (distributed via Postgres rate_limit_buckets)
  const rateLimitKey = `export:user:${userId}`;
  const rateLimitResult = await checkDistributedRateLimit(
    rateLimitKey,
    DISTRIBUTED_RATE_LIMITS.EXPORT_DATA
  );

  if (!rateLimitResult.allowed) {
    return Response.json(
      { error: 'Export rate limit exceeded. You can request one export per 24 hours.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rateLimitResult.retryAfter || 86400) },
      }
    );
  }

  try {
    const data = await collectAllUserData(
      db as Parameters<typeof collectAllUserData>[0],
      userId,
    );

    if (!data) {
      await resetDistributedRateLimit(rateLimitKey);
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    auditRequest(request, { eventType: 'data.export', userId, resourceType: 'account', resourceId: userId, details: { operation: 'gdpr_export' } });

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
    archive.append(JSON.stringify(data.sessions, null, 2), { name: `pagespace-export-${dateStr}/sessions.json` });
    archive.append(JSON.stringify(data.notifications, null, 2), { name: `pagespace-export-${dateStr}/notifications.json` });
    archive.append(JSON.stringify(data.displayPreferences, null, 2), { name: `pagespace-export-${dateStr}/display-preferences.json` });
    if (data.personalization) {
      archive.append(JSON.stringify(data.personalization, null, 2), { name: `pagespace-export-${dateStr}/personalization.json` });
    }

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
    await resetDistributedRateLimit(rateLimitKey);
    console.error('[GDPR Export] Error generating export:', error);
    return Response.json(
      { error: 'Failed to generate data export' },
      { status: 500 }
    );
  }
}
