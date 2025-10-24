import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateDOCX, sanitizeFilename, DocxPageConfig } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * Maps margin preset names to pixel values
 */
function getMarginPixels(margins: string): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const presets: Record<string, { top: number; bottom: number; left: number; right: number }> = {
    normal: { top: 96, bottom: 96, left: 96, right: 96 }, // 1 inch
    narrow: { top: 48, bottom: 48, left: 48, right: 48 }, // 0.5 inch
    wide: { top: 192, bottom: 192, left: 192, right: 192 }, // 2 inches
  };
  return presets[margins] || presets.normal;
}

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

    // Get the HTML content
    const htmlContent = page.content || '<p>No content</p>';

    // Build pagination config if page is paginated
    let paginationConfig: DocxPageConfig | undefined;
    if (page.isPaginated === true) {
      try {
        const pageSize = page.pageSize || 'letter';
        const margins = page.margins || 'normal';

        // Validate page size is a supported value
        const validPageSizes = ['letter', 'a4', 'a3', 'a5', 'legal', 'tabloid'];
        const normalizedPageSize = pageSize.toLowerCase();
        if (!validPageSizes.includes(normalizedPageSize)) {
          console.warn(`Invalid page size '${pageSize}', defaulting to 'letter'`);
        }

        const marginPixels = getMarginPixels(margins);

        paginationConfig = {
          pageSize: validPageSizes.includes(normalizedPageSize) ? normalizedPageSize : 'letter',
          marginTop: marginPixels.top,
          marginBottom: marginPixels.bottom,
          marginLeft: marginPixels.left,
          marginRight: marginPixels.right,
        };

        loggers.api.debug('DOCX export with pagination config:', paginationConfig);
      } catch (error) {
        loggers.api.warn('Failed to build pagination config for DOCX export, using defaults:', error instanceof Error ? { message: error.message, stack: error.stack } : { error });
        // Continue without pagination config - generateDOCX will use defaults
        paginationConfig = undefined;
      }
    }

    // Generate DOCX with optional pagination config
    const docxBuffer = await generateDOCX(htmlContent, page.title, paginationConfig);

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'document';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'docx',
      pageTitle: page.title,
    });

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
