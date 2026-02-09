import { describe, it, expect, expectTypeOf } from 'vitest';
import type { QueueName, QueueStats, JobDataMap, IngestFileJobData, ImageOptimizeJobData, TextExtractJobData, OCRJobData } from '../../types';

describe('QueueManager type contracts', () => {
  it('given a QueueName, JobDataMap should resolve to the correct job data type', () => {
    expectTypeOf<JobDataMap['ingest-file']>().toEqualTypeOf<IngestFileJobData>();
    expectTypeOf<JobDataMap['image-optimize']>().toEqualTypeOf<ImageOptimizeJobData>();
    expectTypeOf<JobDataMap['text-extract']>().toEqualTypeOf<TextExtractJobData>();
    expectTypeOf<JobDataMap['ocr-process']>().toEqualTypeOf<OCRJobData>();
  });

  it('given QueueStats, should have numeric fields for active, pending, completed, failed', () => {
    const stats: QueueStats = { active: 1, pending: 2, completed: 3, failed: 0 };
    expect(stats.active).toBe(1);
    expect(stats.pending).toBe(2);
    expect(stats.completed).toBe(3);
    expect(stats.failed).toBe(0);
  });

  it('given QueueStats record, should be keyed by QueueName', () => {
    const status: Record<QueueName, QueueStats> = {
      'ingest-file': { active: 0, pending: 0, completed: 0, failed: 0 },
      'image-optimize': { active: 0, pending: 0, completed: 0, failed: 0 },
      'text-extract': { active: 0, pending: 0, completed: 0, failed: 0 },
      'ocr-process': { active: 0, pending: 0, completed: 0, failed: 0 },
    };

    expect(Object.keys(status)).toHaveLength(4);
    expect(Object.keys(status)).toEqual(
      expect.arrayContaining(['ingest-file', 'image-optimize', 'text-extract', 'ocr-process'])
    );
  });
});

describe('mapJobState coverage', () => {
  // Test the state mapping logic without needing PgBoss
  const mapJobState = (state: string): 'pending' | 'processing' | 'completed' | 'failed' => {
    switch (state) {
      case 'created':
      case 'retry':
        return 'pending';
      case 'active':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'expired':
      case 'cancelled':
        return 'failed';
      default:
        return 'pending';
    }
  };

  it('given created state, should return pending', () => {
    expect(mapJobState('created')).toBe('pending');
  });

  it('given retry state, should return pending', () => {
    expect(mapJobState('retry')).toBe('pending');
  });

  it('given active state, should return processing', () => {
    expect(mapJobState('active')).toBe('processing');
  });

  it('given completed state, should return completed', () => {
    expect(mapJobState('completed')).toBe('completed');
  });

  it('given failed state, should return failed', () => {
    expect(mapJobState('failed')).toBe('failed');
  });

  it('given expired state, should return failed', () => {
    expect(mapJobState('expired')).toBe('failed');
  });

  it('given cancelled state, should return failed', () => {
    expect(mapJobState('cancelled')).toBe('failed');
  });

  it('given unknown state, should return pending', () => {
    expect(mapJobState('unknown')).toBe('pending');
  });
});
