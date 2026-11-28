import { NextResponse } from 'next/server';
import { sweepAgentLifecycle } from '@pagespace/lib/services/agent-lifecycle';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { eraseUnclaimedAgent } from '@/lib/agent-auth/lifecycle-erasure';

/**
 * Agent lifecycle cron (ADR 0008 Decision 13, [D-30] = 30 days; Agent Signup
 * Phase 5). Prunes expired agent signup challenges and agent claims, and
 * erases unclaimed agents that never authenticated after signup and are at
 * least 30 days old — decided per agent by the frozen `decideAgentLifecycle`
 * inside `sweepAgentLifecycle`, erased through the GDPR account-erasure path
 * (`eraseUnclaimedAgent`). An agent that ever signed in, or has an owner, is
 * never touched.
 *
 * Runs HOURLY and drains the backlog batch after batch, up to a per-run
 * erasure and time budget (security review addendum: one 50-row batch a day
 * could not keep up with the signup budget).
 *
 * Runs whatever the deployment mode: a deployment that closed the agent door
 * still holds the rows its earlier signups left behind.
 *
 * Authentication: HMAC-signed cron requests (cron-curl) + internal network
 * origin check, like every route under /api/cron.
 *
 * Trigger via:
 *   cron-curl GET http://web:3000/api/cron/agent-lifecycle
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const result = await sweepAgentLifecycle({ now: new Date(), eraseAgent: eraseUnclaimedAgent });
    const summary = {
      challengesPruned: result.challengesPruned,
      claimsPruned: result.claimsPruned,
      candidates: result.candidates,
      erased: result.erased,
      kept: result.kept,
      failed: result.failed + result.failures.filter((failure) => failure.userId === null).length,
      // A run drains batch after batch until the backlog or a per-run budget runs out.
      batches: result.batches,
      stoppedBy: result.stoppedBy,
    };

    for (const failure of result.failures) {
      loggers.system.error('[Cron] Agent lifecycle step failed', { userId: failure.userId, error: failure.error });
    }
    audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'agent_lifecycle', details: summary });

    return NextResponse.json({ success: summary.failed === 0, ...summary, timestamp: new Date().toISOString() });
  } catch (error) {
    loggers.system.error('[Cron] Agent lifecycle sweep failed', error as Error);
    return NextResponse.json({ success: false, error: 'agent lifecycle sweep failed' }, { status: 500 });
  }
}

// POST for parity with the other cron endpoints.
export async function POST(request: Request) {
  return GET(request);
}
