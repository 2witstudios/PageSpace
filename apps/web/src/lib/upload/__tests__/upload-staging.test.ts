import { describe, it, expect } from 'vitest';
import { buildUploadStagingKey } from '../upload-staging';

describe('buildUploadStagingKey', () => {
  it('should place the job under the staging prefix, apart from the served files/ keys', () => {
    expect(buildUploadStagingKey('user-1-slot_abc')).toBe('uploads/staging/user-1-slot_abc');
  });

  it.each(['', '../files/x', 'a/b', 'a b', 'a?b'])('given the unsafe job id %j, should throw', (jobId) => {
    expect(() => buildUploadStagingKey(jobId)).toThrow(/unsafe job id/);
  });
});
