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
    const docxBuffer = await HTMLtoDOCX(html, null, {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
      title: title,
    });

    return docxBuffer;
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
 * Generates an Excel (.xlsx) buffer from a 2D array of cell values
 * @param data - 2D array of cell display values
 * @param sheetName - Name of the worksheet (default: 'Sheet1')
 * @param title - Workbook title
 * @returns Buffer containing the Excel data
 */
export function generateExcel(
  data: string[][],
  sheetName: string = 'Sheet1',
  title?: string
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

    // Set column widths (with a max of 50 characters)
    worksheet['!cols'] = maxColumnWidths.map(width => ({
      wch: Math.min(width + 2, 50)
    }));

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
