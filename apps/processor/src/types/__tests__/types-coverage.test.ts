import { describe, expect, it } from 'vitest';
import {
  IMAGE_PRESETS,
  type ImagePreset,
  type IngestFileJobData,
  type ImageOptimizeJobData,
  type TextExtractJobData,
  type OCRJobData,
  type JobDataMap,
  type QueueName,
  type IngestResult,
  type ImageProcessResult,
  type TextExtractResult,
  type OCRResult,
  type JobResult,
  type QueueStats,
  type ProcessingJob,
  type FileMetadata,
  type CacheEntry,
} from '../index';

describe('types/index.ts', () => {
  describe('IMAGE_PRESETS', () => {
    it('contains ai-chat preset', () => {
      expect(IMAGE_PRESETS['ai-chat']).toBeDefined();
      expect(IMAGE_PRESETS['ai-chat'].maxWidth).toBe(1920);
      expect(IMAGE_PRESETS['ai-chat'].quality).toBe(85);
      expect(IMAGE_PRESETS['ai-chat'].format).toBe('jpeg');
    });

    it('contains ai-vision preset', () => {
      expect(IMAGE_PRESETS['ai-vision']).toBeDefined();
      expect(IMAGE_PRESETS['ai-vision'].maxWidth).toBe(2048);
      expect(IMAGE_PRESETS['ai-vision'].format).toBe('jpeg');
    });

    it('contains thumbnail preset', () => {
      expect(IMAGE_PRESETS['thumbnail']).toBeDefined();
      expect(IMAGE_PRESETS['thumbnail'].maxWidth).toBe(200);
      expect(IMAGE_PRESETS['thumbnail'].maxHeight).toBe(200);
      expect(IMAGE_PRESETS['thumbnail'].format).toBe('webp');
    });

    it('contains preview preset', () => {
      expect(IMAGE_PRESETS['preview']).toBeDefined();
      expect(IMAGE_PRESETS['preview'].maxWidth).toBe(800);
      expect(IMAGE_PRESETS['preview'].format).toBe('jpeg');
    });

    it('has 4 presets', () => {
      expect(Object.keys(IMAGE_PRESETS)).toHaveLength(4);
    });
  });

  describe('type conformance checks (runtime values)', () => {
    it('IngestFileJobData can be constructed', () => {
      const job: IngestFileJobData = {
        contentHash: 'a'.repeat(64),
        fileId: 'page-1',
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      };
      expect(job.contentHash).toHaveLength(64);
    });

    it('ImageOptimizeJobData can be constructed', () => {
      const job: ImageOptimizeJobData = {
        contentHash: 'a'.repeat(64),
        preset: 'ai-chat',
        fileId: 'page-1',
      };
      expect(job.preset).toBe('ai-chat');
    });

    it('TextExtractJobData can be constructed', () => {
      const job: TextExtractJobData = {
        contentHash: 'a'.repeat(64),
        fileId: 'page-1',
        mimeType: 'application/pdf',
        originalName: 'test.pdf',
      };
      expect(job.fileId).toBe('page-1');
    });

    it('OCRJobData can be constructed', () => {
      const job: OCRJobData = {
        contentHash: 'a'.repeat(64),
        fileId: 'page-1',
        language: 'eng',
        provider: 'tesseract',
      };
      expect(job.provider).toBe('tesseract');
    });

    it('QueueStats can be constructed', () => {
      const stats: QueueStats = {
        active: 1,
        pending: 2,
        completed: 3,
        failed: 0,
      };
      expect(stats.active).toBe(1);
    });

    it('ProcessingJob can be constructed', () => {
      const job: ProcessingJob = {
        id: 'job-1',
        type: 'ingest-file',
        fileId: 'page-1',
        contentHash: 'a'.repeat(64),
        status: 'pending',
        createdAt: new Date(),
      };
      expect(job.status).toBe('pending');
    });

    it('FileMetadata can be constructed', () => {
      const meta: FileMetadata = {
        id: 'file-1',
        originalName: 'test.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        contentHash: 'a'.repeat(64),
        storagePath: '/storage/file-1',
      };
      expect(meta.mimeType).toBe('application/pdf');
    });

    it('CacheEntry can be constructed', () => {
      const entry: CacheEntry = {
        contentHash: 'a'.repeat(64),
        preset: 'thumbnail',
        path: '/cache/hash/thumbnail.jpg',
        size: 512,
        mimeType: 'image/webp',
        createdAt: new Date(),
        lastAccessed: new Date(),
      };
      expect(entry.preset).toBe('thumbnail');
    });

    it('IngestResult can be constructed', () => {
      const result: IngestResult = {
        success: true,
        status: 'completed',
        textLength: 100,
      };
      expect(result.status).toBe('completed');
    });

    it('ImageProcessResult can be constructed', () => {
      const result: ImageProcessResult = {
        success: true,
        cached: false,
        url: '/cache/hash/ai-chat',
        size: 1024,
        originalSize: 2048,
        compressionRatio: '50.0%',
      };
      expect(result.cached).toBe(false);
    });

    it('TextExtractResult can be constructed', () => {
      const result: TextExtractResult = {
        success: true,
        text: 'extracted text',
        textLength: 14,
        metadata: { title: 'Doc' },
        cached: false,
      };
      expect(result.text).toBe('extracted text');
    });

    it('OCRResult can be constructed', () => {
      const result: OCRResult = {
        success: true,
        cached: false,
        text: 'ocr text',
        textLength: 8,
        provider: 'tesseract',
      };
      expect(result.provider).toBe('tesseract');
    });
  });
});

// Types-only file (pdfjs.ts) - just import it to ensure it loads
describe('types/pdfjs.ts', () => {
  it('can import pdfjs types', async () => {
    // The pdfjs types are interface-only, so just verify the import works
    const module = await import('../pdfjs');
    // The module exports only type interfaces, which don't exist at runtime
    // Just checking it imports without error
    expect(module).toBeDefined();
  });
});
