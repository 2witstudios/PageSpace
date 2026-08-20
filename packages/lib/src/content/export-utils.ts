import HTMLtoDOCX from 'html-to-docx';
import * as XLSX from 'xlsx';

/**
 * Generates a DOCX buffer from HTML content
 * @param html - The HTML content to convert
 * @param title - The document title
 * @returns A Buffer containing the DOCX data
 */
export async function generateDOCX(html: string, title: string): Promise<Buffer> {
  try {
    const docxData = await HTMLtoDOCX(html, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
      title: title,
    });

    // Convert ArrayBuffer or Blob to Buffer
    if (docxData instanceof ArrayBuffer) {
      return Buffer.from(docxData);
    } else if (docxData instanceof Blob) {
      const arrayBuffer = await docxData.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // If it's already a Buffer (shouldn't happen but handle it)
    return docxData as Buffer;
  } catch (error) {
    console.error('Error generating DOCX:', error);
    throw new Error('Failed to generate DOCX');
  }
}

/**
 * Sanitizes a filename by removing invalid characters
 * @param filename - The filename to sanitize
 * @returns A sanitized filename safe for downloads
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-z0-9\s_-]/gi, '') // Remove invalid chars
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Remove duplicate underscores
    .replace(/^_|_$/g, '') // Remove leading/trailing underscores
    .toLowerCase();
}

/**
 * Escapes a CSV field value by wrapping it in quotes if needed
 * @param value - The value to escape
 * @returns Escaped CSV field
 */
function escapeCSVField(value: string): string {
  // If the value contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Generates a CSV string from a 2D array of cell values
 * @param data - 2D array of cell display values
 * @returns CSV string
 */
export function generateCSV(data: string[][]): string {
  if (data.length === 0) {
    return '';
  }

  const rows = data.map(row =>
    row.map(cell => escapeCSVField(cell)).join(',')
  );

  return rows.join('\n');
}

/**
 * The underlying values and formats behind the displayed grid, so an export
 * can carry real numbers and number formats instead of formatted text.
 */
export interface TypedSheetExport {
  /** Row-major computed values, parallel to the `data` passed to generateExcel. */
  values: (number | string | boolean | null | undefined)[][];
  /** Excel number-format codes (`z`), parallel to `values`. */
  numberFormats?: (string | undefined)[][];
  /** Column widths in px, by column index; converted to Excel character units. */
  columnWidths?: (number | undefined)[];
}

/*
 * Note: frozen panes are deliberately not exported. `xlsx@0.18.5` (the
 * community build) ignores a `!freeze` worksheet property — it writes no
 * `<pane>` element — so setting it would be dead code implying a feature that
 * does not survive the round trip.
 */

/** Excel measures column width in characters; the grid measures it in pixels. */
const pxToExcelWidth = (px: number): number => Math.max(1, Math.round((px - 5) / 7));

function applyTypedCells(
  worksheet: XLSX.WorkSheet,
  typed: TypedSheetExport
): void {
  typed.values.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      if (value === null || value === undefined || value === '') {
        return;
      }

      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[address] as XLSX.CellObject | undefined;
      if (!cell) {
        return;
      }

      if (typeof value === 'number' && Number.isFinite(value)) {
        cell.t = 'n';
        cell.v = value;
      } else if (typeof value === 'boolean') {
        cell.t = 'b';
        cell.v = value;
      } else {
        // Leave text as text — but keep the displayed string, which may be
        // formatted, as what the user sees.
        return;
      }

      const numberFormat = typed.numberFormats?.[rowIndex]?.[columnIndex];
      if (numberFormat) {
        cell.z = numberFormat;
      }
    });
  });
}

/**
 * Generates an Excel (.xlsx) buffer from a 2D array of cell values
 * @param data - 2D array of cell display values
 * @param sheetName - Name of the worksheet (default: 'Sheet1')
 * @param title - Workbook title
 * @param typed - Optional underlying values/formats, so numbers export as numbers
 * @returns Buffer containing the Excel data
 */
export function generateExcel(
  data: string[][],
  sheetName: string = 'Sheet1',
  title?: string,
  typed?: TypedSheetExport
): Buffer {
  try {
    // Create a new workbook
    const workbook = XLSX.utils.book_new();

    // Set workbook properties if title is provided
    if (title) {
      workbook.Props = {
        Title: title,
        Author: 'PageSpace',
        CreatedDate: new Date(),
      };
    }

    // Create worksheet from 2D array
    const worksheet = XLSX.utils.aoa_to_sheet(data);

    // Replace the string cells with real typed ones where we know the
    // underlying value. Exporting every number as text is what makes an
    // exported sheet unusable in Excel: nothing sums, sorts or charts.
    if (typed) {
      applyTypedCells(worksheet, typed);
    }

    // Auto-size columns based on content
    const maxColumnWidths: number[] = [];
    data.forEach(row => {
      row.forEach((cell, colIndex) => {
        const cellLength = String(cell).length;
        if (!maxColumnWidths[colIndex] || cellLength > maxColumnWidths[colIndex]) {
          maxColumnWidths[colIndex] = cellLength;
        }
      });
    });

    // Set column widths (with a max of 50 characters). An explicit width set in
    // the sheet wins over the auto-size guess.
    // Size by the wider of the two sources. `maxColumnWidths` only covers
    // columns that actually hold data, and it is sparse when rows differ in
    // length — `.map` skips holes — so deriving `!cols` from it alone drops an
    // explicit width for any column past the widest row or at a hole.
    const columnCount = Math.max(maxColumnWidths.length, typed?.columnWidths?.length ?? 0);
    worksheet['!cols'] = Array.from({ length: columnCount }, (_, columnIndex) => {
      const explicit = typed?.columnWidths?.[columnIndex];
      if (typeof explicit === 'number' && Number.isFinite(explicit)) {
        return { wch: pxToExcelWidth(explicit) };
      }
      return { wch: Math.min((maxColumnWidths[columnIndex] ?? 0) + 2, 50) };
    });

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    // Write workbook to buffer
    const excelBuffer = XLSX.write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
      compression: true,
    });

    return Buffer.from(excelBuffer);
  } catch (error) {
    console.error('Error generating Excel:', error);
    throw new Error('Failed to generate Excel file');
  }
}
