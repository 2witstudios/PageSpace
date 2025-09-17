import Tesseract from 'tesseract.js';
import { contentStore } from '../server';

interface OCRJobData {
  contentHash: string;
  fileId: string;
  language?: string;
  provider?: 'tesseract' | 'ai-vision';
}

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

export async function processOCR(data: OCRJobData): Promise<any> {
  const { contentHash, language = 'eng', provider = 'tesseract' } = data;

  console.log(`Processing OCR for ${contentHash} with ${provider}`);

  // Check if OCR result already cached
  const cacheDir = require('path').dirname(await contentStore.getCachePath(contentHash, 'ocr'));
  const ocrCachePath = require('path').join(cacheDir, 'ocr-text.txt');
  
  try {
    const cached = await require('fs').promises.readFile(ocrCachePath, 'utf-8');
    console.log(`OCR cache hit for ${contentHash}`);
    return {
      success: true,
      cached: true,
      text: cached,
      provider
    };
  } catch {
    // Not cached, proceed with OCR
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

    // Cache the OCR result
    await require('fs').promises.mkdir(cacheDir, { recursive: true });
    await require('fs').promises.writeFile(ocrCachePath, ocrText);

    console.log(`Successfully extracted ${ocrText.length} characters via OCR from ${contentHash}`);

    return {
      success: true,
      cached: false,
      text: ocrText,
      textLength: ocrText.length,
      provider
    };

  } catch (error) {
    console.error(`OCR processing failed for ${contentHash}:`, error);
    throw error;
  }
}

async function performTesseractOCR(imageBuffer: Buffer, language: string): Promise<string> {
  console.log(`Running Tesseract OCR with language: ${language}`);
  
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
  console.log('AI Vision OCR not yet implemented, falling back to Tesseract');
  
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