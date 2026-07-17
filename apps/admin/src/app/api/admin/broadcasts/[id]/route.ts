import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import { broadcastActionSchema } from '@/lib/broadcasts/schema';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { EmailBroadcastStatus } from '@pagespace/db/schema/email-broadcasts';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET  /api/admin/broadcasts/[id] — status/counts/stepResults for progress polling.
 * POST /api/admin/broadcasts/[id] — cancel or pause an active broadcast.
 *
 * Cancel/pause go through `updateStatus` with a terminal-state guard: the worker
 * checks the row's status mid-run (between pages and per recipient), so writing
 * `cancelled`/`paused` here IS the intervention — but a broadcast that already
 * finished must not be dragged out of its terminal state, so the conditional
 * write refuses and this route reports the real status instead.
 */

const TERMINAL_STATES: EmailBroadcastStatus[] = ['completed', 'failed', 'cancelled'];

export const GET = withAdminAuth<RouteContext>(async (_admin, _request, context) => {
  try {
    const { id } = await context.params;
    const broadcast = await broadcastRepository.findById(id);
    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    return NextResponse.json({
      id: broadcast.id,
      subject: broadcast.subject,
      status: broadcast.status,
      engine: broadcast.engine,
      contentMode: broadcast.contentMode,
      dryRun: broadcast.dryRun,
      sendLimit: broadcast.sendLimit,
      delayMs: broadcast.delayMs,
      totalTargeted: broadcast.totalTargeted,
      sentCount: broadcast.sentCount,
      skippedCount: broadcast.skippedCount,
      failedCount: broadcast.failedCount,
      stepResults: broadcast.stepResults ?? [],
      attempts: broadcast.attempts,
      lastError: broadcast.lastError,
      blockedReason: broadcast.blockedReason,
      createdAt: broadcast.createdAt,
      startedAt: broadcast.startedAt,
      completedAt: broadcast.completedAt,
    });
  } catch (error) {
    loggers.api.error('Error fetching broadcast', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to fetch broadcast' }, { status: 500 });
  }
});

export const POST = withAdminAuth<RouteContext>(async (admin, request, context) => {
  try {
    const { id } = await context.params;

    const parsed = broadcastActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid action request', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { action, reason } = parsed.data;

    const broadcast = await broadcastRepository.findById(id);
    if (!broadcast) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    const targetStatus: EmailBroadcastStatus = action === 'cancel' ? 'cancelled' : 'paused';

    // Repeating an intervention that already took effect is a no-op, not an error.
    if (broadcast.status === targetStatus) {
      return NextResponse.json({ id, status: targetStatus });
    }

    const updated = await broadcastRepository.updateStatus(
      id,
      targetStatus,
      action === 'cancel' ? { completedAt: new Date() } : {},
      { unlessStatus: TERMINAL_STATES },
    );

    if (updated === 0) {
      // The guard refused: the broadcast reached a terminal state first. Report
      // the truth rather than pretend the intervention landed.
      const current = await broadcastRepository.findById(id);
      return NextResponse.json(
        { error: `Broadcast is already ${current?.status ?? 'finished'}`, status: current?.status },
        { status: 409 },
      );
    }

    // The status write above IS the intervention — the worker yields to it
    // mid-run — and it has landed. The step note is UI-facing evidence, and the
    // durable record of who/why is the auditRequest below; so a note failure is
    // logged, not surfaced. A 500 here would misreport a cancel that DID land,
    // and the retry it invites would hit the no-op branch anyway.
    try {
      await broadcastRepository.appendStepResult(id, {
        step: action,
        status: 'ok',
        detail: reason,
        at: new Date().toISOString(),
      });
    } catch (error) {
      loggers.api.warn('Broadcast intervention step-result append failed', {
        broadcastId: id,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    loggers.api.info('Admin broadcast intervention', {
      adminId: admin.id,
      broadcastId: id,
      action,
      reason,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId: admin.id,
      resourceType: 'broadcast',
      resourceId: id,
      details: { source: 'admin', action: `broadcast_${action}`, reason },
    });

    return NextResponse.json({ id, status: targetStatus });
  } catch (error) {
    loggers.api.error('Error updating broadcast', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to update broadcast' }, { status: 500 });
  }
});
