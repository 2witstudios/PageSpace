import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const VALID_HASH = 'a'.repeat(64);

// Mocks
const mockGetOriginal = vi.fn();
const mockGetCache = vi.fn();
const mockGetCacheMetadata = vi.fn();
const mockAssertFileAccess = vi.fn();
const mockAuthorizeFileAccess = vi.fn();
const mockIsValidContentHash = vi.fn();
const mockIsValidPreset = vi.fn();
const mockFilesQuery = vi.fn();
const mockPagesQuery = vi.fn();
const mockSanitizeFilename = vi.fn((f: string) => f || 'file');
const mockIsDangerousMimeType = vi.fn().mockReturnValue(false);

vi.mock('../../server', () => ({
  contentStore: {
    getOriginal: (...args: unknown[]) => mockGetOriginal(...args),
    getCache: (...args: unknown[]) => mockGetCache(...args),
    getCacheMetadata: (...args: unknown[]) => mockGetCacheMetadata(...args),
  },
}));

vi.mock('../../services/authorization', () => ({
  assertFileAccess: (...args: unknown[]) => mockAssertFileAccess(...args),
  authorizeFileAccess: (...args: unknown[]) => mockAuthorizeFileAccess(...args),
}));

vi.mock('../../cache/content-store', () => ({
  isValidContentHash: (...args: unknown[]) => mockIsValidContentHash(...args),
  isValidPreset: (...args: unknown[]) => mockIsValidPreset(...args),
  InvalidContentHashError: class InvalidContentHashError extends Error {
    constructor(hash: string) {
      super('Invalid content hash format');
      this.name = 'InvalidContentHashError';
    }
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      files: {
        findFirst: (...args: unknown[]) => mockFilesQuery(...args),
      },
      pages: {
        findFirst: (...args: unknown[]) => mockPagesQuery(...args),
      },
    },
  },
  files: { id: 'files.id' },
  pages: { id: 'pages.id' },
  eq: vi.fn((field: string, value: string) => ({ field, value, op: 'eq' })),
}));

vi.mock('../../utils/security', () => ({
  sanitizeFilename: (...args: unknown[]) => mockSanitizeFilename(...args as [string]),
  isDangerousMimeType: (...args: unknown[]) => mockIsDangerousMimeType(...args),
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitRead: (req: Request, res: Response, next: NextFunction) => next(),
}));

import { cacheRouter } from '../serve';

type MockAuth = {
  userId?: string;
  resourceBinding?: { type: string; id: string };
};

function createApp(auth?: MockAuth): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    next();
  });
  app.use('/files', cacheRouter);
  return app;
}

describe('GET /files/:contentHash/original', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockIsValidPreset.mockReturnValue(true);
    mockAuthorizeFileAccess.mockResolvedValue({ allowed: true, context: { pageId: 'page-1' } });
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockGetOriginal.mockResolvedValue(Buffer.from('file-data'));
    mockFilesQuery.mockResolvedValue({ sizeBytes: 1024, mimeType: 'application/pdf' });
    mockPagesQuery.mockResolvedValue({ originalFileName: 'test.pdf', title: 'Test', mimeType: 'application/pdf' });
    mockSanitizeFilename.mockReturnValue('test.pdf');
    mockIsDangerousMimeType.mockReturnValue(false);
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid content hash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get('/files/invalid-hash/original');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });

  it('returns 403 when access denied (decision)', async () => {
    mockAuthorizeFileAccess.mockResolvedValue({ allowed: false });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(403);
  });

  it('returns 403 when authorizeFileAccess throws', async () => {
    mockAuthorizeFileAccess.mockRejectedValue(new Error('Auth error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(403);
  });

  it('returns 404 when original not found', async () => {
    mockGetOriginal.mockResolvedValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Original file not found');
  });

  it('returns file with correct headers', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
    expect(response.headers['x-content-hash']).toBe(VALID_HASH);
    expect(response.headers['cache-control']).toContain('max-age=31536000');
  });

  it('forces download for dangerous MIME type', async () => {
    mockIsDangerousMimeType.mockReturnValue(true);
    mockFilesQuery.mockResolvedValue({ sizeBytes: 100, mimeType: 'text/html' });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-security-policy']).toContain("sandbox");
  });

  it('uses inline disposition for safe MIME type', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('inline');
  });

  it('handles missing file record gracefully', async () => {
    mockFilesQuery.mockResolvedValue(null);
    mockPagesQuery.mockResolvedValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
  });

  it('uses title from page when no originalFileName', async () => {
    mockFilesQuery.mockResolvedValue({ sizeBytes: 100, mimeType: null });
    mockPagesQuery.mockResolvedValue({ originalFileName: null, title: 'My Page Title', mimeType: 'application/pdf' });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
    expect(mockSanitizeFilename).toHaveBeenCalledWith('My Page Title');
  });

  it('uses page mimeType when file record lacks it', async () => {
    mockFilesQuery.mockResolvedValue({ sizeBytes: 100, mimeType: null });
    mockPagesQuery.mockResolvedValue({ originalFileName: 'file.pdf', title: null, mimeType: 'application/pdf' });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
  });

  it('returns 500 for unexpected errors', async () => {
    mockGetOriginal.mockRejectedValue(new Error('Storage error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(500);
  });

  it('handles decision context without pageId', async () => {
    mockAuthorizeFileAccess.mockResolvedValue({ allowed: true, context: {} });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(200);
  });

  it('returns 400 when InvalidContentHashError is thrown during getOriginal (lines 163-165)', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockGetOriginal.mockRejectedValue(new InvalidContentHashError('bad'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/original`);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});

describe('GET /files/:contentHash/:preset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockIsValidPreset.mockReturnValue(true);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockGetCache.mockResolvedValue(Buffer.from('cached-data'));
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid content hash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get('/files/bad-hash/thumbnail');
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid preset', async () => {
    mockIsValidPreset.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/invalid!preset`);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid preset name');
  });

  it('returns 403 when access denied', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('No access'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(403);
  });

  it('returns 404 when cache not found', async () => {
    mockGetCache.mockResolvedValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(404);
    expect(response.body.error).toContain('File not found');
  });

  it('returns cached file with JPEG content type', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
  });

  it('returns webp content type for .webp preset', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail.webp`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/webp');
  });

  it('returns png content type for .png preset', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/preview.png`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
  });

  it('returns text content type for extracted-text.txt', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/extracted-text.txt`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('returns text content type for ocr-text.txt', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/ocr-text.txt`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('returns 304 when client has cached version', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .get(`/files/${VALID_HASH}/thumbnail`)
      .set('if-none-match', `"${VALID_HASH}-thumbnail"`);
    expect(response.status).toBe(304);
  });

  it('returns 500 on unexpected error', async () => {
    mockGetCache.mockRejectedValue(new Error('Read error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(500);
  });

  it('returns 400 when InvalidContentHashError is thrown during cache retrieval (lines 239-240)', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockGetCache.mockRejectedValue(new InvalidContentHashError('bad'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/thumbnail`);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});

describe('GET /files/:contentHash/metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockGetCacheMetadata.mockResolvedValue({
      thumbnail: {
        preset: 'thumbnail',
        size: 1024,
        mimeType: 'image/webp',
        createdAt: new Date('2024-01-01'),
        lastAccessed: new Date('2024-01-02'),
      },
    });
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid hash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get('/files/bad/metadata');
    expect(response.status).toBe(400);
  });

  it('returns 403 when access denied', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('No access'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(403);
  });

  it('returns 404 when no metadata found', async () => {
    mockGetCacheMetadata.mockResolvedValue({});
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(404);
    expect(response.body.error).toContain('Metadata not found');
  });

  it('returns metadata with ISO date strings', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(200);
    expect(response.body.presets).toBeDefined();
    expect(response.body.presets.thumbnail).toBeDefined();
    expect(response.body.presets.thumbnail.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(response.body.presets.thumbnail.lastAccessed).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('handles non-Date values in metadata', async () => {
    mockGetCacheMetadata.mockResolvedValue({
      thumbnail: {
        preset: 'thumbnail',
        size: 1024,
        mimeType: 'image/webp',
        createdAt: '2024-01-01T00:00:00Z',
        lastAccessed: '2024-01-02T00:00:00Z',
      },
    });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(200);
    expect(response.body.presets.thumbnail.createdAt).toBeDefined();
  });

  it('returns 500 on unexpected error', async () => {
    mockGetCacheMetadata.mockRejectedValue(new Error('Storage error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(500);
  });

  it('returns 400 when InvalidContentHashError thrown during getCacheMetadata (lines 57-58)', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockGetCacheMetadata.mockRejectedValue(new InvalidContentHashError('bad-hash'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).get(`/files/${VALID_HASH}/metadata`);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});
