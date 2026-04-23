import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const VALID_HASH = 'a'.repeat(64);

// Mocks
const mockAddJob = vi.fn().mockResolvedValue('job-id-1');
const mockGetPageForIngestion = vi.fn();
const mockAssertFileAccess = vi.fn();
const mockIsValidContentHash = vi.fn();

vi.mock('../../server', () => ({
  queueManager: {
    addJob: (...args: unknown[]) => mockAddJob(...args),
  },
}));

vi.mock('../../db', () => ({
  getPageForIngestion: (...args: unknown[]) => mockGetPageForIngestion(...args),
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

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    processor: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { ingestRouter } from '../ingest';

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
  app.use('/ingest', ingestRouter);
  return app;
}

describe('POST /ingest/by-page/:pageId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidContentHash.mockReturnValue(true);
    mockGetPageForIngestion.mockResolvedValue({
      id: 'page-1',
      contentHash: VALID_HASH,
      mimeType: 'application/pdf',
      originalFileName: 'test.pdf',
    });
    mockAssertFileAccess.mockResolvedValue({ allowed: true });
    mockAddJob.mockResolvedValue('job-id-1');
  });

  it('returns 401 when no auth', async () => {
    const app = createApp();
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Service authentication required' });
  });

  it('returns 403 when page binding mismatches', async () => {
    const app = createApp({
      userId: 'user-1',
      resourceBinding: { type: 'page', id: 'other-page' },
    });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('bound to a different page');
  });

  it('returns 404 when page not found', async () => {
    mockGetPageForIngestion.mockResolvedValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Page not found' });
  });

  it('returns 400 when page missing contentHash', async () => {
    mockGetPageForIngestion.mockResolvedValue({
      id: 'page-1',
      contentHash: null,
      mimeType: 'application/pdf',
      originalFileName: 'test.pdf',
    });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('contentHash');
  });

  it('returns 400 when contentHash is invalid', async () => {
    mockIsValidContentHash.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('invalid');
  });

  it('returns 403 when assertFileAccess throws', async () => {
    mockAssertFileAccess.mockRejectedValue(new Error('Access denied'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Access denied');
  });

  it('returns 200 with jobId on success', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.jobId).toBe('job-id-1');
  });

  it('allows correct page binding', async () => {
    const app = createApp({
      userId: 'user-1',
      resourceBinding: { type: 'page', id: 'page-1' },
    });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(200);
  });

  it('uses default values for null mimeType and filename', async () => {
    mockGetPageForIngestion.mockResolvedValue({
      id: 'page-1',
      contentHash: VALID_HASH,
      mimeType: null,
      originalFileName: null,
    });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(200);
    expect(mockAddJob).toHaveBeenCalledWith('ingest-file', expect.objectContaining({
      mimeType: 'application/octet-stream',
      originalName: 'file',
    }));
  });

  it('returns 500 on unexpected error', async () => {
    mockGetPageForIngestion.mockRejectedValue(new Error('DB connection failed'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Failed to enqueue ingestion');
  });

  it('returns 400 when InvalidContentHashError thrown', async () => {
    const { InvalidContentHashError } = await import('../../cache/content-store');
    mockGetPageForIngestion.mockRejectedValue(new InvalidContentHashError('bad-hash'));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/ingest/by-page/page-1');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid content hash');
  });
});
