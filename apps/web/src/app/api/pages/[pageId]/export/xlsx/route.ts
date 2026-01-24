import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateExcel, sanitizeFilename } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { parseSheetContent, sanitizeSheetData, evaluateSheet } from '@pagespace/lib/client-safe';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * Export a sheet page as Excel (.xlsx)
 * GET /api/pages/[pageId]/export/xlsx
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

    // Validate that this is a SHEET page
    if (page.type !== 'SHEET') {
      return NextResponse.json(
        { error: 'Excel export is only available for SHEET pages' },
        { status: 400 }
      );
    }

    // Parse and evaluate the sheet
    const sheetData = sanitizeSheetData(parseSheetContent(page.content));
    const evaluation = evaluateSheet(sheetData, {
      pageId: page.id,
      pageTitle: page.title,
    });

    // Generate Excel from evaluated display values
    const excelBuffer = generateExcel(evaluation.display, page.title, page.title);

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'sheet';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'xlsx',
      pageTitle: page.title,
    });

    // Return the Excel file as a downloadable file
    // Convert Buffer to Uint8Array for Next.js 15 compatibility
    return new NextResponse(new Uint8Array(excelBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}.xlsx"`,
        'Content-Length': excelBuffer.length.toString(),
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting page as Excel:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export page as Excel' },
      { status: 500 }
    );
  }
}
