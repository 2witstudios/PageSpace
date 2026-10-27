import Tesseract from 'tesseract.js';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { contentStore } from '../server';
import type { OCRJobData, OCRResult } from '../types';

// Rate limiting for external OCR APIs
const rateLimiter = {
  lastCall: 0,
  minInterval: 200, // Minimum 200ms between calls
  
  async wait() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;
    
    if (timeSinceLastCall < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastCall = Date.now();
  }
};

export async function processOCR(data: OCRJobData): Promise<OCRResult> {
  const { contentHash, language = 'eng', provider = 'tesseract' } = data;

  loggers.processor.info('OCR job started', { contentHash, provider });

  // Check if OCR result already cached in S3
  const cachedBuf = await contentStore.getCache(contentHash, 'ocr-text.txt');
  if (cachedBuf) {
    loggers.processor.info('OCR cache hit', { contentHash });
    return { success: true, cached: true, text: cachedBuf.toString('utf-8'), provider };
  }

  // Get original image
  const imageBuffer = await contentStore.getOriginal(contentHash);
  if (!imageBuffer) {
    throw new Error(`Original file not found: ${contentHash}`);
  }

  let ocrText = '';

  try {
    if (provider === 'tesseract' || !process.env.ENABLE_EXTERNAL_OCR) {
      // Use local Tesseract.js for OCR
      ocrText = await performTesseractOCR(imageBuffer, language);
    } else {
      // Use external AI vision API (if configured)
      await rateLimiter.wait();
      ocrText = await performAIVisionOCR(contentHash);
    }

    // Cache the OCR result in S3
    await contentStore.saveCache(contentHash, 'ocr-text.txt', Buffer.from(ocrText), 'text/plain');

    loggers.processor.info('OCR succeeded', {
      contentHash,
      provider,
      textLength: ocrText.length,
    });

    return {
      success: true,
      cached: false,
      text: ocrText,
      textLength: ocrText.length,
      provider
    };

  } catch (error) {
    loggers.processor.error(
      'OCR processing failed',
      error instanceof Error ? error : undefined,
      {
        contentHash,
        provider,
        ...(error instanceof Error ? {} : { rawError: String(error) }),
      },
    );
    throw error;
  }
}

async function performTesseractOCR(imageBuffer: Buffer, language: string): Promise<string> {
  loggers.processor.debug('Running Tesseract OCR', { language });

  const worker = await Tesseract.createWorker(language);

  try {
    const { data: { text } } = await worker.recognize(imageBuffer);
    return text;
  } finally {
    await worker.terminate();
  }
}

async function performAIVisionOCR(contentHash: string): Promise<string> {
  // This would integrate with your existing AI vision providers
  // For now, return a placeholder or fall back to Tesseract
  loggers.processor.warn('AI Vision OCR not yet implemented, falling back to Tesseract', { contentHash });
  
  const imageBuffer = await contentStore.getOriginal(contentHash);
  if (!imageBuffer) {
    throw new Error('Image not found for AI Vision OCR');
  }
  
  return performTesseractOCR(imageBuffer, 'eng');
}

// Export function to check if a file needs OCR
export function needsOCR(mimeType: string): boolean {
  const imageTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/tiff',
    'image/bmp'
  ];

  return imageTypes.includes(mimeType);
}