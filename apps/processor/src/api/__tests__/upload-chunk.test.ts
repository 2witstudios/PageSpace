import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const uploadSource = fs.readFileSync(
  path.resolve(__dirname, '../upload.ts'),
  'utf-8'
);

describe('chunked upload endpoint removal', () => {
  it('should not contain a /chunk route', () => {
    expect(uploadSource).not.toContain("'/chunk'");
  });

  it('should not contain the 501 not implemented response', () => {
    expect(uploadSource).not.toContain('Chunked upload not yet implemented');
  });
});
