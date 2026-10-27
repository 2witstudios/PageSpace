import { describe, it, expectTypeOf } from 'vitest';
import type {
  IngestFileJobData,
  ImageOptimizeJobData,
  TextExtractJobData,
  OCRJobData,
  QueueName,
  JobDataMap,
  ProcessingJob,
  IngestResult,
  ImageProcessResult,
  TextExtractResult,
  OCRResult,
  QueueStats,
} from '../../types';

describe('Job data interfaces', () => {
  it('IngestFileJobData requires contentHash, fileId, mimeType, originalName', () => {
    expectTypeOf<IngestFileJobData>().toHaveProperty('contentHash');
    expectTypeOf<IngestFileJobData>().toHaveProperty('fileId');
    expectTypeOf<IngestFileJobData>().toHaveProperty('mimeType');
    expectTypeOf<IngestFileJobData>().toHaveProperty('originalName');
  });

  it('ImageOptimizeJobData requires contentHash, preset; fileId is optional', () => {
    expectTypeOf<ImageOptimizeJobData>().toHaveProperty('contentHash');
    expectTypeOf<ImageOptimizeJobData>().toHaveProperty('preset');
    expectTypeOf<ImageOptimizeJobData>().toHaveProperty('fileId');

    // fileId is optional
    expectTypeOf<{ contentHash: string; preset: string }>().toMatchTypeOf<ImageOptimizeJobData>();
  });

  it('TextExtractJobData requires contentHash, fileId, mimeType, originalName', () => {
    expectTypeOf<TextExtractJobData>().toHaveProperty('contentHash');
    expectTypeOf<TextExtractJobData>().toHaveProperty('fileId');
    expectTypeOf<TextExtractJobData>().toHaveProperty('mimeType');
    expectTypeOf<TextExtractJobData>().toHaveProperty('originalName');
  });

  it('OCRJobData requires contentHash, fileId; language and provider are optional', () => {
    expectTypeOf<OCRJobData>().toHaveProperty('contentHash');
    expectTypeOf<OCRJobData>().toHaveProperty('fileId');

    // language and provider are optional
    expectTypeOf<{ contentHash: string; fileId: string }>().toMatchTypeOf<OCRJobData>();
  });
});

describe('QueueName type', () => {
  it('is a union of the 5 queue names', () => {
    expectTypeOf<'ingest-file'>().toMatchTypeOf<QueueName>();
    expectTypeOf<'image-optimize'>().toMatchTypeOf<QueueName>();
    expectTypeOf<'text-extract'>().toMatchTypeOf<QueueName>();
    expectTypeOf<'ocr-process'>().toMatchTypeOf<QueueName>();
    expectTypeOf<'siem-delivery'>().toMatchTypeOf<QueueName>();

    // Invalid queue name should not match
    expectTypeOf<'invalid-queue'>().not.toMatchTypeOf<QueueName>();
  });
});

describe('JobDataMap type', () => {
  it('maps queue names to their job data types', () => {
    expectTypeOf<JobDataMap['ingest-file']>().toEqualTypeOf<IngestFileJobData>();
    expectTypeOf<JobDataMap['image-optimize']>().toEqualTypeOf<ImageOptimizeJobData>();
    expectTypeOf<JobDataMap['text-extract']>().toEqualTypeOf<TextExtractJobData>();
    expectTypeOf<JobDataMap['ocr-process']>().toEqualTypeOf<OCRJobData>();
  });
});

describe('ProcessingJob.result type', () => {
  it('accepts IngestResult', () => {
    const result: IngestResult = { success: true, status: 'completed', textLength: 100 };
    expectTypeOf(result).toMatchTypeOf<NonNullable<ProcessingJob['result']>>();
  });

  it('accepts ImageProcessResult', () => {
    const result: ImageProcessResult = { success: true, cached: false, url: '/test', size: 1024 };
    expectTypeOf(result).toMatchTypeOf<NonNullable<ProcessingJob['result']>>();
  });

  it('accepts TextExtractResult', () => {
    const result: TextExtractResult = { success: true, text: 'hello', textLength: 5 };
    expectTypeOf(result).toMatchTypeOf<NonNullable<ProcessingJob['result']>>();
  });

  it('accepts OCRResult', () => {
    const result: OCRResult = { success: true, cached: false, text: 'hello', provider: 'tesseract' };
    expectTypeOf(result).toMatchTypeOf<NonNullable<ProcessingJob['result']>>();
  });
});

describe('QueueStats interface', () => {
  it('has active, pending, completed, failed number fields', () => {
    expectTypeOf<QueueStats>().toHaveProperty('active');
    expectTypeOf<QueueStats>().toHaveProperty('pending');
    expectTypeOf<QueueStats>().toHaveProperty('completed');
    expectTypeOf<QueueStats>().toHaveProperty('failed');
    expectTypeOf<QueueStats['active']>().toBeNumber();
  });
});
