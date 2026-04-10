import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, pages, eq } from '@pagespace/db';
import { canUserEditPage, createPageVersion } from '@pagespace/lib/server';
import { loggers, securityAudit } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import TurndownService from 'turndown';
import { marked } from 'marked';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const convertSchema = z.object({
  targetMode: z.enum(['markdown', 'html']),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await request.json();
    const { targetMode } = convertSchema.parse(body);

    // Check permissions
    const canEdit = await canUserEditPage(userId, pageId, { bypassCache: true });
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You need edit permission to convert this page' },
        { status: 403 }
      );
    }

    // Fetch current page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    if (page.type !== 'DOCUMENT') {
      return NextResponse.json(
        { error: 'Content mode conversion is only available for DOCUMENT pages' },
        { status: 400 }
      );
    }

    if (page.contentMode === targetMode) {
      return NextResponse.json(
        { error: `Page is already in ${targetMode} mode` },
        { status: 400 }
      );
    }

    // Create version snapshot before conversion
    await createPageVersion({
      pageId: page.id,
      driveId: page.driveId,
      createdBy: userId,
      source: 'system',
      content: page.content || '',
      pageRevision: page.revision,
      stateHash: page.stateHash || '',
      metadata: { reason: `pre-conversion to ${targetMode}` },
    });

    // Convert content
    // Note: Content is already trusted as it comes from our database where it was
    // sanitized on original save. Turndown/marked handle format conversion safely.
    let convertedContent: string;
    if (targetMode === 'markdown') {
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
      });
      convertedContent = turndown.turndown(page.content || '');
    } else {
      convertedContent = await marked.parse(page.content || '');
    }

    // Atomic update: content + contentMode
    await applyPageMutation({
      pageId: page.id,
      operation: 'update',
      updates: {
        content: convertedContent,
        contentMode: targetMode,
      },
      updatedFields: ['content', 'contentMode'],
      expectedRevision: page.revision,
      context: { userId },
    });

    // Broadcast content update
    await broadcastPageEvent(
      createPageEventPayload(page.driveId, page.id, 'content-updated', {
        title: page.title,
      })
    );

    // Refetch updated page
    const updatedPage = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    securityAudit.logDataAccess(userId, 'write', 'page', pageId, { operation: 'convert_content_mode' }).catch(() => {});

    return NextResponse.json({
      success: true,
      content: updatedPage?.content,
      contentMode: updatedPage?.contentMode,
      revision: updatedPage?.revision,
    });
  } catch (error) {
    loggers.api.error('Error converting page content mode:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json(
      { error: 'Failed to convert content mode' },
      { status: 500 }
    );
  }
}
