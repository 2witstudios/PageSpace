import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateDOCX, sanitizeFilename } from '@pagespace/lib';
import { loggers, securityAudit } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { marked } from 'marked';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * Export a document page as DOCX
 * GET /api/pages/[pageId]/export/docx
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
      return new NextResponse("Forbidden", { status: 403 });
    }

    // Fetch the page
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!page) {
      return new NextResponse("Not Found", { status: 404 });
    }

    // Validate that this is a DOCUMENT page
    if (page.type !== 'DOCUMENT') {
      return NextResponse.json(
        { error: 'DOCX export is only available for DOCUMENT pages' },
        { status: 400 }
      );
    }

    // Get the HTML content (convert markdown to HTML if needed)
    let htmlContent: string;
    if (page.contentMode === 'markdown') {
      htmlContent = await marked.parse(page.content || '') || '<p>No content</p>';
    } else {
      htmlContent = page.content || '<p>No content</p>';
    }

    // Generate DOCX
    const docxBuffer = await generateDOCX(htmlContent, page.title);

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'document';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'docx',
      pageTitle: page.title,
    });

    securityAudit.logDataAccess(userId, 'export', 'page', pageId, { format: 'docx' }).catch(() => {});

    // Return the DOCX as a downloadable file
    // Convert Buffer to Uint8Array for Next.js 15 compatibility
    return new NextResponse(new Uint8Array(docxBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}.docx"`,
        'Content-Length': docxBuffer.length.toString(),
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting page as DOCX:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export page as DOCX' },
      { status: 500 }
    );
  }
}
