import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDirectorySize } from '../app-build-size';

describe('getDirectorySize', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('sums file sizes recursively, ignoring directory entries themselves', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'size-test-'));
    await writeFile(path.join(dir, 'a.txt'), 'x'.repeat(10));
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', 'b.txt'), 'y'.repeat(20));

    const size = await getDirectorySize(dir);
    expect(size).toBe(30);
  });

  it('returns 0 for an empty directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'size-test-empty-'));
    const size = await getDirectorySize(dir);
    expect(size).toBe(0);
  });
});
