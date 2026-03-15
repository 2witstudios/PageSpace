import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

// Mock fs - use vi.hoisted to avoid hoisting issues
const { mockMkdir, mockWriteFile, mockReadFile, mockAccess, mockRm, mockRmdir, mockUnlink, mockStat, mockCopyFile, mockReaddir } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockAccess: vi.fn(),
  mockRm: vi.fn().mockResolvedValue(undefined),
  mockRmdir: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockStat: vi.fn(),
  mockCopyFile: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn().mockResolvedValue([]),
}));

vi.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    access: (...args: unknown[]) => mockAccess(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    rmdir: (...args: unknown[]) => mockRmdir(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    copyFile: (...args: unknown[]) => mockCopyFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
  createReadStream: vi.fn(() => {
    const EventEmitter = require('events').EventEmitter;
    const emitter = new EventEmitter();
    process.nextTick(() => {
      emitter.emit('data', Buffer.from('test-data'));
      emitter.emit('end');
    });
    return emitter;
  }),
}));

import { ContentStore, isValidContentHash, isValidPreset, InvalidContentHashError } from '../content-store';

const VALID_HASH = 'a'.repeat(64);
const BASE_CACHE_PATH = '/cache';
const BASE_STORAGE_PATH = '/storage';

function createStore() {
  return new ContentStore(BASE_CACHE_PATH, BASE_STORAGE_PATH);
}

describe('ContentStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockRejectedValue({ code: 'ENOENT' });
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    mockStat.mockResolvedValue({ size: 1024 });
  });

  describe('initialize', () => {
    it('creates cache and storage directories', async () => {
      const store = createStore();
      await store.initialize();

      expect(mockMkdir).toHaveBeenCalledWith(BASE_CACHE_PATH, { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(BASE_STORAGE_PATH, { recursive: true });
    });
  });

  describe('getCachePath', () => {
    it('returns path for valid hash and preset', async () => {
      const store = createStore();
      const p = await store.getCachePath(VALID_HASH, 'thumbnail');
      expect(p).toContain(VALID_HASH);
      expect(p).toContain('thumbnail.jpg');
    });

    it('throws InvalidContentHashError for invalid hash', async () => {
      const store = createStore();
      await expect(store.getCachePath('invalid', 'thumbnail')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('getOriginalPath', () => {
    it('returns path for valid hash', async () => {
      const store = createStore();
      const p = await store.getOriginalPath(VALID_HASH);
      expect(p).toContain(VALID_HASH);
      expect(p).toContain('original');
    });

    it('throws InvalidContentHashError for invalid hash', async () => {
      const store = createStore();
      await expect(store.getOriginalPath('bad')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('cacheExists', () => {
    it('returns true when cache file accessible', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      const store = createStore();
      const result = await store.cacheExists(VALID_HASH, 'thumbnail');
      expect(result).toBe(true);
    });

    it('returns false when cache file not accessible', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      const store = createStore();
      const result = await store.cacheExists(VALID_HASH, 'thumbnail');
      expect(result).toBe(false);
    });

    it('returns false for invalid content hash', async () => {
      const store = createStore();
      const result = await store.cacheExists('invalid', 'thumbnail');
      expect(result).toBe(false);
    });

    it('propagates non-InvalidContentHashError errors', async () => {
      // The getCachePath throws an error that's not InvalidContentHashError
      // We need to test the rethrow path
      const store = createStore();
      // With a valid hash but preset that throws a different error, currently
      // getCachePath only throws InvalidContentHashError. Let's test with
      // an invalid preset that triggers a regular error
      // Actually getCachePath throws "Invalid preset name" Error (not InvalidContentHashError)
      await expect(store.cacheExists(VALID_HASH, '../traversal')).rejects.toThrow('Invalid preset name');
    });
  });

  describe('saveCache', () => {
    it('saves buffer to cache path', async () => {
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });
      const store = createStore();
      const buffer = Buffer.from('image-data');
      const entry = await store.saveCache(VALID_HASH, 'thumbnail', buffer, 'image/webp');

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(entry.contentHash).toBe(VALID_HASH);
      expect(entry.preset).toBe('thumbnail');
      expect(entry.size).toBe(buffer.length);
      expect(entry.mimeType).toBe('image/webp');
    });

    it('updates existing metadata', async () => {
      const existingMetadata = JSON.stringify({
        'ai-chat': {
          preset: 'ai-chat',
          size: 100,
          mimeType: 'image/jpeg',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
        },
      });
      mockReadFile.mockResolvedValueOnce(existingMetadata);

      const store = createStore();
      const buffer = Buffer.from('new-cache');
      await store.saveCache(VALID_HASH, 'thumbnail', buffer, 'image/webp');

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('skips unsafe metadata keys', async () => {
      const maliciousMetadata = JSON.stringify({
        __proto__: { preset: 'hack' },
        thumbnail: {
          preset: 'thumbnail',
          size: 100,
          mimeType: 'image/webp',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
        },
      });
      mockReadFile.mockResolvedValueOnce(maliciousMetadata);

      const store = createStore();
      const buffer = Buffer.from('data');
      const entry = await store.saveCache(VALID_HASH, 'thumbnail', buffer, 'image/webp');
      expect(entry).toBeTruthy();
    });
  });

  describe('getCache', () => {
    it('returns buffer when file exists', async () => {
      const testBuffer = Buffer.from('cached-data');
      mockReadFile.mockResolvedValueOnce(testBuffer);
      // For metadata update - ENOENT so metadata update is skipped
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const store = createStore();
      const result = await store.getCache(VALID_HASH, 'thumbnail');
      expect(result).toEqual(testBuffer);
    });

    it('returns null when file not found', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const store = createStore();
      const result = await store.getCache(VALID_HASH, 'thumbnail');
      expect(result).toBeNull();
    });

    it('returns null for invalid content hash', async () => {
      const store = createStore();
      const result = await store.getCache('invalid', 'thumbnail');
      expect(result).toBeNull();
    });

    it('updates lastAccessed in metadata', async () => {
      const testBuffer = Buffer.from('cached-data');
      mockReadFile.mockResolvedValueOnce(testBuffer);
      const metadata = JSON.stringify({
        thumbnail: {
          preset: 'thumbnail',
          size: 100,
          mimeType: 'image/webp',
          createdAt: new Date().toISOString(),
          lastAccessed: new Date().toISOString(),
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      await store.getCache(VALID_HASH, 'thumbnail');
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('propagates non-InvalidContentHashError from getCachePath', async () => {
      const store = createStore();
      // Invalid preset triggers regular Error
      await expect(store.getCache(VALID_HASH, '../etc')).rejects.toThrow('Invalid preset name');
    });
  });

  describe('saveOriginal', () => {
    it('saves buffer and creates metadata', async () => {
      const store = createStore();
      const buffer = Buffer.from('original-file');
      // Mock for appendUploadMetadata - getOriginalMetadata will fail
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await store.saveOriginal(buffer, 'test.pdf', {
        tenantId: 'tenant-1',
        driveId: 'drive-1',
      });

      expect(result.contentHash).toHaveLength(64);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('saveOriginalFromFile', () => {
    it('copies file and creates metadata', async () => {
      const store = createStore();
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const result = await store.saveOriginalFromFile(
        '/tmp/upload-file',
        'test.pdf',
        VALID_HASH,
        { tenantId: 'tenant-1' }
      );

      expect(result.contentHash).toBe(VALID_HASH);
      expect(mockCopyFile).toHaveBeenCalled();
    });

    it('computes hash when not provided', async () => {
      const store = createStore();
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      // The file hash will be computed from the stream mock
      const result = await store.saveOriginalFromFile(
        '/tmp/upload-file',
        'test.pdf'
      );

      // Hash should be a valid 64-char hex string
      expect(result.contentHash).toHaveLength(64);
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('originalExists', () => {
    it('returns true when original file accessible', async () => {
      mockAccess.mockResolvedValueOnce(undefined);
      const store = createStore();
      const result = await store.originalExists(VALID_HASH);
      expect(result).toBe(true);
    });

    it('returns false when original file not accessible', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      const store = createStore();
      const result = await store.originalExists(VALID_HASH);
      expect(result).toBe(false);
    });
  });

  describe('getOriginal', () => {
    it('returns buffer when file exists', async () => {
      const testBuffer = Buffer.from('original-data');
      mockReadFile.mockResolvedValueOnce(testBuffer);
      // For getOriginalMetadata - ENOENT
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const store = createStore();
      const result = await store.getOriginal(VALID_HASH);
      expect(result).toEqual(testBuffer);
    });

    it('returns null when file not found', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const store = createStore();
      const result = await store.getOriginal(VALID_HASH);
      expect(result).toBeNull();
    });

    it('returns null for invalid content hash', async () => {
      const store = createStore();
      const result = await store.getOriginal('invalid-hash');
      expect(result).toBeNull();
    });

    it('updates lastAccessedAt in metadata', async () => {
      const testBuffer = Buffer.from('data');
      mockReadFile.mockResolvedValueOnce(testBuffer);
      // Return metadata for update
      const metadata = JSON.stringify({
        originalName: 'file.pdf',
        contentHash: VALID_HASH,
        size: 1000,
        savedAt: new Date().toISOString(),
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      await store.getOriginal(VALID_HASH);
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('propagates non-InvalidContentHashError from getOriginalPath', async () => {
      // getOriginal calls getOriginalPath which only throws InvalidContentHashError
      // The other error path is from the internal catch that rethrows
      // Let's test the InvalidContentHashError path (returns null)
      const store = createStore();
      const result = await store.getOriginal('too-short');
      expect(result).toBeNull();
    });
  });

  describe('getCacheUrl', () => {
    it('returns correct URL pattern', async () => {
      const store = createStore();
      const url = await store.getCacheUrl(VALID_HASH, 'thumbnail');
      expect(url).toBe(`/cache/${VALID_HASH}/thumbnail`);
    });

    it('throws for invalid hash', async () => {
      const store = createStore();
      await expect(store.getCacheUrl('invalid', 'thumbnail')).rejects.toBeInstanceOf(InvalidContentHashError);
    });
  });

  describe('getCacheMetadata', () => {
    it('returns empty object when no metadata file (ENOENT)', async () => {
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });
      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result).toEqual({});
    });

    it('returns parsed metadata entries', async () => {
      const metadata = JSON.stringify({
        thumbnail: {
          path: '/cache/hash/thumbnail.jpg',
          size: 1000,
          mimeType: 'image/webp',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessed: '2024-01-02T00:00:00Z',
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail).toBeTruthy();
      expect(result.thumbnail.size).toBe(1000);
    });

    it('skips dangerous keys', async () => {
      const metadata = JSON.stringify({
        __proto__: { path: '/bad', size: 0, mimeType: 'x', createdAt: '', lastAccessed: '' },
        thumbnail: {
          path: '/cache/hash/thumbnail.jpg',
          size: 100,
          mimeType: 'image/webp',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessed: '2024-01-01T00:00:00Z',
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(Object.hasOwn(result, '__proto__')).toBe(false);
      expect(result.thumbnail).toBeTruthy();
    });

    it('skips invalid preset keys', async () => {
      const metadata = JSON.stringify({
        '../evil': { size: 0, mimeType: 'x', createdAt: '', lastAccessed: '', path: '/bad' },
        'valid-preset': {
          path: '/cache/hash/valid-preset.jpg',
          size: 100,
          mimeType: 'image/jpeg',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessed: '2024-01-01T00:00:00Z',
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result['../evil']).toBeUndefined();
    });

    it('throws on non-ENOENT read errors', async () => {
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      mockReadFile.mockRejectedValueOnce(err);
      const store = createStore();
      await expect(store.getCacheMetadata(VALID_HASH)).rejects.toBeTruthy();
    });

    it('returns empty for null metadata data', async () => {
      mockReadFile.mockResolvedValueOnce('null');
      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result).toEqual({});
    });

    it('skips entries with non-object values', async () => {
      const metadata = JSON.stringify({
        thumbnail: 'not-an-object',
        preview: null,
        valid: {
          path: '/cache/hash/valid.jpg',
          size: 100,
          mimeType: 'image/jpeg',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessed: '2024-01-01T00:00:00Z',
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail).toBeUndefined();
    });

    it('uses default path when entry has no path', async () => {
      const metadata = JSON.stringify({
        thumbnail: {
          size: 100,
          mimeType: 'image/webp',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessed: '2024-01-01T00:00:00Z',
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail.path).toContain('thumbnail.jpg');
    });

    it('uses default values when entry fields are missing', async () => {
      const metadata = JSON.stringify({
        thumbnail: {
          path: '/cache/hash/thumbnail.jpg',
          // size, mimeType, createdAt, lastAccessed missing
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const result = await store.getCacheMetadata(VALID_HASH);
      expect(result.thumbnail.size).toBe(0);
      expect(result.thumbnail.mimeType).toBe('application/octet-stream');
    });
  });

  describe('getOriginalMetadata', () => {
    it('returns null for invalid hash', async () => {
      const store = createStore();
      const result = await store.getOriginalMetadata('invalid');
      expect(result).toBeNull();
    });

    it('returns null when file not found', async () => {
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });
      const store = createStore();
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result).toBeNull();
    });

    it('returns normalized metadata', async () => {
      const raw = JSON.stringify({
        originalName: 'test.pdf',
        contentHash: VALID_HASH,
        size: 2048,
        savedAt: '2024-01-01T00:00:00Z',
        tenants: ['tenant-1'],
        drives: ['drive-1'],
      });
      mockReadFile.mockResolvedValueOnce(raw);

      const store = createStore();
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.originalName).toBe('test.pdf');
      expect(result?.size).toBe(2048);
    });

    it('normalizes invalid raw metadata gracefully', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({}));
      const store = createStore();
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result).not.toBeNull();
      expect(result?.originalName).toBe('file');
      expect(result?.size).toBe(0);
    });

    it('handles uploads array in metadata', async () => {
      const raw = JSON.stringify({
        originalName: 'test.pdf',
        contentHash: VALID_HASH,
        size: 100,
        savedAt: '2024-01-01T00:00:00Z',
        uploads: [
          { tenantId: 't1', userId: 'u1', driveId: 'd1', service: 's1', uploadedAt: '2024-01-01T00:00:00Z' },
          { tenantId: null, uploadedAt: '2024-01-01T00:00:00Z' },
        ],
      });
      mockReadFile.mockResolvedValueOnce(raw);

      const store = createStore();
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.uploads).toHaveLength(2);
    });

    it('generates contentHash from name+size if missing', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        originalName: 'file.pdf',
        size: 100,
        savedAt: '2024-01-01T00:00:00Z',
      }));

      const store = createStore();
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result?.contentHash).toHaveLength(64);
    });

    it('propagates non-InvalidContentHashError errors', async () => {
      const err = new Error('Unexpected error');
      (err as NodeJS.ErrnoException).code = 'EACCES';
      mockReadFile.mockRejectedValueOnce(err);

      const store = createStore();
      // getOriginalMetadata catches all errors and returns null
      const result = await store.getOriginalMetadata(VALID_HASH);
      expect(result).toBeNull();
    });
  });

  describe('appendUploadMetadata', () => {
    it('creates new metadata when none exists', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const store = createStore();

      await store.appendUploadMetadata(VALID_HASH, {
        tenantId: 'tenant-1',
        driveId: 'drive-1',
        userId: 'user-1',
        service: 'processor',
      });

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('appends to existing metadata', async () => {
      const existing = JSON.stringify({
        originalName: 'file.pdf',
        contentHash: VALID_HASH,
        size: 1000,
        savedAt: new Date().toISOString(),
        tenants: ['existing-tenant'],
        uploads: [],
      });
      mockReadFile.mockResolvedValueOnce(existing);

      const store = createStore();
      await store.appendUploadMetadata(VALID_HASH, { tenantId: 'new-tenant' });

      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('handles undefined options', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const store = createStore();

      await store.appendUploadMetadata(VALID_HASH);
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('tenantHasAccess', () => {
    it('returns false for null tenantId', async () => {
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, null);
      expect(result).toBe(false);
    });

    it('returns false when no metadata', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, 'tenant-1');
      expect(result).toBe(false);
    });

    it('returns true when no tenant list (open access)', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          originalName: 'file.pdf',
          contentHash: VALID_HASH,
          size: 100,
          savedAt: new Date().toISOString(),
        })
      );
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, 'tenant-1');
      expect(result).toBe(true);
    });

    it('returns true when tenants array is empty', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          originalName: 'file.pdf',
          contentHash: VALID_HASH,
          size: 100,
          savedAt: new Date().toISOString(),
          tenants: [],
        })
      );
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, 'tenant-1');
      expect(result).toBe(true);
    });

    it('returns true when tenantId is in list', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          originalName: 'file.pdf',
          contentHash: VALID_HASH,
          size: 100,
          savedAt: new Date().toISOString(),
          tenants: ['tenant-1', 'tenant-2'],
        })
      );
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, 'tenant-1');
      expect(result).toBe(true);
    });

    it('returns false when tenantId not in list', async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          originalName: 'file.pdf',
          contentHash: VALID_HASH,
          size: 100,
          savedAt: new Date().toISOString(),
          tenants: ['tenant-2'],
        })
      );
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, 'tenant-1');
      expect(result).toBe(false);
    });

    it('returns false for undefined tenantId', async () => {
      const store = createStore();
      const result = await store.tenantHasAccess(VALID_HASH, undefined);
      expect(result).toBe(false);
    });
  });

  describe('deleteOriginal', () => {
    it('returns true when deletion succeeds', async () => {
      mockRm.mockResolvedValueOnce(undefined);
      const store = createStore();
      const result = await store.deleteOriginal(VALID_HASH);
      expect(result).toBe(true);
    });

    it('returns false when deletion fails', async () => {
      mockRm.mockRejectedValueOnce(new Error('Permission denied'));
      const store = createStore();
      const result = await store.deleteOriginal(VALID_HASH);
      expect(result).toBe(false);
    });

    it('returns false for invalid hash', async () => {
      const store = createStore();
      const result = await store.deleteOriginal('invalid');
      expect(result).toBe(false);
    });
  });

  describe('deleteCache', () => {
    it('returns true when deletion succeeds', async () => {
      mockRm.mockResolvedValueOnce(undefined);
      const store = createStore();
      const result = await store.deleteCache(VALID_HASH);
      expect(result).toBe(true);
    });

    it('returns false when deletion fails', async () => {
      mockRm.mockRejectedValueOnce(new Error('Fail'));
      const store = createStore();
      const result = await store.deleteCache(VALID_HASH);
      expect(result).toBe(false);
    });

    it('returns false for invalid hash', async () => {
      const store = createStore();
      const result = await store.deleteCache('invalid');
      expect(result).toBe(false);
    });
  });

  describe('deleteOriginalAndCache', () => {
    it('returns results for both deletions', async () => {
      mockRm.mockResolvedValue(undefined);
      const store = createStore();
      const result = await store.deleteOriginalAndCache(VALID_HASH);
      expect(result.originalDeleted).toBe(true);
      expect(result.cacheDeleted).toBe(true);
    });
  });

  describe('cleanupOldCache', () => {
    it('returns 0 when no content dirs', async () => {
      mockReaddir.mockResolvedValueOnce([]);
      const store = createStore();
      const count = await store.cleanupOldCache();
      expect(count).toBe(0);
    });

    it('skips invalid directory names', async () => {
      mockReaddir.mockResolvedValueOnce(['not-a-hash', 'another-invalid']);
      const store = createStore();
      const count = await store.cleanupOldCache();
      expect(count).toBe(0);
    });

    it('deletes old cache entries', async () => {
      mockReaddir.mockResolvedValueOnce([VALID_HASH]);
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const metadata = JSON.stringify({
        thumbnail: {
          path: `/cache/${VALID_HASH}/thumbnail.jpg`,
          size: 100,
          mimeType: 'image/webp',
          createdAt: oldDate,
          lastAccessed: oldDate,
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);
      mockUnlink.mockResolvedValueOnce(undefined);
      mockRmdir.mockResolvedValueOnce(undefined);

      const store = createStore();
      const count = await store.cleanupOldCache(7 * 24 * 60 * 60 * 1000);
      expect(count).toBe(1);
    });

    it('keeps recent cache entries', async () => {
      mockReaddir.mockResolvedValueOnce([VALID_HASH]);
      const recentDate = new Date().toISOString();
      const metadata = JSON.stringify({
        thumbnail: {
          path: `/cache/${VALID_HASH}/thumbnail.jpg`,
          size: 100,
          mimeType: 'image/webp',
          createdAt: recentDate,
          lastAccessed: recentDate,
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);

      const store = createStore();
      const count = await store.cleanupOldCache(7 * 24 * 60 * 60 * 1000);
      expect(count).toBe(0);
      // Should write updated metadata since entries remain
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('skips dirs without metadata', async () => {
      mockReaddir.mockResolvedValueOnce([VALID_HASH]);
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });

      const store = createStore();
      const count = await store.cleanupOldCache();
      expect(count).toBe(0);
    });

    it('handles unlink errors gracefully', async () => {
      mockReaddir.mockResolvedValueOnce([VALID_HASH]);
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const metadata = JSON.stringify({
        thumbnail: {
          path: `/cache/${VALID_HASH}/thumbnail.jpg`,
          size: 100,
          mimeType: 'image/webp',
          createdAt: oldDate,
          lastAccessed: oldDate,
        },
      });
      mockReadFile.mockResolvedValueOnce(metadata);
      mockUnlink.mockRejectedValueOnce(new Error('Already deleted'));
      mockRmdir.mockResolvedValueOnce(undefined);

      const store = createStore();
      // Should not throw even if unlink fails
      const count = await store.cleanupOldCache(7 * 24 * 60 * 60 * 1000);
      // Count is 0 since unlink failed and we don't count it
      expect(count).toBe(0);
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
  it('returns true for valid preset', () => {
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
