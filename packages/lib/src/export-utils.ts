import HTMLtoDOCX from 'html-to-docx';
import * as XLSX from 'xlsx';

export interface DocxPageConfig {
  pageSize?: string; // 'letter', 'a4', 'legal', etc.
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
}

/**
 * Converts pixels at 96 DPI to twips (1/20 of a point)
 * Used for DOCX margin calculations
 */
function pixelsToTwips(pixels: number): number {
  // 1 pixel at 96 DPI = 15 twips
  return Math.round(pixels * 15);
}

/**
 * Generates a DOCX buffer from HTML content
 * @param html - The HTML content to convert
 * @param title - The document title
 * @param config - Optional pagination configuration for page size and margins
 * @returns A Buffer containing the DOCX data
 */
export async function generateDOCX(
  html: string,
  title: string,
  config?: DocxPageConfig
): Promise<Buffer> {
  try {
    // Build document options
    const options: Record<string, unknown> = {
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
      title: title,
    };

    // Apply pagination config if provided
    if (config) {
      // Convert page size to DOCX orientation
      if (config.pageSize) {
        const sizeUpper = config.pageSize.toUpperCase();
        // Map PageSpace sizes to DOCX paper sizes
        const sizeMap: Record<string, string> = {
          LETTER: 'letter',
          A4: 'A4',
          A3: 'A3',
          A5: 'A5',
          LEGAL: 'legal',
          TABLOID: 'tabloid',
        };
        if (sizeMap[sizeUpper]) {
          options.orientation = 'portrait';
          // Note: fontSize in html-to-docx doesn't control page size,
          // the library handles standard sizes internally
        }
      }

      // Convert margins from pixels to twips for DOCX
      // Ensure we have valid margin values
      const hasValidMargins =
        (typeof config.marginTop === 'number' && config.marginTop >= 0) ||
        (typeof config.marginBottom === 'number' && config.marginBottom >= 0) ||
        (typeof config.marginLeft === 'number' && config.marginLeft >= 0) ||
        (typeof config.marginRight === 'number' && config.marginRight >= 0);

      if (hasValidMargins) {
        options.margins = {
          top: pixelsToTwips(config.marginTop ?? 96),
          bottom: pixelsToTwips(config.marginBottom ?? 96),
          left: pixelsToTwips(config.marginLeft ?? 96),
          right: pixelsToTwips(config.marginRight ?? 96),
        };
      }
    }

    const docxData = await HTMLtoDOCX(html, null, options);

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
