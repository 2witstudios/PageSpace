import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';

// Mock @aws-sdk/lib-storage Upload class
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn().mockImplementation(() => ({
    done: vi.fn().mockResolvedValue({}),
  })),
}));

// Mock fs for createReadStream (used in hashFile / saveOriginalFromFile stream)
const mockCreateReadStream = vi.hoisted(() =>
  vi.fn(() => {
    const { EventEmitter } = require('events');
    const emitter = new EventEmitter();
    process.nextTick(() => {
      emitter.emit('data', Buffer.from('test-data'));
      emitter.emit('end');
    });
    return emitter;
  }),
);

const mockStat = vi.hoisted(() => vi.fn().mockResolvedValue({ size: 1024 }));

vi.mock('fs', () => ({
  createReadStream: mockCreateReadStream,
}));

vi.mock('fs/promises', () => ({
  stat: mockStat,
}));

import { ContentStore, isValidContentHash, isValidPreset, InvalidContentHashError } from '../content-store';

const VALID_HASH = 'a'.repeat(64);
const BUCKET = 'test-bucket';

function makeBody(data: Buffer | string): AsyncIterable<Uint8Array> {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array(buf);
    },
  };
}

const NOT_FOUND = Object.assign(new Error('Not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

function createStore() {
  const send = vi.fn();
  const s3 = { send } as unknown as S3Client;
  const store = new ContentStore(s3, BUCKET);
  return { store, send };
}

describe('ContentStore', () => {
  describe('initialize', () => {
    it('is a no-op (S3 bucket is pre-created)', async () => {
      const { store, send } = createStore();
      await store.initialize();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('getCachePath', () => {
    it('returns S3 key containing hash and preset', async () => {
      const { store } = createStore();
      const key = await store.getCachePath(VALID_HASH, 'thumbnail');
      expect(key).toContain(VALID_HASH.toLowerCase());
      expect(key).toContain('thumbnail');
    });

    it('throws InvalidContentHashError for invalid hash', async () => {
      const { store } = createStore();
      await expect(store.getCachePath('invalid', 'thumbnail')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('getOriginalPath', () => {
    it('returns S3 key containing hash and "original"', async () => {
      const { store } = createStore();
      const key = await store.getOriginalPath(VALID_HASH);
      expect(key).toContain(VALID_HASH.toLowerCase());
      expect(key).toContain('original');
    });

    it('throws InvalidContentHashError for invalid hash', async () => {
      const { store } = createStore();
      await expect(store.getOriginalPath('bad')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('cacheExists', () => {
    it('returns true when HeadObject succeeds', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({});
      expect(await store.cacheExists(VALID_HASH, 'thumbnail')).toBe(true);
    });

    it('returns false when HeadObject returns 404', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.cacheExists(VALID_HASH, 'thumbnail')).toBe(false);
    });

    it('returns false for invalid content hash', async () => {
      const { store } = createStore();
      expect(await store.cacheExists('invalid', 'thumbnail')).toBe(false);
    });

    it('returns false for invalid preset (path traversal)', async () => {
      const { store } = createStore();
      expect(await store.cacheExists(VALID_HASH, '../traversal')).toBe(false);
    });

    it('rethrows unexpected S3 errors', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(new Error('Network error'));
      await expect(store.cacheExists(VALID_HASH, 'thumbnail')).rejects.toThrow('Network error');
    });
  });

  describe('saveCache', () => {
    it('puts buffer to S3 and writes metadata', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({}); // PutObject for file
      send.mockRejectedValueOnce(NOT_FOUND); // GetObject for existing metadata → not found
      send.mockResolvedValueOnce({}); // PutObject for metadata

      const buffer = Buffer.from('image-data');
      const entry = await store.saveCache(VALID_HASH, 'thumbnail', buffer, 'image/webp');

      expect(entry.contentHash).toBe(VALID_HASH);
      expect(entry.preset).toBe('thumbnail');
      expect(entry.size).toBe(buffer.length);
      expect(entry.mimeType).toBe('image/webp');
      expect(send).toHaveBeenCalledTimes(3);
    });

    it('merges with existing metadata', async () => {
      const { store, send } = createStore();
      const existingMeta = JSON.stringify({
        'ai-chat': { preset: 'ai-chat', size: 100, mimeType: 'image/jpeg', createdAt: new Date().toISOString(), lastAccessed: new Date().toISOString() },
      });
      send.mockResolvedValueOnce({}); // PutObject for file
      // GetObject for existing metadata
      send.mockResolvedValueOnce({ Body: makeBody(existingMeta) });
      send.mockResolvedValueOnce({}); // PutObject metadata

      const buffer = Buffer.from('new-data');
      await store.saveCache(VALID_HASH, 'thumbnail', buffer, 'image/webp');

      // 3rd call is PutObject for metadata — verify it's JSON
      const metaPutCall = send.mock.calls[2][0] as { input: { Body: string; ContentType: string } };
      expect(metaPutCall.input.ContentType).toBe('application/json');
      const written = JSON.parse(metaPutCall.input.Body);
      expect(written.thumbnail).toBeTruthy();
      expect(written['ai-chat']).toBeTruthy();
    });

    it('skips unsafe metadata keys from existing metadata', async () => {
      const { store, send } = createStore();
      const malicious = JSON.stringify({ ['__proto__']: { preset: 'hack' }, thumbnail: { preset: 'thumbnail', size: 1, mimeType: 'x', createdAt: '', lastAccessed: '' } });
      send.mockResolvedValueOnce({}); // PutObject file
      send.mockResolvedValueOnce({ Body: makeBody(malicious) }); // GetObject meta
      send.mockResolvedValueOnce({}); // PutObject meta

      await store.saveCache(VALID_HASH, 'thumbnail', Buffer.from('x'), 'image/webp');
      const putMeta = send.mock.calls[2][0] as { input: { Body: string } };
      const written = JSON.parse(putMeta.input.Body ?? '{}');
      expect(Object.hasOwn(written, '__proto__')).toBe(false);
    });
  });

  describe('getCache', () => {
    it('returns buffer when object exists', async () => {
      const { store, send } = createStore();
      const data = Buffer.from('cached-data');
      send.mockResolvedValueOnce({ Body: makeBody(data) });
      const result = await store.getCache(VALID_HASH, 'thumbnail');
      expect(result).toEqual(data);
    });

    it('returns null when object not found', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.getCache(VALID_HASH, 'thumbnail')).toBeNull();
    });

    it('returns null for invalid content hash', async () => {
      const { store } = createStore();
      expect(await store.getCache('invalid', 'thumbnail')).toBeNull();
    });

    it('returns null for invalid preset', async () => {
      const { store } = createStore();
      expect(await store.getCache(VALID_HASH, '../etc')).toBeNull();
    });
  });

  describe('saveOriginal', () => {
    it('puts buffer to S3 and writes metadata', async () => {
      const { store, send } = createStore();
      send.mockResolvedValue({}); // PutObject original, PutObject meta, PutObject meta (appendUploadMetadata)

      const buffer = Buffer.from('original-file');
      const result = await store.saveOriginal(buffer, 'test.pdf', { tenantId: 'tenant-1' });
      expect(result.contentHash).toHaveLength(64);
      expect(send).toHaveBeenCalled();
    });
  });

  describe('saveOriginalFromFile', () => {
    it('streams file to S3 and writes metadata', async () => {
      const { store, send } = createStore();
      send.mockResolvedValue({});

      const result = await store.saveOriginalFromFile('/tmp/upload', 'test.pdf', VALID_HASH);
      expect(result.contentHash).toBe(VALID_HASH);
      expect(result.path).toContain(VALID_HASH);
    });

    it('computes hash when not provided', async () => {
      const { store, send } = createStore();
      send.mockResolvedValue({});

      const result = await store.saveOriginalFromFile('/tmp/upload', 'test.pdf');
      expect(result.contentHash).toHaveLength(64);
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('originalExists', () => {
    it('returns true when HeadObject succeeds', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({});
      expect(await store.originalExists(VALID_HASH)).toBe(true);
    });

    it('returns false when HeadObject returns 404', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.originalExists(VALID_HASH)).toBe(false);
    });

    it('returns false for invalid hash', async () => {
      const { store } = createStore();
      expect(await store.originalExists('invalid')).toBe(false);
    });
  });

  describe('getOriginal', () => {
    it('returns buffer when object exists', async () => {
      const { store, send } = createStore();
      const data = Buffer.from('original-data');
      send.mockResolvedValueOnce({ Body: makeBody(data) });
      expect(await store.getOriginal(VALID_HASH)).toEqual(data);
    });

    it('returns null when object not found', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.getOriginal(VALID_HASH)).toBeNull();
    });

    it('returns null for invalid hash', async () => {
      const { store } = createStore();
      expect(await store.getOriginal('invalid-hash')).toBeNull();
    });

    it('rethrows non-InvalidContentHashError from normalizeContentHash', async () => {
      const { store } = createStore();
      const orig = (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash;
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = () => {
        throw new TypeError('Unexpected error');
      };
      await expect(store.getOriginal(VALID_HASH)).rejects.toThrow('Unexpected error');
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = orig;
    });
  });

  describe('getCacheUrl', () => {
    it('returns /cache/{hash}/{preset} path', async () => {
      const { store } = createStore();
      expect(await store.getCacheUrl(VALID_HASH, 'thumbnail')).toBe(`/cache/${VALID_HASH}/thumbnail`);
    });

    it('throws for invalid hash', async () => {
      const { store } = createStore();
      await expect(store.getCacheUrl('invalid', 'thumbnail')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('getCacheMetadata', () => {
    it('returns empty object when metadata not found', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.getCacheMetadata(VALID_HASH)).toEqual({});
    });

    it('returns parsed metadata entries', async () => {
      const { store, send } = createStore();
      const meta = JSON.stringify({
        thumbnail: { path: 'cache/x/thumbnail', size: 1000, mimeType: 'image/webp', createdAt: '2024-01-01T00:00:00Z', lastAccessed: '2024-01-02T00:00:00Z' },
      });
      send.mockResolvedValueOnce({ Body: makeBody(meta) });
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail).toBeTruthy();
      expect(result.thumbnail.size).toBe(1000);
    });

    it('skips dangerous keys', async () => {
      const { store, send } = createStore();
      const meta = JSON.stringify({
        ['__proto__']: { path: '/bad', size: 0, mimeType: 'x', createdAt: '', lastAccessed: '' },
        thumbnail: { path: 'cache/x/thumbnail', size: 100, mimeType: 'image/webp', createdAt: '2024-01-01T00:00:00Z', lastAccessed: '2024-01-01T00:00:00Z' },
      });
      send.mockResolvedValueOnce({ Body: makeBody(meta) });
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(Object.hasOwn(result, '__proto__')).toBe(false);
      expect(result.thumbnail).toBeTruthy();
    });

    it('skips invalid preset keys', async () => {
      const { store, send } = createStore();
      const meta = JSON.stringify({
        '../evil': { size: 0, mimeType: 'x', createdAt: '', lastAccessed: '', path: '/bad' },
        'valid-preset': { path: 'x', size: 100, mimeType: 'image/jpeg', createdAt: '2024-01-01T00:00:00Z', lastAccessed: '2024-01-01T00:00:00Z' },
      });
      send.mockResolvedValueOnce({ Body: makeBody(meta) });
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result['../evil']).toBeUndefined();
    });

    it('rethrows non-404 S3 errors', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(new Error('Permission denied'));
      await expect(store.getCacheMetadata(VALID_HASH)).rejects.toThrow('Permission denied');
    });

    it('returns empty for null metadata body', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody('null') });
      expect(await store.getCacheMetadata(VALID_HASH)).toEqual({});
    });

    it('uses default path when entry has no path', async () => {
      const { store, send } = createStore();
      const meta = JSON.stringify({
        thumbnail: { size: 100, mimeType: 'image/webp', createdAt: '2024-01-01T00:00:00Z', lastAccessed: '2024-01-01T00:00:00Z' },
      });
      send.mockResolvedValueOnce({ Body: makeBody(meta) });
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail.path).toContain('thumbnail');
    });

    it('uses default values when entry fields are missing', async () => {
      const { store, send } = createStore();
      const meta = JSON.stringify({ thumbnail: { path: 'x' } });
      send.mockResolvedValueOnce({ Body: makeBody(meta) });
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail.size).toBe(0);
      expect(result.thumbnail.mimeType).toBe('application/octet-stream');
    });
  });

  describe('getOriginalMetadata', () => {
    it('returns null for invalid hash', async () => {
      const { store } = createStore();
      expect(await store.getOriginalMetadata('invalid')).toBeNull();
    });

    it('returns null when object not found', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.getOriginalMetadata(VALID_HASH)).toBeNull();
    });

    it('returns normalized metadata', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'test.pdf', contentHash: VALID_HASH, size: 2048, savedAt: '2024-01-01T00:00:00Z', tenants: ['t1'] })) });
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.originalName).toBe('test.pdf');
      expect(result?.size).toBe(2048);
    });

    it('normalizes invalid raw metadata gracefully', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody('{}') });
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.originalName).toBe('file');
      expect(result?.size).toBe(0);
    });

    it('handles uploads array in metadata', async () => {
      const { store, send } = createStore();
      const raw = JSON.stringify({ originalName: 'test.pdf', contentHash: VALID_HASH, size: 100, savedAt: '2024-01-01T00:00:00Z', uploads: [{ tenantId: 't1', uploadedAt: '2024-01-01T00:00:00Z' }, {}] });
      send.mockResolvedValueOnce({ Body: makeBody(raw) });
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.uploads).toHaveLength(2);
    });

    it('falls back to new Date() when uploadedAt is not a string', async () => {
      const { store, send } = createStore();
      const raw = JSON.stringify({ originalName: 'x', contentHash: VALID_HASH, size: 0, savedAt: '2024-01-01T00:00:00Z', uploads: [{ uploadedAt: 12345 }] });
      send.mockResolvedValueOnce({ Body: makeBody(raw) });
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.uploads?.[0].uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('generates contentHash from name+size if missing', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'file.pdf', size: 100, savedAt: '2024-01-01T00:00:00Z' })) });
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.contentHash).toHaveLength(64);
    });

    it('rethrows non-InvalidContentHashError from normalizeContentHash', async () => {
      const { store } = createStore();
      const orig = (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash;
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = () => {
        throw new TypeError('Unexpected normalize error');
      };
      await expect(store.getOriginalMetadata(VALID_HASH)).rejects.toThrow('Unexpected normalize error');
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = orig;
    });
  });

  describe('appendUploadMetadata', () => {
    it('creates new metadata when none exists', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND); // GetObject for existing meta → not found
      send.mockResolvedValueOnce({}); // PutObject for new meta

      await store.appendUploadMetadata(VALID_HASH, { tenantId: 'tenant-1', driveId: 'drive-1', userId: 'user-1', service: 'processor' });

      const putCall = send.mock.calls[1][0] as { input: { Body: string } };
      expect(putCall.input.Body).toContain('tenant-1');
    });

    it('appends to existing metadata', async () => {
      const { store, send } = createStore();
      const existing = JSON.stringify({ originalName: 'f', contentHash: VALID_HASH, size: 1, savedAt: new Date().toISOString(), tenants: ['old'], uploads: [] });
      send.mockResolvedValueOnce({ Body: makeBody(existing) }); // GetObject existing meta
      send.mockResolvedValueOnce({}); // PutObject updated meta

      await store.appendUploadMetadata(VALID_HASH, { tenantId: 'new-tenant' });

      const putCall = send.mock.calls[1][0] as { input: { Body: string } };
      expect(putCall.input.Body).toContain('new-tenant');
    });

    it('handles undefined options', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      send.mockResolvedValueOnce({});
      await expect(store.appendUploadMetadata(VALID_HASH)).resolves.not.toThrow();
    });
  });

  describe('tenantHasAccess', () => {
    it('returns false for null tenantId', async () => {
      const { store } = createStore();
      expect(await store.tenantHasAccess(VALID_HASH, null)).toBe(false);
    });

    it('returns false when no metadata', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(NOT_FOUND);
      expect(await store.tenantHasAccess(VALID_HASH, 'tenant-1')).toBe(false);
    });

    it('returns true when no tenant list (open access)', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'f', contentHash: VALID_HASH, size: 0, savedAt: new Date().toISOString() })) });
      expect(await store.tenantHasAccess(VALID_HASH, 'tenant-1')).toBe(true);
    });

    it('returns true when tenants array is empty', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'f', contentHash: VALID_HASH, size: 0, savedAt: new Date().toISOString(), tenants: [] })) });
      expect(await store.tenantHasAccess(VALID_HASH, 'tenant-1')).toBe(true);
    });

    it('returns true when tenantId is in list', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'f', contentHash: VALID_HASH, size: 0, savedAt: new Date().toISOString(), tenants: ['tenant-1', 'tenant-2'] })) });
      expect(await store.tenantHasAccess(VALID_HASH, 'tenant-1')).toBe(true);
    });

    it('returns false when tenantId not in list', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Body: makeBody(JSON.stringify({ originalName: 'f', contentHash: VALID_HASH, size: 0, savedAt: new Date().toISOString(), tenants: ['tenant-2'] })) });
      expect(await store.tenantHasAccess(VALID_HASH, 'tenant-1')).toBe(false);
    });

    it('returns false for undefined tenantId', async () => {
      const { store } = createStore();
      expect(await store.tenantHasAccess(VALID_HASH, undefined)).toBe(false);
    });
  });

  describe('deleteOriginal', () => {
    it('returns true when both DeleteObject calls succeed', async () => {
      const { store, send } = createStore();
      send.mockResolvedValue({});
      expect(await store.deleteOriginal(VALID_HASH)).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('returns false when deletion throws', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(new Error('Permission denied'));
      expect(await store.deleteOriginal(VALID_HASH)).toBe(false);
    });

    it('returns false for invalid hash', async () => {
      const { store } = createStore();
      expect(await store.deleteOriginal('invalid')).toBe(false);
    });

    it('rethrows when normalizeContentHash throws non-InvalidContentHashError', async () => {
      const { store } = createStore();
      const orig = (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash;
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = () => { throw new TypeError('Unexpected type error'); };
      await expect(store.deleteOriginal(VALID_HASH)).rejects.toThrow('Unexpected type error');
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = orig;
    });
  });

  describe('deleteCache', () => {
    it('returns true when list and delete succeed', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Contents: [{ Key: `cache/${VALID_HASH}/thumbnail` }] }); // ListObjectsV2
      send.mockResolvedValueOnce({}); // DeleteObjects
      expect(await store.deleteCache(VALID_HASH)).toBe(true);
    });

    it('returns true when no cache objects exist', async () => {
      const { store, send } = createStore();
      send.mockResolvedValueOnce({ Contents: [] });
      expect(await store.deleteCache(VALID_HASH)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('returns false when S3 operation throws', async () => {
      const { store, send } = createStore();
      send.mockRejectedValueOnce(new Error('Fail'));
      expect(await store.deleteCache(VALID_HASH)).toBe(false);
    });

    it('returns false for invalid hash', async () => {
      const { store } = createStore();
      expect(await store.deleteCache('invalid')).toBe(false);
    });

    it('rethrows when normalizeContentHash throws non-InvalidContentHashError', async () => {
      const { store } = createStore();
      const orig = (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash;
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = () => { throw new TypeError('Unexpected cache error'); };
      await expect(store.deleteCache(VALID_HASH)).rejects.toThrow('Unexpected cache error');
      (store as unknown as { normalizeContentHash: (h: string) => string }).normalizeContentHash = orig;
    });
  });

  describe('deleteOriginalAndCache', () => {
    it('returns true for both when all S3 calls succeed', async () => {
      const { store, send } = createStore();
      send.mockResolvedValue({});
      send.mockResolvedValueOnce({}); // deleteOriginal: original
      send.mockResolvedValueOnce({}); // deleteOriginal: metadata
      send.mockResolvedValueOnce({ Contents: [] }); // deleteCache: list
      const result = await store.deleteOriginalAndCache(VALID_HASH);
      expect(result.originalDeleted).toBe(true);
      expect(result.cacheDeleted).toBe(true);
    });
  });

  describe('cleanupOldCache', () => {
    it('is a no-op and returns 0 (S3 lifecycle handles TTL)', async () => {
      const { store, send } = createStore();
      expect(await store.cleanupOldCache()).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });
  });
});

describe('isValidContentHash', () => {
  it('returns true for valid 64-char hex hash', () => {
    expect(isValidContentHash('a'.repeat(64))).toBe(true);
  });

  it('returns false for short hash', () => {
    expect(isValidContentHash('abc')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isValidContentHash(null as unknown as string)).toBe(false);
  });
});

describe('isValidPreset', () => {
  it('returns true for valid presets', () => {
    expect(isValidPreset('thumbnail')).toBe(true);
    expect(isValidPreset('ai-chat')).toBe(true);
    expect(isValidPreset('extracted-text.txt')).toBe(true);
  });

  it('returns false for path traversal', () => {
    expect(isValidPreset('../evil')).toBe(false);
    expect(isValidPreset('foo/../bar')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isValidPreset(null as unknown as string)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidPreset('')).toBe(false);
  });
});

describe('InvalidContentHashError', () => {
  it('creates error with correct name and contentHash', () => {
    const err = new InvalidContentHashError('bad-hash');
    expect(err.name).toBe('InvalidContentHashError');
    expect(err.contentHash).toBe('bad-hash');
    expect(err.message).toBe('Invalid content hash format');
    expect(err).toBeInstanceOf(Error);
  });
});
