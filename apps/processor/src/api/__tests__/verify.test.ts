import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { MAX_VERIFY_BYTES } from '../verify-core';

const VALID_HASH = 'a'.repeat(64);

const mockHeadOriginalSize = vi.fn();
const mockGetOriginal = vi.fn();
const mockDeleteOriginal = vi.fn();
const mockVerifyContentHash = vi.fn();
const mockDetectContentType = vi.fn();
const mockIsValidContentHash = vi.fn();

vi.mock('../../server', () => ({
  contentStore: {
    headOriginalSize: (...args: unknown[]) => mockHeadOriginalSize(...args),
    getOriginal: (...args: unknown[]) => mockGetOriginal(...args),
    deleteOriginal: (...args: unknown[]) => mockDeleteOriginal(...args),
  },
}));

vi.mock('../../cache/content-store', () => ({
  isValidContentHash: (...args: unknown[]) => mockIsValidContentHash(...args),
}));

vi.mock('../../services/processing-pipeline', () => ({
  verifyContentHash: (...args: unknown[]) => mockVerifyContentHash(...args),
  detectContentType: (...args: unknown[]) => mockDetectContentType(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    processor: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { verifyRouter } from '../verify';

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
  app.use('/verify', verifyRouter);
  return app;
}

const CONV_AUTH: MockAuth = { userId: 'user-1', resourceBinding: { type: 'conversation', id: 'conv-1' } };
const PAGE_AUTH: MockAuth = { userId: 'user-1', resourceBinding: { type: 'page', id: 'page-1' } };

describe('POST /verify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockHeadOriginalSize.mockResolvedValue(11);
    mockGetOriginal.mockResolvedValue(Buffer.from('hello world'));
    mockVerifyContentHash.mockReturnValue(true);
    mockDetectContentType.mockResolvedValue({ label: 'png', mimeType: 'image/png', score: 0.99, source: 'magika' });
    mockDeleteOriginal.mockResolvedValue(true);
  });

  it('returns 401 when no auth', async () => {
    const response = await request(createApp()).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(401);
  });

  it('returns 403 when the token has no page/conversation binding', async () => {
    const response = await request(createApp({ userId: 'user-1' })).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(403);
  });

  it('accepts a conversation-bound token', async () => {
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('accepts a page-bound token', async () => {
    const response = await request(createApp(PAGE_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('returns 400 for an invalid content hash and never touches storage', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: 'bad' });
    expect(response.status).toBe(400);
    expect(mockHeadOriginalSize).not.toHaveBeenCalled();
    expect(mockGetOriginal).not.toHaveBeenCalled();
  });

  it('returns the detected MIME and size on a hash match', async () => {
    mockDetectContentType.mockResolvedValue({ label: 'pdf', mimeType: 'application/pdf', score: 0.97, source: 'magika' });
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, detectedMime: 'application/pdf', detectedLabel: 'pdf', size: 11 });
  });

  it('deletes the object and returns a definitive ok:false on a hash mismatch', async () => {
    mockVerifyContentHash.mockReturnValue(false);
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(mockDeleteOriginal).toHaveBeenCalledWith(VALID_HASH);
    expect(mockDetectContentType).not.toHaveBeenCalled();
  });

  it('returns a definitive 200 object_not_found when the object is absent', async () => {
    mockHeadOriginalSize.mockResolvedValue(null);
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: false, reason: 'object_not_found' });
    expect(mockGetOriginal).not.toHaveBeenCalled();
  });

  it('returns a retryable 503 when the HEAD probe hits an infra error (not masked as not-found)', async () => {
    mockHeadOriginalSize.mockRejectedValue(new Error('connection reset'));
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, reason: 'storage_error' });
    expect(mockGetOriginal).not.toHaveBeenCalled();
  });

  it('rejects an oversize object with 413 before downloading it', async () => {
    mockHeadOriginalSize.mockResolvedValue(MAX_VERIFY_BYTES + 1);
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(413);
    expect(response.body.reason).toBe('object_too_large');
    expect(mockGetOriginal).not.toHaveBeenCalled();
  });

  it('returns 503 when the object is present at HEAD but unreadable at GET', async () => {
    mockHeadOriginalSize.mockResolvedValue(11);
    mockGetOriginal.mockResolvedValue(null);
    const response = await request(createApp(CONV_AUTH)).post('/verify').send({ contentHash: VALID_HASH });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false, reason: 'storage_error' });
  });
});
