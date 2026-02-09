import { describe, it, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { assert } from '../../__tests__/riteway';

const testCacheDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const dir = p.join(o.tmpdir(), `processor-dedupe-test-${Date.now()}`);
  process.env.CACHE_PATH = dir;
  return dir;
});

const mockOriginalExists = vi.fn();
const mockAppendUploadMetadata = vi.fn();
const mockSaveOriginalFromFile = vi.fn();
const mockAddJob = vi.fn();

vi.mock('../../server', () => ({
  contentStore: {
    originalExists: (...args: unknown[]) => mockOriginalExists(...args),
    appendUploadMetadata: (...args: unknown[]) => mockAppendUploadMetadata(...args),
    saveOriginalFromFile: (...args: unknown[]) => mockSaveOriginalFromFile(...args),
  },
  queueManager: {
    addJob: (...args: unknown[]) => mockAddJob(...args),
  },
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../middleware/auth', () => ({
  hasAuthScope: vi.fn(() => false),
}));

vi.mock('../../logger', () => ({
  processorLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/security', () => ({
  resolvePathWithin: (base: string, ...segments: string[]) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('path') as typeof import('path')).resolve(base, ...segments);
  },
  sanitizeExtension: (filename: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ext = (require('path') as typeof import('path')).extname(filename || '').toLowerCase();
    return ext || '.bin';
  },
}));

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { uploadRouter } from '../upload';

let app: express.Express;

beforeAll(async () => {
  await fs.mkdir(path.join(testCacheDir, 'temp-uploads'), { recursive: true });

  app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = {
      userId: 'user-1',
      driveId: 'drive-1',
      resourceBinding: { type: 'page' as const, id: 'page-1' },
      hasScope: () => true,
    } as unknown as typeof req.auth;
    next();
  });
  app.use('/upload', uploadRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
});

afterAll(async () => {
  await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upload dedupe response contract', () => {
  it('given a duplicate file, should return deduplicated: true with jobs as string[]', async () => {
    mockOriginalExists.mockResolvedValue(true);
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockAddJob.mockResolvedValue('job-123');

    const tmpFile = path.join(testCacheDir, 'test-upload.txt');
    await fs.writeFile(tmpFile, 'hello world');

    try {
      const res = await request(app)
        .post('/upload/single')
        .field('driveId', 'drive-1')
        .field('pageId', 'page-1')
        .attach('file', tmpFile);

      assert({
        given: 'a duplicate file upload',
        should: 'return success true',
        actual: res.body.success,
        expected: true,
      });

      assert({
        given: 'a duplicate file upload',
        should: 'return deduplicated true',
        actual: res.body.deduplicated,
        expected: true,
      });

      assert({
        given: 'the dedupe response jobs field',
        should: 'be an array of strings',
        actual: Array.isArray(res.body.jobs) && res.body.jobs.every((j: unknown) => typeof j === 'string'),
        expected: true,
      });

      assert({
        given: 'the dedupe response jobs field',
        should: 'contain the job id from queueManager.addJob',
        actual: res.body.jobs,
        expected: ['job-123'],
      });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});
