import { describe, it, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { assert } from '../../__tests__/riteway';

const testCacheDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const dir = p.join(o.tmpdir(), `processor-chunk-test-${Date.now()}`);
  process.env.CACHE_PATH = dir;
  return dir;
});

vi.mock('../../server', () => ({
  contentStore: {
    originalExists: vi.fn(),
    appendUploadMetadata: vi.fn(),
    saveOriginalFromFile: vi.fn(),
  },
  queueManager: {
    addJob: vi.fn(),
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
});

afterAll(async () => {
  await fs.rm(testCacheDir, { recursive: true, force: true }).catch(() => {});
});

describe('chunked upload endpoint removal', () => {
  it('given POST /upload/chunk, should return 404 (route removed)', async () => {
    const res = await request(app).post('/upload/chunk');

    assert({
      given: 'POST /upload/chunk',
      should: 'return 404 because the chunk route was removed',
      actual: res.status,
      expected: 404,
    });
  });
});
