import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth';
import { templateCreateSchema } from '@/lib/broadcasts/schema';
import { broadcastRepository } from '@pagespace/lib/repositories/broadcast-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

/**
 * GET  /api/admin/broadcasts/templates — active templates for the composer picker.
 * POST /api/admin/broadcasts/templates — save a reusable template.
 *
 * Phase-1 minimal template library: list + create. Retiring/editing templates is
 * a follow-up; `resolveBroadcastContent` already refuses inactive templates at
 * send time, so deactivation (when it ships) is honored without route changes.
 */

export const GET = withAdminAuth(async () => {
  try {
    const templates = await broadcastRepository.listTemplates(true);
    return NextResponse.json({
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        subject: template.subject,
        bodyMarkdown: template.bodyMarkdown,
        isActive: template.isActive,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })),
    });
  } catch (error) {
    loggers.api.error('Error listing broadcast templates', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to list templates' }, { status: 500 });
  }
});

export const POST = withAdminAuth(async (admin, request) => {
  try {
    const parsed = templateCreateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid template request', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const template = await broadcastRepository.createTemplate({
      name: parsed.data.name,
      subject: parsed.data.subject,
      bodyMarkdown: parsed.data.bodyMarkdown,
      isActive: parsed.data.isActive,
      createdByUserId: admin.id,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId: admin.id,
      resourceType: 'broadcast_template',
      resourceId: template.id,
      details: { source: 'admin', action: 'broadcast_template_create', name: template.name },
    });

    return NextResponse.json(
      {
        template: {
          id: template.id,
          name: template.name,
          subject: template.subject,
          bodyMarkdown: template.bodyMarkdown,
          isActive: template.isActive,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    loggers.api.error('Error creating broadcast template', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
  }
});
