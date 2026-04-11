import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { sanitizeFilename } from '@pagespace/lib';
import { loggers, auditRequest } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import TurndownService from 'turndown';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * Export a document page as Markdown
 * GET /api/pages/[pageId]/export/markdown
 */
export async function GET(req: Request, context: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await context.params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);

  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    // Check MCP token scope before page access
    const scopeError = await checkMCPPageScope(auth, pageId);
    if (scopeError) return scopeError;

    // Check user permissions
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return new NextResponse('Forbidden', { status: 403 });
    }

    // Fetch the page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return new NextResponse('Not Found', { status: 404 });
    }

    // Validate that this is a DOCUMENT page
    if (page.type !== 'DOCUMENT') {
      return NextResponse.json(
        { error: 'Markdown export is only available for DOCUMENT pages' },
        { status: 400 }
      );
    }

    // Convert HTML pages to Markdown; markdown pages can be exported directly.
    const markdownContent = page.contentMode === 'markdown'
      ? (page.content || '')
      : new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
        }).turndown(page.content || '');

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'document';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'markdown',
      pageTitle: page.title,
    });

    auditRequest(req, { eventType: 'data.export', userId, resourceType: 'page', resourceId: pageId, details: { format: 'markdown' } });

    // Return markdown as a downloadable file
    return new NextResponse(markdownContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.md"`,
        'Content-Length': Buffer.byteLength(markdownContent, 'utf-8').toString(),
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting page as Markdown:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export page as Markdown' },
      { status: 500 }
    );
  }
}
