import { runRetentionCleanup } from '@pagespace/lib/compliance/retention/retention-engine';
import { db } from '@pagespace/db';
import { audit } from '@pagespace/lib/audit/audit-log';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to run data retention cleanup across all tables with expiresAt columns.
 *
 * Deletes expired rows from: sessions, verification_tokens, socket_tokens,
 * email_unsubscribe_tokens, pulse_summaries, page_versions (unpinned),
 * drive_backups (unpinned), drive_invitations (pending), page_permissions,
 * and ai_usage_logs.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const results = await runRetentionCleanup(db as Parameters<typeof runRetentionCleanup>[0]);
    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    console.log(`[Cron] Retention cleanup complete: ${totalDeleted} expired rows removed`);
    for (const r of results) {
      if (r.deleted > 0) {
        console.log(`[Cron]   ${r.table}: ${r.deleted} deleted`);
      }
    }

    audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'retention_cleanup', details: { totalDeleted, tables: results } });

    return NextResponse.json({
      success: true,
      totalDeleted,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error running retention cleanup:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
