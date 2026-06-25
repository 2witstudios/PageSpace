import { collectAllUserData } from '@pagespace/lib/compliance/export/gdpr-export';
import {
  parseExportFormat,
  buildNativeExportFiles,
  buildPortableExportFiles,
  buildExportManifest,
} from '@pagespace/lib/compliance/export/export-format';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit, resetDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
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

  // Portability format selection (Art 20). `native` = per-section JSON (default);
  // `portable` = a single documented schema.org bundle. Unknown values → native.
  const format = parseExportFormat(new URL(request.url).searchParams.get('format'));

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

    // Build the file set for the requested format and append each as JSON.
    const files = format === 'portable' ? buildPortableExportFiles(data) : buildNativeExportFiles(data);
    for (const file of files) {
      archive.append(JSON.stringify(file.data, null, 2), { name: `pagespace-export-${dateStr}/${file.name}` });
    }

    // manifest.json documents the schema version + file inventory so the bundle
    // is self-describing (GDPR Art 20 portability).
    const manifest = buildExportManifest(files, { exportedAt: new Date(), format });
    archive.append(JSON.stringify(manifest, null, 2), { name: `pagespace-export-${dateStr}/manifest.json` });

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
