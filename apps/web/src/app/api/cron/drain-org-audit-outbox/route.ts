import { drainOrgAuditOutbox, getOrgAuditBacklog } from '@pagespace/lib/audit/org-audit';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint that delivers staged org audit events (Spec AUD-1).
 *
 * Every org change stages its audit event in `org_audit_outbox` inside its own transaction and publishes it right
 * after commit. An event that publish could not deliver (the audit chain refused it, or the process stopped between
 * commit and publish) stays queued; this sweep, every minute, appends every due event to the security audit chain
 * and deletes it, oldest first. A refused append is retried with a capped backoff; after ORG_AUDIT_DEAD_LETTER_ATTEMPTS
 * it is dead-lettered (kept, alerted, counted on the admin monitoring page) instead of retried forever.
 * A run that left events retrying, or with any dead-lettered event outstanding, answers 500 so it pages.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  try {
    const result = await drainOrgAuditOutbox();
    const backlog = await getOrgAuditBacklog();
    const body = { ...result, queued: backlog.queued, deadLetteredTotal: backlog.deadLettered };
    if (result.retrying > 0 || backlog.deadLettered > 0) {
      loggers.system.error('[Cron] Org audit outbox: events could not be appended', undefined, body);
      return NextResponse.json({ success: false, error: `${result.retrying} event(s) retrying, ${backlog.deadLettered} dead-lettered`, ...body }, { status: 500 });
    }
    return NextResponse.json({ success: true, ...body });
  } catch (error) {
    loggers.system.error('[Cron] Org audit outbox drain failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
  }
}
