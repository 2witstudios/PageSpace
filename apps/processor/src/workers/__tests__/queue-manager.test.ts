import { describe, it, vi, expectTypeOf } from 'vitest';
import { assert } from '../../__tests__/riteway';

vi.mock('../../db', () => ({
  setPageProcessing: vi.fn(),
  setPageCompleted: vi.fn(),
  setPageFailed: vi.fn(),
  setPageVisual: vi.fn(),
}));

vi.mock('../text-extractor', () => ({
  needsTextExtraction: vi.fn(),
  extractText: vi.fn(),
}));

import { mapJobState } from '../queue-manager';
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
    assert({ given: 'QueueStats active', should: 'be 1', actual: stats.active, expected: 1 });
    assert({ given: 'QueueStats pending', should: 'be 2', actual: stats.pending, expected: 2 });
    assert({ given: 'QueueStats completed', should: 'be 3', actual: stats.completed, expected: 3 });
    assert({ given: 'QueueStats failed', should: 'be 0', actual: stats.failed, expected: 0 });
  });

  it('given QueueStats record, should be keyed by QueueName', () => {
    const status: Record<QueueName, QueueStats> = {
      'ingest-file': { active: 0, pending: 0, completed: 0, failed: 0 },
      'image-optimize': { active: 0, pending: 0, completed: 0, failed: 0 },
      'text-extract': { active: 0, pending: 0, completed: 0, failed: 0 },
      'ocr-process': { active: 0, pending: 0, completed: 0, failed: 0 },
    };

    assert({
      given: 'a Record<QueueName, QueueStats>',
      should: 'have 4 queue keys',
      actual: Object.keys(status).length,
      expected: 4,
    });
  });
});

describe('mapJobState', () => {
  it('given "created" state, should return pending', () => {
    assert({ given: '"created" state', should: 'return pending', actual: mapJobState('created'), expected: 'pending' });
  });

  it('given "retry" state, should return pending', () => {
    assert({ given: '"retry" state', should: 'return pending', actual: mapJobState('retry'), expected: 'pending' });
  });

  it('given "active" state, should return processing', () => {
    assert({ given: '"active" state', should: 'return processing', actual: mapJobState('active'), expected: 'processing' });
  });

  it('given "completed" state, should return completed', () => {
    assert({ given: '"completed" state', should: 'return completed', actual: mapJobState('completed'), expected: 'completed' });
  });

  it('given "failed" state, should return failed', () => {
    assert({ given: '"failed" state', should: 'return failed', actual: mapJobState('failed'), expected: 'failed' });
  });

  it('given "expired" state, should return failed', () => {
    assert({ given: '"expired" state', should: 'return failed', actual: mapJobState('expired'), expected: 'failed' });
  });

  it('given "cancelled" state, should return failed', () => {
    assert({ given: '"cancelled" state', should: 'return failed', actual: mapJobState('cancelled'), expected: 'failed' });
  });

  it('given an unknown state, should return pending', () => {
    assert({ given: 'unknown state', should: 'return pending', actual: mapJobState('unknown'), expected: 'pending' });
  });
});
