import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import { broadcastCreateSchema } from '@/lib/broadcasts/schema';
import { enqueueBroadcast } from '@/lib/broadcast/enqueue';
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
      templateId: input.templateId ?? null,
      bodyMarkdown: input.bodyMarkdown ?? null,
      audienceDefinition,
      dryRun: false,
      sendLimit: input.sendLimit ?? null,
      delayMs: input.delayMs,
      createdByUserId: admin.id,
    });

    let jobId: string;
    try {
      ({ jobId } = await enqueueBroadcast({ broadcastId: broadcast.id, callerUserId: admin.id }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await broadcastRepository.markFailed(broadcast.id, `enqueue failed: ${msg}`);
      loggers.api.error('Broadcast enqueue failed', error instanceof Error ? error : undefined);
      return NextResponse.json(
        { error: 'Failed to enqueue broadcast job', broadcastId: broadcast.id },
        { status: 500 },
      );
    }

    await broadcastRepository.markQueued(broadcast.id, jobId);

    loggers.api.info('Admin created live broadcast', {
      adminId: admin.id,
      broadcastId: broadcast.id,
      jobId,
      engine: input.engine,
      sendLimit: input.sendLimit ?? null,
    });

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
        jobId,
      },
    });

    return NextResponse.json({ broadcastId: broadcast.id, jobId }, { status: 202 });
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
