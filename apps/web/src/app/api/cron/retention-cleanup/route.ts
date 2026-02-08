import { runRetentionCleanup } from '@pagespace/lib/compliance/retention/retention-engine';
import { db } from '@pagespace/db';
import { NextResponse } from 'next/server';
import { validateCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to run data retention cleanup across all tables with expiresAt columns.
 *
 * Deletes expired rows from: sessions, verification_tokens, socket_tokens,
 * email_unsubscribe_tokens, pulse_summaries, page_versions (unpinned),
 * drive_backups (unpinned), drive_invitations (pending), page_permissions,
 * and ai_usage_logs.
 *
 * Authentication:
 * - Primary: CRON_SECRET Bearer token (timing-safe comparison)
 * - Defense-in-depth: internal network origin check
 *
 * Trigger via:
 * curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/retention-cleanup
 */
export async function GET(request: Request) {
  const authError = validateCronRequest(request);
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
