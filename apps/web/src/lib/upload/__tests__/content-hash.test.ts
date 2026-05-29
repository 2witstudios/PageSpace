import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { computeContentHash } from '../content-hash';

// Minimal File polyfill for the Node test environment — computeContentHash only
// uses File.arrayBuffer(), which jsdom's File does not implement reliably.
function makeFile(bytes: Uint8Array, name = 'f.bin'): File {
  return {
    name,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as File;
}

function expectedSha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

describe('computeContentHash', () => {
  it('returns the lowercase 64-char hex SHA-256 of the file bytes', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const hash = await computeContentHash(makeFile(bytes));
    expect(hash).toBe(expectedSha256(bytes));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is content-addressed — same bytes produce the same hash regardless of filename', async () => {
    const bytes = new TextEncoder().encode('identical content');
    const a = await computeContentHash(makeFile(bytes, 'first-name.txt'));
    const b = await computeContentHash(makeFile(bytes, 'totally-different.dat'));
    expect(a).toBe(b);
  });

  it('produces different hashes for different content', async () => {
    const a = await computeContentHash(makeFile(new TextEncoder().encode('content A')));
    const b = await computeContentHash(makeFile(new TextEncoder().encode('content B')));
    expect(a).not.toBe(b);
  });

  it('hashes empty file content to the known SHA-256 of the empty string', async () => {
    const hash = await computeContentHash(makeFile(new Uint8Array(0)));
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
