import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import { broadcastCreateSchema } from '@/lib/broadcasts/schema';
import {
  BroadcastEnqueueUnconfirmedError,
  enqueueBroadcast,
} from '@/lib/broadcast/enqueue';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import { countAudience } from '@pagespace/lib/services/broadcast/audience';
import {
  renderBroadcastEmail,
  resolveBroadcastContent,
} from '@pagespace/lib/services/broadcast/content';
import { resolveBaseUrl } from '@pagespace/lib/services/broadcast/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { BroadcastAudienceDefinition } from '@pagespace/db/schema/email-broadcasts';

/**
 * POST /api/admin/broadcasts — create a broadcast (dry-run or live).
 * GET  /api/admin/broadcasts — recent broadcasts for the list page.
 *
 * Dry-run touches NOTHING durable: no row, no recipients, no job — it answers
 * "who would this reach and what would it look like" and stops. Only a live
 * create writes the row and enqueues the processor job, mirroring the erasure
 * route's create → enqueue → markQueued (markFailed on enqueue error) shape.
 */

/** Resolve compose/template content through the SAME code path the worker uses,
 *  so the preview is evidence about the email that will actually ship. */
async function resolveContent(parsed: {
  contentMode: 'compose' | 'template';
  subject: string;
  bodyMarkdown?: string;
  templateId?: string;
}) {
  return resolveBroadcastContent(
    {
      contentMode: parsed.contentMode,
      subject: parsed.subject,
      bodyMarkdown: parsed.bodyMarkdown ?? null,
      templateId: parsed.templateId ?? null,
    },
    async (templateId) => {
      const template = await broadcastRepository.findTemplateById(templateId);
      return template
        ? {
            subject: template.subject,
            bodyMarkdown: template.bodyMarkdown,
            isActive: template.isActive,
          }
        : null;
    },
  );
}

/** Best-effort progress-trail note. The trail is UI-facing evidence, not the
 *  audit record (auditRequest is) — its failure must never fail the request. */
async function appendStepResultSafe(broadcastId: string, detail: string): Promise<void> {
  try {
    await broadcastRepository.appendStepResult(broadcastId, {
      step: 'enqueue',
      status: 'failed',
      detail,
      at: new Date().toISOString(),
    });
  } catch (error) {
    loggers.api.warn('Broadcast step-result append failed', {
      broadcastId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export const POST = withAdminAuth(async (admin, request) => {
  try {
    const parsed = broadcastCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid broadcast request', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const input = parsed.data;
    const audienceDefinition: BroadcastAudienceDefinition = input.audienceDefinition;

    // Resolve content BEFORE any write for both modes: an inactive template or
    // an empty body means the admin's intent is ambiguous, and the safe reading
    // of an ambiguous mass email is "don't send it" — or store it.
    let content: { subject: string; bodyMarkdown: string };
    try {
      content = await resolveContent(input);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Broadcast content is not resolvable' },
        { status: 400 },
      );
    }

    if (input.dryRun) {
      const [audienceCount, previewHtml] = await Promise.all([
        countAudience(audienceDefinition),
        renderBroadcastEmail({
          subject: content.subject,
          bodyMarkdown: content.bodyMarkdown,
          // Per-recipient tokens are minted at send time; the preview carries a
          // placeholder with the real link's shape.
          unsubscribeUrl: `${resolveBaseUrl()}/api/notifications/unsubscribe/preview`,
          postalAddress: process.env.COMPANY_POSTAL_ADDRESS?.trim() || undefined,
        }),
      ]);

      auditRequest(request, {
        eventType: 'data.read',
        userId: admin.id,
        resourceType: 'broadcast',
        resourceId: 'dry-run',
        details: { source: 'admin', action: 'broadcast_dry_run', audienceCount, audienceDefinition },
      });

      return NextResponse.json({
        dryRun: true,
        audienceCount,
        previewHtml,
        subject: content.subject,
      });
    }

    // The worker drives the transactional engine unconditionally; until the
    // Phase-2 engine exists, a live resend_broadcast send would silently go out
    // transactionally — refuse rather than mis-send.
    if (input.engine === 'resend_broadcast') {
      return NextResponse.json(
        { error: 'The resend_broadcast engine is not available yet. Use "transactional".' },
        { status: 400 },
      );
    }

    const broadcast = await broadcastRepository.create({
      subject: content.subject,
      engine: input.engine,
      contentMode: input.contentMode,
      // Only the field the active mode reads is stored. The other one may hold
      // stale form state (e.g. a template id kept after switching to compose),
      // and persisting it would either break the insert on a deleted template
      // FK or record a reference to a template this send never used.
      templateId: input.contentMode === 'template' ? (input.templateId ?? null) : null,
      bodyMarkdown: input.contentMode === 'compose' ? (input.bodyMarkdown ?? null) : null,
      audienceDefinition,
      dryRun: false,
      sendLimit: input.sendLimit ?? null,
      delayMs: input.delayMs,
      createdByUserId: admin.id,
    });

    const recordAudit = (details: Record<string, unknown>) =>
      auditRequest(request, {
        eventType: 'data.write',
        userId: admin.id,
        resourceType: 'broadcast',
        resourceId: broadcast.id,
        details: {
          source: 'admin',
          action: 'broadcast_create_live',
          subject: content.subject,
          engine: input.engine,
          contentMode: input.contentMode,
          audienceDefinition,
          sendLimit: input.sendLimit ?? null,
          delayMs: input.delayMs ?? null,
          ...details,
        },
      });

    // jobId is null when the processor deduped the enqueue (a job for this
    // broadcast already exists — same outcome, id unknown).
    let jobId: string | null;
    try {
      ({ jobId } = await enqueueBroadcast({ broadcastId: broadcast.id, callerUserId: admin.id }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (error instanceof BroadcastEnqueueUnconfirmedError) {
        // A job MAY exist. Failing the row would be a lie the worker ignores
        // (it yields only to cancelled/paused/completed) — mail could go out
        // under a status that told the admin the send died, inviting a second
        // broadcast. Report accepted-but-unconfirmed and point at the status
        // page, where a landed job shows progress and a lost one stays pending.
        await appendStepResultSafe(broadcast.id, `enqueue unconfirmed: ${msg}`);
        loggers.api.warn('Broadcast enqueue unconfirmed — job may exist', {
          broadcastId: broadcast.id,
          error: msg,
        });
        recordAudit({ jobId: null, enqueue: 'unconfirmed' });
        return NextResponse.json(
          { broadcastId: broadcast.id, jobId: null, enqueue: 'unconfirmed' },
          { status: 202 },
        );
      }

      // Definitely not enqueued (token minting failed or the processor refused
      // the request) — the one case where failing the row is safe and honest.
      const failed = await broadcastRepository.markFailed(broadcast.id, `enqueue failed: ${msg}`);
      if (failed === 0) {
        // markFailed's guard refused: the worker already advanced the row, so a
        // job exists after all. Report the send that is actually happening.
        const row = await broadcastRepository.findById(broadcast.id);
        recordAudit({ jobId: row?.jobId ?? null, enqueue: 'confirmed' });
        return NextResponse.json(
          { broadcastId: broadcast.id, jobId: row?.jobId ?? null, enqueue: 'confirmed' },
          { status: 202 },
        );
      }
      loggers.api.error('Broadcast enqueue failed', error instanceof Error ? error : undefined);
      return NextResponse.json(
        { error: 'Failed to enqueue broadcast job', broadcastId: broadcast.id },
        { status: 500 },
      );
    }

    if (jobId !== null) {
      try {
        await broadcastRepository.markQueued(broadcast.id, jobId);
      } catch (error) {
        // Bookkeeping only: the job IS live and the worker advances the row on
        // its own. A 500 here would invite a retried POST — a fresh row with a
        // fresh singletonKey, i.e. a genuine second mass send.
        loggers.api.warn('markQueued failed after successful enqueue — worker will advance the row', {
          broadcastId: broadcast.id,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    loggers.api.info('Admin created live broadcast', {
      adminId: admin.id,
      broadcastId: broadcast.id,
      jobId,
      engine: input.engine,
      sendLimit: input.sendLimit ?? null,
    });

    recordAudit({ jobId, enqueue: 'confirmed' });

    return NextResponse.json(
      { broadcastId: broadcast.id, jobId, enqueue: 'confirmed' },
      { status: 202 },
    );
  } catch (error) {
    loggers.api.error('Error creating broadcast', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to create broadcast' }, { status: 500 });
  }
});

export const GET = withAdminAuth(async () => {
  try {
    const rows = await broadcastRepository.listRecent();
    return NextResponse.json({
      broadcasts: rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        status: row.status,
        engine: row.engine,
        dryRun: row.dryRun,
        totalTargeted: row.totalTargeted,
        sentCount: row.sentCount,
        skippedCount: row.skippedCount,
        failedCount: row.failedCount,
        createdAt: row.createdAt,
      })),
    });
  } catch (error) {
    loggers.api.error('Error listing broadcasts', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to list broadcasts' }, { status: 500 });
  }
});
