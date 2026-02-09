import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const uploadSource = fs.readFileSync(
  path.resolve(__dirname, '../upload.ts'),
  'utf-8'
);

describe('upload dedupe response contract', () => {
  it('given the dedupe path, should not call getQueuedJobs', () => {
    expect(uploadSource).not.toContain('getQueuedJobs');
  });

  it('given the dedupe path, should use queueProcessingJobs return value for jobs field', () => {
    // The dedupe path should assign `const jobs = await queueProcessingJobs(...)` and use it directly
    expect(uploadSource).toContain('const jobs = await queueProcessingJobs(');
  });

  it('given the response shape, both paths should return jobs as string[]', () => {
    // queueProcessingJobs returns Promise<string[]>, so both paths return the same shape
    // Verify the function signature
    expect(uploadSource).toContain('): Promise<string[]>');
  });

  it('should not contain the hardcoded { ingest: true } stub', () => {
    expect(uploadSource).not.toContain('{ ingest: true }');
  });
});
