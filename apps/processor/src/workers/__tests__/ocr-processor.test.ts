import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

// Mock tesseract.js
const mockWorkerRecognize = vi.fn().mockResolvedValue({ data: { text: 'OCR extracted text' } });
const mockWorkerTerminate = vi.fn().mockResolvedValue(undefined);
const mockCreateWorker = vi.fn().mockResolvedValue({
  recognize: mockWorkerRecognize,
  terminate: mockWorkerTerminate,
});

vi.mock('tesseract.js', () => ({
  default: {
    createWorker: (...args: unknown[]) => mockCreateWorker(...args),
  },
  createWorker: (...args: unknown[]) => mockCreateWorker(...args),
}));

// Mock fs module (used with require inside ocr-processor)
const mockReadFile = vi.fn();
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock('fs', () => ({
  default: {
    promises: {
      readFile: (...args: unknown[]) => mockReadFile(...args),
      mkdir: (...args: unknown[]) => mockMkdir(...args),
      writeFile: (...args: unknown[]) => mockWriteFile(...args),
    },
  },
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

// Mock path module (used with require inside ocr-processor)
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return {
    ...actual,
    default: actual,
  };
});

// Mock content store
const mockGetOriginal = vi.fn();
const mockGetCachePath = vi.fn().mockResolvedValue('/cache/abc123/ocr.jpg');

vi.mock('../../server', () => ({
  contentStore: {
    getOriginal: (...args: unknown[]) => mockGetOriginal(...args),
    getCachePath: (...args: unknown[]) => mockGetCachePath(...args),
  },
}));

import { processOCR, needsOCR } from '../ocr-processor';

const VALID_HASH = 'a'.repeat(64);

describe('processOCR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOriginal.mockResolvedValue(Buffer.from('image-data'));
    mockGetCachePath.mockResolvedValue(`/cache/${VALID_HASH}/ocr.jpg`);
    mockReadFile.mockRejectedValue({ code: 'ENOENT' }); // No cache by default
    mockWorkerRecognize.mockResolvedValue({ data: { text: 'OCR text result' } });
    mockWorkerTerminate.mockResolvedValue(undefined);
    mockCreateWorker.mockResolvedValue({
      recognize: mockWorkerRecognize,
      terminate: mockWorkerTerminate,
    });
  });

  it('performs OCR on image using tesseract', async () => {
    const result = await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
    });

    expect(result.success).toBe(true);
    expect(result.cached).toBe(false);
    expect(result.text).toBe('OCR text result');
    expect(result.provider).toBe('tesseract');
  });

  it('returns cached OCR result if available', async () => {
    const cachedText = 'Previously extracted OCR text';
    mockReadFile.mockResolvedValueOnce(cachedText);

    const result = await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
    });

    expect(result.success).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.text).toBe(cachedText);
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('uses specified language', async () => {
    await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      language: 'fra',
    });

    expect(mockCreateWorker).toHaveBeenCalledWith('fra');
  });

  it('defaults to english language', async () => {
    await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
    });

    expect(mockCreateWorker).toHaveBeenCalledWith('eng');
  });

  it('throws when original file not found', async () => {
    mockGetOriginal.mockResolvedValue(null);

    await expect(
      processOCR({ contentHash: VALID_HASH, fileId: 'page-1' })
    ).rejects.toThrow(`Original file not found: ${VALID_HASH}`);
  });

  it('throws when tesseract fails', async () => {
    mockWorkerRecognize.mockRejectedValueOnce(new Error('Tesseract error'));
    mockCreateWorker.mockResolvedValue({
      recognize: mockWorkerRecognize,
      terminate: mockWorkerTerminate,
    });

    await expect(
      processOCR({ contentHash: VALID_HASH, fileId: 'page-1' })
    ).rejects.toThrow('Tesseract error');
  });

  it('terminates worker after OCR', async () => {
    await processOCR({ contentHash: VALID_HASH, fileId: 'page-1' });

    expect(mockWorkerTerminate).toHaveBeenCalled();
  });

  it('writes OCR result to cache', async () => {
    await processOCR({ contentHash: VALID_HASH, fileId: 'page-1' });

    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('includes textLength in result', async () => {
    const ocrText = 'OCR text result';
    mockWorkerRecognize.mockResolvedValue({ data: { text: ocrText } });
    mockCreateWorker.mockResolvedValue({
      recognize: mockWorkerRecognize,
      terminate: mockWorkerTerminate,
    });

    const result = await processOCR({ contentHash: VALID_HASH, fileId: 'page-1' });

    expect(result.textLength).toBe(ocrText.length);
  });

  it('uses ai-vision provider when ENABLE_EXTERNAL_OCR is set', async () => {
    process.env.ENABLE_EXTERNAL_OCR = 'true';

    const result = await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      provider: 'ai-vision',
    });

    // ai-vision falls back to tesseract since it's not implemented
    expect(result.success).toBe(true);
    expect(mockCreateWorker).toHaveBeenCalled();

    delete process.env.ENABLE_EXTERNAL_OCR;
  });

  it('forces tesseract when provider is tesseract', async () => {
    process.env.ENABLE_EXTERNAL_OCR = 'true';

    const result = await processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      provider: 'tesseract',
    });

    expect(result.provider).toBe('tesseract');
    expect(mockCreateWorker).toHaveBeenCalled();

    delete process.env.ENABLE_EXTERNAL_OCR;
  });

  it('rate limits rapid successive AI vision OCR calls', async () => {
    process.env.ENABLE_EXTERNAL_OCR = 'true';

    // First call sets lastCall timestamp
    const firstCall = processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      provider: 'ai-vision',
    });
    // Second call immediately after - rate limiter delay code runs (lines 17-19)
    const secondCall = processOCR({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      provider: 'ai-vision',
    });

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    delete process.env.ENABLE_EXTERNAL_OCR;
  }, 10000);

  it('throws when performAIVisionOCR cannot find image on second getOriginal call', async () => {
    process.env.ENABLE_EXTERNAL_OCR = 'true';

    // First getOriginal call (line 48) returns the image so we pass the null check
    // Second getOriginal call (line 103, inside performAIVisionOCR) returns null
    mockGetOriginal
      .mockResolvedValueOnce(Buffer.from('image-data'))
      .mockResolvedValueOnce(null);

    await expect(
      processOCR({
        contentHash: VALID_HASH,
        fileId: 'page-1',
        provider: 'ai-vision',
      })
    ).rejects.toThrow('Image not found for AI Vision OCR');

    delete process.env.ENABLE_EXTERNAL_OCR;
  });
});

describe('needsOCR', () => {
  it('returns true for image/jpeg', () => {
    expect(needsOCR('image/jpeg')).toBe(true);
  });

  it('returns true for image/png', () => {
    expect(needsOCR('image/png')).toBe(true);
  });

  it('returns true for image/gif', () => {
    expect(needsOCR('image/gif')).toBe(true);
  });

  it('returns true for image/webp', () => {
    expect(needsOCR('image/webp')).toBe(true);
  });

  it('returns true for image/tiff', () => {
    expect(needsOCR('image/tiff')).toBe(true);
  });

  it('returns true for image/bmp', () => {
    expect(needsOCR('image/bmp')).toBe(true);
  });

  it('returns false for application/pdf', () => {
    expect(needsOCR('application/pdf')).toBe(false);
  });

  it('returns false for text/plain', () => {
    expect(needsOCR('text/plain')).toBe(false);
  });

  it('returns false for unknown type', () => {
    expect(needsOCR('video/mp4')).toBe(false);
  });
});
