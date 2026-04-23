import path from 'path';
import fs from 'fs/promises';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { contentStore } from '../server';
import type { TextExtractJobData, TextExtractResult } from '../types';
import type { PDFLoadingTask, PDFTextItem, PDFInfo } from '../types/pdfjs';

export async function extractText(data: TextExtractJobData): Promise<TextExtractResult> {
  const { contentHash, mimeType } = data;

  loggers.processor.info('Text extraction started', { contentHash, mimeType });

  // Get original file
  const fileBuffer = await contentStore.getOriginal(contentHash);
  if (!fileBuffer) {
    throw new Error(`Original file not found: ${contentHash}`);
  }

  let extractedText = '';
  let metadata: Record<string, unknown> = {};

  try {
    switch (mimeType) {
      case 'application/pdf':
        const result = await extractPdfText(fileBuffer);
        extractedText = result.text;
        metadata = result.metadata;
        break;

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword':
        extractedText = await extractDocxText(fileBuffer);
        break;

      case 'text/plain':
      case 'text/markdown':
      case 'text/csv':
        extractedText = fileBuffer.toString('utf-8');
        break;

      case 'application/json':
        const json = JSON.parse(fileBuffer.toString('utf-8'));
        extractedText = JSON.stringify(json, null, 2);
        break;

      default:
        loggers.processor.warn('Unsupported mime type for text extraction', { contentHash, mimeType });
        return {
          success: false,
          error: `Unsupported file type: ${mimeType}`
        };
    }

    // Clean extracted text - remove null bytes and other invalid UTF-8 characters
    extractedText = extractedText.replace(/\0/g, '').trim();

    const cacheDir = path.dirname(await contentStore.getCachePath(contentHash, 'text'));
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'extracted-text.txt'),
      extractedText
    );

    loggers.processor.info('Text extraction succeeded', {
      contentHash,
      mimeType,
      textLength: extractedText.length,
    });

    return {
      success: true,
      text: extractedText,
      textLength: extractedText.length,
      metadata,
      cached: true
    };

  } catch (error) {
    loggers.processor.error(
      'Text extraction failed',
      error instanceof Error ? error : undefined,
      {
        contentHash,
        mimeType,
        ...(error instanceof Error ? {} : { rawError: String(error) }),
      },
    );
    throw error;
  }
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; metadata: Record<string, unknown> }> {
  const uint8Array = new Uint8Array(buffer);
  const getDocument = pdfjsLib.getDocument as unknown as
    (params: { data: Uint8Array; disableWorker: boolean }) => PDFLoadingTask;
  const loadingTask = getDocument({ data: uint8Array, disableWorker: true });
  const pdf = await loadingTask.promise;

  const metadata = await pdf.getMetadata();
  const numPages = pdf.numPages;
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    const pageText = textContent.items
      .map((item: PDFTextItem) => item.str)
      .join(' ');

    textParts.push(pageText);
  }

  const info: PDFInfo | null = metadata.info;

  return {
    text: textParts.join('\n\n'),
    metadata: {
      title: info?.Title || '',
      author: info?.Author || '',
      subject: info?.Subject || '',
      creator: info?.Creator || '',
      numPages
    }
  };
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });

  if (result.messages.length > 0) {
    loggers.processor.warn('DOCX extraction warnings', { messageCount: result.messages.length });
  }

  return result.value;
}

// Export function to check if a file needs text extraction
export function needsTextExtraction(mimeType: string): boolean {
  const supportedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json'
  ];

  return supportedTypes.includes(mimeType);
}
