import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import { contentStore } from '../server';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

interface TextExtractJobData {
  contentHash: string;
  fileId: string;
  mimeType: string;
  originalName: string;
}

export async function extractText(data: TextExtractJobData): Promise<any> {
  const { contentHash, mimeType, originalName } = data;

  console.log(`Extracting text from ${originalName} (${mimeType})`);

  // Get original file
  const fileBuffer = await contentStore.getOriginal(contentHash);
  if (!fileBuffer) {
    throw new Error(`Original file not found: ${contentHash}`);
  }

  let extractedText = '';
  let metadata: any = {};

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
        console.log(`Unsupported mime type for text extraction: ${mimeType}`);
        return {
          success: false,
          error: `Unsupported file type: ${mimeType}`
        };
    }

    // Save extracted text to cache
    const textCachePath = `${contentHash}/extracted-text.txt`;
    const cacheDir = require('path').dirname(await contentStore.getCachePath(contentHash, 'text'));
    await require('fs').promises.mkdir(cacheDir, { recursive: true });
    await require('fs').promises.writeFile(
      require('path').join(cacheDir, 'extracted-text.txt'),
      extractedText
    );

    console.log(`Successfully extracted ${extractedText.length} characters from ${originalName}`);

    return {
      success: true,
      text: extractedText,
      textLength: extractedText.length,
      metadata,
      cached: true
    };

  } catch (error) {
    console.error(`Failed to extract text from ${originalName}:`, error);
    throw error;
  }
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; metadata: any }> {
  const uint8Array = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdf = await loadingTask.promise;

  const metadata = await pdf.getMetadata();
  const numPages = pdf.numPages;
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    
    textParts.push(pageText);
  }

  const info = metadata.info as any;
  
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
    console.warn('DOCX extraction warnings:', result.messages);
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