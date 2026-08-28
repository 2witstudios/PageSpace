import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockAddJob = vi.fn(async () => 'job-1');
vi.mock('../../server', () => ({
  queueManager: { addJob: (...args: unknown[]) => mockAddJob(...args) },
}));

const mockQuery = vi.fn(async () => ({ rowCount: 1 }));
vi.mock('../../db', () => ({
  getPoolForWorker: () => ({
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  }),
}));

// `tar` extraction itself is not under test here — it's stubbed to succeed
// immediately so these tests exercise the ceiling/enqueue logic that runs
// AFTER extraction, not the real decompression.
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null) => void,
  ) => cb(null),
}));

let extractedBytes = 1024;
vi.mock('../app-build-size', () => ({
  getDirectorySize: async () => extractedBytes,
}));

let buildRoot: string;

function createApp(): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = { userId: 'user-1' } as unknown as typeof req.auth;
    next();
  });
  app.use('/api/app-hosting', appBuildRouter);
  return app;
}

// Imported after the mocks above so the router picks up the mocked deps.
let appBuildRouter: express.Router;

beforeEach(async () => {
  vi.clearAllMocks();
  extractedBytes = 1024;
  buildRoot = mkdtempSync(path.join(tmpdir(), 'app-build-test-'));
  process.env.APP_BUILD_SOURCE_ROOT = buildRoot;
  vi.resetModules();
  ({ appBuildRouter } = await import('../app-build'));
});

afterEach(() => {
  rmSync(buildRoot, { recursive: true, force: true });
  delete process.env.APP_BUILD_SOURCE_ROOT;
});

describe('POST /api/app-hosting/build — extraction ceiling', () => {
  it('given an extracted tree over the ceiling, deletes it and answers 507, never enqueueing a build', async () => {
    extractedBytes = 3 * 1024 * 1024 * 1024; // over the 2GB interim cap

    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'abc123')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(507);
    expect(mockAddJob).not.toHaveBeenCalled();

    // The destDir this run created is `<buildRoot>/abc123/<timestamp>` (the
    // sourceRef) — it must not survive an over-ceiling refusal, even though
    // the empty `abc123` scaffold directory above it is harmless to leave.
    const publishedAppDir = path.join(buildRoot, 'abc123');
    expect(readdirSync(publishedAppDir)).toHaveLength(0);
  });

  it('given an extracted tree under the ceiling, enqueues the build and answers 200', async () => {
    extractedBytes = 1024;

    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'abc123')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(200);
    expect(mockAddJob).toHaveBeenCalledWith(
      'app-build',
      expect.objectContaining({ publishedAppId: 'abc123' }),
      { singletonKey: 'app-build:abc123' },
    );
  });
});
