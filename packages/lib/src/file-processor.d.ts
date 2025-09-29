import type { ExtractionResult } from './types';
/**
 * File processor for extracting text content from various file types
 * - PDF: pdf-parse library
 * - Word: mammoth library
 * - Text: direct extraction
 * - Images: AI vision API for OCR (marks as visual if OCR fails)
 */
export declare class FileProcessor {
    private STORAGE_ROOT;
    constructor();
    processFile(pageId: string): Promise<ExtractionResult>;
    private extractContent;
    /**
     * Extract text from PDF files
     */
    private extractPDF;
    /**
     * Extract text from Word documents
     */
    private extractDOCX;
    /**
     * Extract text from images using AI vision API
     */
    private extractWithAIVision;
    /**
     * Check if file extension indicates a text file
     */
    private isTextFileExtension;
    /**
     * Sanitize content for storage
     */
    private sanitizeContent;
}
export declare function getFileProcessor(): Promise<FileProcessor>;
//# sourceMappingURL=file-processor.d.ts.map