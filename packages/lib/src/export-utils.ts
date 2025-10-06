import HTMLtoDOCX from 'html-to-docx';

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
