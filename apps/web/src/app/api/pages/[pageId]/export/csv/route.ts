import { NextResponse } from 'next/server';
import { pages, db, eq } from '@pagespace/db';
import { canUserViewPage } from '@pagespace/lib/server';
import { generateCSV, sanitizeFilename } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { parseSheetContent, sanitizeSheetData, evaluateSheet } from '@pagespace/lib/client-safe';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * Export a sheet page as CSV
 * GET /api/pages/[pageId]/export/csv
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
        { error: 'CSV export is only available for SHEET pages' },
        { status: 400 }
      );
    }

    // Parse and evaluate the sheet
    const sheetData = sanitizeSheetData(parseSheetContent(page.content));
    const evaluation = evaluateSheet(sheetData, {
      pageId: page.id,
      pageTitle: page.title,
    });

    // Generate CSV from evaluated display values
    const csvContent = generateCSV(evaluation.display);

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'sheet';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'csv',
      pageTitle: page.title,
    });

    // Return the CSV as a downloadable file
    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
        'Content-Length': Buffer.byteLength(csvContent, 'utf-8').toString(),
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting page as CSV:', error as Error);
    return NextResponse.json(
      { error: 'Failed to export page as CSV' },
      { status: 500 }
    );
  }
}
