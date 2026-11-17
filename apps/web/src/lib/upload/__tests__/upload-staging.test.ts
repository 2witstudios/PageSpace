import { describe, it, expect } from 'vitest';
import { buildUploadHoldingKey, buildUploadStagingKey } from '../upload-staging';

describe('buildUploadStagingKey', () => {
  it('should place the job under the staging prefix, apart from the served files/ keys', () => {
    expect(buildUploadStagingKey('user-1-slot_abc')).toBe('uploads/staging/user-1-slot_abc');
  });

  it.each(['', '../files/x', 'a/b', 'a b', 'a?b'])('given the unsafe job id %j, should throw', (jobId) => {
    expect(() => buildUploadStagingKey(jobId)).toThrow(/unsafe job id/);
  });
});

describe('buildUploadHoldingKey', () => {
  it('should be unique per call, under the job, apart from staging and served keys', () => {
    const a = buildUploadHoldingKey('job-1');
    const b = buildUploadHoldingKey('job-1');
    expect(a).not.toBe(b);
    expect(a.startsWith('uploads/verifying/job-1/')).toBe(true);
  });

  it('given an unsafe job id, should throw', () => {
    expect(() => buildUploadHoldingKey('../x')).toThrow(/unsafe job id/);
  });
});
