import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const mockIsHashBlocked = vi.fn();
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({
  isHashBlocked: (...args: unknown[]) => mockIsHashBlocked(...args),
}));

const mockOriginalExists = vi.fn();
const mockSaveOriginal = vi.fn();
vi.mock('../../server', () => ({
  contentStore: {
    originalExists: (...args: unknown[]) => mockOriginalExists(...args),
    saveOriginal: (...args: unknown[]) => mockSaveOriginal(...args),
  },
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    security: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    processor: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

import { storeOriginalRouter, MAX_STORE_ORIGINAL_BYTES } from '../store-original';

type MockAuth = {
  userId?: string;
  driveId?: string;
  resourceBinding?: { type: string; id: string };
};

const PAGE_ID = 'page-new-1';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01, 0xfe]);
const HASH = crypto.createHash('sha256').update(BYTES).digest('hex');
const AUTH: MockAuth = { userId: 'u1', driveId: 'd1', resourceBinding: { type: 'page', id: PAGE_ID } };

function createApp(auth?: MockAuth): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    next();
  });
  app.use('/originals', storeOriginalRouter);
  return app;
}

function post(app: express.Express, { body = BYTES, hash = HASH, pageId = PAGE_ID, name }: { body?: Buffer; hash?: string; pageId?: string; name?: string } = {}) {
  const req = request(app)
    .post(`/originals/${pageId}`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Content-Hash', hash);
  if (name !== undefined) req.set('X-Original-Name', name);
  return req.send(body);
}

describe('POST /originals/:pageId — store original bytes through the processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHashBlocked.mockResolvedValue(false);
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginal.mockResolvedValue({ contentHash: HASH, path: `files/${HASH}/original` });
  });

  it('given bytes that hash to the declared hash, should store them via the content store (where at-rest encryption applies)', async () => {
    const res = await post(createApp(AUTH), { name: encodeURIComponent('scan résumé.pdf') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contentHash: HASH, size: BYTES.length, stored: true });
    expect(mockSaveOriginal).toHaveBeenCalledTimes(1);
    const [buffer, originalName, options] = mockSaveOriginal.mock.calls[0];
    expect(Buffer.compare(buffer as Buffer, BYTES)).toBe(0);
    expect(originalName).toBe('scan résumé.pdf');
    expect(options).toMatchObject({ userId: 'u1', driveId: 'd1', service: 'web' });
  });

  it('given bytes already stored under that hash, should not rewrite them', async () => {
    mockOriginalExists.mockResolvedValue(true);
    const res = await post(createApp(AUTH));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, contentHash: HASH, stored: false });
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given bytes that do not hash to the declared hash, should refuse 422 and store nothing', async () => {
    const res = await post(createApp(AUTH), { hash: 'b'.repeat(64) });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ ok: false, reason: 'hash_mismatch' });
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given a blocklisted hash, should refuse 410 and store nothing', async () => {
    mockIsHashBlocked.mockResolvedValue(true);
    const res = await post(createApp(AUTH));
    expect(res.status).toBe(410);
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given a malformed declared hash, should refuse 400', async () => {
    const res = await post(createApp(AUTH), { hash: 'not-a-hash' });
    expect(res.status).toBe(400);
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given an empty body, should refuse 400', async () => {
    const res = await post(createApp(AUTH), { body: Buffer.alloc(0), hash: crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex') });
    expect(res.status).toBe(400);
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given no auth, should refuse 401', async () => {
    const res = await post(createApp(undefined));
    expect(res.status).toBe(401);
  });

  it('given a token that is not page-bound, should refuse 403', async () => {
    const res = await post(createApp({ userId: 'u1', resourceBinding: { type: 'drive', id: 'd1' } }));
    expect(res.status).toBe(403);
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('given a token bound to a different page, should refuse 403', async () => {
    const res = await post(createApp(AUTH), { pageId: 'someone-elses-page' });
    expect(res.status).toBe(403);
    expect(mockSaveOriginal).not.toHaveBeenCalled();
  });

  it('caps the body at the largest per-file tier limit (1 GiB)', () => {
    expect(MAX_STORE_ORIGINAL_BYTES).toBe(1024 * 1024 * 1024);
  });
});
