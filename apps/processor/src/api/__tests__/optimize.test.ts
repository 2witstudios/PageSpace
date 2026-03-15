import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const VALID_HASH = 'a'.repeat(64);

// Mocks
const mockCacheExists = vi.fn();
const mockGetCacheUrl = vi.fn().mockResolvedValue('/cache/hash/ai-chat');
const mockGetCache = vi.fn();
const mockAddJob = vi.fn().mockResolvedValue('job-id-1');
const mockAssertFileAccess = vi.fn();
const mockIsValidContentHash = vi.fn();
const mockProcessImage = vi.fn();
const mockPrepareImageForAI = vi.fn();

vi.mock('../../server', () => ({
  contentStore: {
    cacheExists: (...args: unknown[]) => mockCacheExists(...args),
    getCacheUrl: (...args: unknown[]) => mockGetCacheUrl(...args),
    getCache: (...args: unknown[]) => mockGetCache(...args),
  },
  queueManager: {
    addJob: (...args: unknown[]) => mockAddJob(...args),
  },
}));

vi.mock('../../services/authorization', () => ({
  assertFileAccess: (...args: unknown[]) => mockAssertFileAccess(...args),
}));

vi.mock('../../cache/content-store', () => ({
  isValidContentHash: (...args: unknown[]) => mockIsValidContentHash(...args),
  InvalidContentHashError: class InvalidContentHashError extends Error {
    constructor(hash: string) {
      super('Invalid content hash format');
      this.name = 'InvalidContentHashError';
    }
  },
}));

vi.mock('../../workers/image-processor', () => ({
  processImage: (...args: unknown[]) => mockProcessImage(...args),
  prepareImageForAI: (...args: unknown[]) => mockPrepareImageForAI(...args),
}));

import { imageRouter } from '../optimize';

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
  app.use('/optimize', imageRouter);
  return app;
}

describe('POST /optimize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockCacheExists.mockResolvedValue(false);
    mockGetCacheUrl.mockResolvedValue(`/cache/${VALID_HASH}/ai-chat`);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockAddJob.mockResolvedValue('job-id-1');
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(401);
  });

  it('returns 400 when no contentHash', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/optimize').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('contentHash is required');
  });

  it('returns 400 for invalid contentHash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: 'invalid' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });

  it('returns 403 when access denied', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('Denied'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(403);
  });

  it('returns 400 for invalid preset', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'nonexistent-preset' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid preset');
    expect(response.body.validPresets).toBeDefined();
  });

  it('returns cached result when cache exists', async () => {
    mockCacheExists.mockResolvedValue(true);
    mockGetCacheUrl.mockResolvedValue('/cache/hash/ai-chat');
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat' });
    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(true);
    expect(response.body.url).toBe('/cache/hash/ai-chat');
    expect(response.body.status).toBe('completed');
  });

  it('queues job when not cached', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat' });
    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect(response.body.jobId).toBe('job-id-1');
    expect(response.body.status).toBe('queued');
    expect(response.body.checkUrl).toContain('job-id-1');
  });

  it('processes synchronously when waitForProcessing=true', async () => {
    mockProcessImage.mockResolvedValue({ url: '/cache/hash/ai-chat', size: 1000 });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat', waitForProcessing: true });
    expect(response.status).toBe(200);
    expect(response.body.cached).toBe(false);
    expect(response.body.status).toBe('completed');
    expect(response.body.url).toBe('/cache/hash/ai-chat');
  });

  it('returns 500 when synchronous processing fails', async () => {
    mockProcessImage.mockRejectedValue(new Error('Sharp failed'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat', waitForProcessing: true });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Processing failed');
    expect(response.body.message).toBe('Sharp failed');
  });

  it('returns 500 with unknown error message when not Error instance', async () => {
    mockProcessImage.mockRejectedValue('string error');
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat', waitForProcessing: true });
    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Unknown error');
  });

  it('returns 400 for InvalidContentHashError', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockAssertFileAccess.mockResolvedValue({});
    mockCacheExists.mockRejectedValue(new InvalidContentHashError('bad'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });

  it('uses default preset ai-chat when not specified', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(mockCacheExists).toHaveBeenCalledWith(VALID_HASH, 'ai-chat');
  });

  it('returns 500 for unexpected errors', async () => {
    mockCacheExists.mockRejectedValue(new Error('DB error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat' });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Optimization failed');
  });
});

describe('POST /optimize/batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockCacheExists.mockResolvedValue(false);
    mockGetCacheUrl.mockResolvedValue(`/cache/${VALID_HASH}/thumbnail`);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockAddJob.mockResolvedValue('job-id-batch');
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app).post('/optimize/batch').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(401);
  });

  it('returns 400 when no contentHash', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/optimize/batch').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('contentHash is required');
  });

  it('returns 400 when presets is not an array', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: 'thumbnail' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('array');
  });

  it('returns 400 when presets contains non-strings', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: [123, 'thumbnail'] });
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid contentHash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: 'bad', presets: ['thumbnail'] });
    expect(response.status).toBe(400);
  });

  it('returns 403 when access denied', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('Denied'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['thumbnail'] });
    expect(response.status).toBe(403);
  });

  it('returns batch results for valid presets', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['ai-chat', 'thumbnail'] });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.results).toBeDefined();
    expect(response.body.jobIds).toBeDefined();
  });

  it('skips invalid preset names in batch', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['thumbnail', 'invalid-preset', '__proto__'] });
    expect(response.status).toBe(200);
    // Only thumbnail should be in results (invalid-preset and __proto__ skipped)
    expect(response.body.results.thumbnail).toBeDefined();
    expect(response.body.results['invalid-preset']).toBeUndefined();
  });

  it('returns cached results for already cached presets', async () => {
    mockCacheExists.mockResolvedValue(true);
    mockGetCacheUrl.mockResolvedValue('/cache/hash/thumbnail');
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['thumbnail'] });
    expect(response.status).toBe(200);
    expect(response.body.results.thumbnail.cached).toBe(true);
    expect(response.body.results.thumbnail.status).toBe('completed');
  });

  it('uses default presets when not specified', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body.results['ai-chat']).toBeDefined();
    expect(response.body.results.thumbnail).toBeDefined();
  });

  it('returns 500 for unexpected errors', async () => {
    mockCacheExists.mockRejectedValue(new Error('Cache error'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['thumbnail'] });
    expect(response.status).toBe(500);
  });

  it('returns 400 when InvalidContentHashError thrown during batch processing (lines 178-179)', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockCacheExists.mockRejectedValue(new InvalidContentHashError('bad-hash'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/batch')
      .send({ contentHash: VALID_HASH, presets: ['thumbnail'] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});

describe('POST /optimize/prepare-for-ai', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockPrepareImageForAI.mockResolvedValue({ url: '/cache/hash/ai-chat', size: 1000 });
    mockGetCache.mockResolvedValue(Buffer.from('image-data'));
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(401);
  });

  it('returns 400 when no contentHash', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('contentHash is required');
  });

  it('returns 400 for invalid contentHash', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: 'invalid' });
    expect(response.status).toBe(400);
  });

  it('returns 403 when access denied', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('No access'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH });
    expect(response.status).toBe(403);
  });

  it('returns URL for providers that support URLs', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'openai' });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('url');
    expect(response.body.url).toBe('/cache/hash/ai-chat');
  });

  it('returns base64 when returnBase64 is true', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, returnBase64: true });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('base64');
    expect(response.body.data).toBeDefined();
  });

  it('returns base64 for providers that do not support URLs', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'ollama' });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('base64');
  });

  it('returns 404 when optimized image buffer not found for base64', async () => {
    mockGetCache.mockResolvedValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, returnBase64: true });
    expect(response.status).toBe(404);
    expect(response.body.error).toContain('not found');
  });

  it('returns 500 on unexpected error', async () => {
    mockPrepareImageForAI.mockRejectedValue(new Error('AI prep failed'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'openai' });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('AI preparation failed');
  });

  it('uses anthropic as URL-supporting provider', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'anthropic' });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('url');
  });

  it('uses google as URL-supporting provider', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'google' });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe('url');
  });

  it('returns 400 when InvalidContentHashError is thrown during prepare-for-ai processing (lines 243-244)', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockPrepareImageForAI.mockRejectedValue(new InvalidContentHashError('bad-hash'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize/prepare-for-ai')
      .send({ contentHash: VALID_HASH, provider: 'openai' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});

describe('POST /optimize - queueManager.addJob error path (lines 78-86)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockCacheExists.mockResolvedValue(false);
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
  });

  it('returns 500 when queueManager.addJob throws unexpectedly', async () => {
    mockAddJob.mockRejectedValue(new Error('Queue unavailable'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/optimize')
      .send({ contentHash: VALID_HASH, preset: 'ai-chat' });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Optimization failed');
    expect(response.body.message).toBe('Queue unavailable');
  });
});
