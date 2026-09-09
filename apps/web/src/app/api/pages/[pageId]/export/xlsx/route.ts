import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { generateExcel, sanitizeFilename } from '@pagespace/lib/content/export-utils';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackPageOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalViewPage } from '@/lib/auth';
import {
  parseSheetContent,
  sanitizeSheetData,
  evaluateSheet,
  encodeCellAddress,
  numberFormatToExcelCode,
} from '@pagespace/lib/sheets/sheet';
import { readSheetData } from '@pagespace/lib/sheets/store';

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
    // Check MCP token scope before page access
    const scopeError = await checkMCPPageScope(auth, pageId);
    if (scopeError) return scopeError;

    // Check user permissions
    const canView = await canPrincipalViewPage(auth, pageId);
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

    // Read the sheet from its rows, falling back to the document column.
    //
    // A sheet's cells live in `sheet_rows`; `pages.content` is empty once one
    // has been materialised, so parsing the column would export a blank
    // spreadsheet. The fallback covers a sheet nothing has touched yet.
    const stored = await readSheetData({ pageId: page.id });
    const sheetData = sanitizeSheetData(stored ?? parseSheetContent(page.content));
    const evaluation = evaluateSheet(sheetData, {
      pageId: page.id,
      pageTitle: page.title,
    });

    // Generate Excel from the evaluated display values, plus the underlying
    // values and number formats so the workbook holds real numbers rather than
    // formatted text — otherwise nothing in the export sums or charts.
    const excelBuffer = generateExcel(evaluation.display, page.title, page.title, {
      values: evaluation.display.map((row, rowIndex) =>
        row.map((_, columnIndex) => {
          const cell = evaluation.byAddress[encodeCellAddress(rowIndex, columnIndex)];
          return cell?.error ? cell.display : cell?.value;
        })
      ),
      numberFormats: evaluation.display.map((row, rowIndex) =>
        row.map((_, columnIndex) => {
          const cell = evaluation.byAddress[encodeCellAddress(rowIndex, columnIndex)];
          return numberFormatToExcelCode(cell?.format?.number);
        })
      ),
      columnWidths: Array.from({ length: sheetData.columnCount }, (_, columnIndex) => {
        const key = encodeCellAddress(0, columnIndex).replace(/\d+$/, '');
        return sheetData.columnWidths?.[key];
      }),
    });

    // Create a sanitized filename
    const filename = sanitizeFilename(page.title) || 'sheet';

    // Track the export operation
    trackPageOperation(userId, 'read', pageId, {
      exportFormat: 'xlsx',
      pageTitle: page.title,
    });

    auditRequest(req, { eventType: 'data.export', userId, resourceType: 'page', resourceId: pageId, details: { format: 'xlsx' } });

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
