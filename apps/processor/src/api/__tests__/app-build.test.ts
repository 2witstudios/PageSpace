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

const mockCheckRateLimit = vi.fn(async () => ({ allowed: true, attemptsRemaining: 9 }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
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
  mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
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

describe('POST /api/app-hosting/build — publishedAppId shape validation (path-injection defense)', () => {
  it('rejects a path-traversal attempt in the id header before touching the filesystem', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', '../../etc/passwd')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('rejects an id containing a path separator', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'abc/123')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(400);
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('accepts a real cuid2-shaped id', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'tz4a98xxat96iws9zmbrgj3a')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(200);
  });
});

describe('POST /api/app-hosting/build — upload rate limiting', () => {
  it('answers 429 with Retry-After when the caller has exceeded the upload rate limit', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfter: 42, attemptsRemaining: 0 });

    const app = createApp();
    const res = await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'abc123')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(mockAddJob).not.toHaveBeenCalled();
    // Rate limiting runs before the id-shape check and the DB existence
    // check — a caller flooding this endpoint must not get to spend a query
    // per rejected attempt.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keys the rate limit by the authenticated userId, not the claimed publishedAppId', async () => {
    const app = createApp();
    await request(app)
      .post('/api/app-hosting/build')
      .set('X-Published-App-Id', 'abc123')
      .send(Buffer.from('fake-tarball-bytes'));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('user-1'),
      expect.any(Object),
    );
  });

  it('the Express-level burst limiter itself engages after enough requests from one caller', async () => {
    const app = createApp();
    let sawTooManyRequests = false;
    // The configured limit is 20/min; a small buffer past that is enough to
    // prove the middleware is actually wired in front of the handler, not
    // just present in the import graph.
    for (let i = 0; i < 25; i++) {
      const res = await request(app)
        .post('/api/app-hosting/build')
        .set('X-Published-App-Id', 'abc123')
        .send(Buffer.from('fake-tarball-bytes'));
      if (res.status === 429) {
        sawTooManyRequests = true;
        break;
      }
    }
    expect(sawTooManyRequests).toBe(true);
  });
});
