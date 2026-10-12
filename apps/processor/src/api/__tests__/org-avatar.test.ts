import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../logger', () => ({ processorLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => {
  const makeCommand = (tag: string) =>
    class { _tag = tag; input: unknown; constructor(i: unknown) { this.input = i; } };
  return {
    PutObjectCommand: makeCommand('PutObject'),
    ListObjectsV2Command: makeCommand('ListObjectsV2'),
    DeleteObjectsCommand: makeCommand('DeleteObjects'),
  };
});
vi.mock('../../s3-client', () => ({ createS3Client: () => ({ send: mockS3Send }), getS3Bucket: () => 'test-bucket' }));
vi.mock('multer', () => {
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  const multer = vi.fn().mockReturnValue({ single: vi.fn().mockReturnValue(passthrough) });
  (multer as unknown as Record<string, unknown>).memoryStorage = vi.fn().mockReturnValue({});
  return { default: multer };
});

import orgAvatarRouter from '../org-avatar';

type MockAuth = { userId: string; resourceBinding?: { type: string; id: string } };

function createApp(auth?: MockAuth, file?: Partial<Express.Multer.File>): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    if (file) req.file = { mimetype: 'image/png', buffer: Buffer.from('png'), size: 3, originalname: 'evil.svg', ...file } as Express.Multer.File;
    next();
  });
  app.use('/org-avatar', orgAvatarRouter);
  return app;
}

const boundTo = (orgId: string): MockAuth => ({ userId: 'u_admin', resourceBinding: { type: 'organization', id: orgId } });
const commands = (tag: string) =>
  mockS3Send.mock.calls.map(([command]) => command as { _tag: string; input: Record<string, unknown> }).filter((c) => c._tag === tag);

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockImplementation(async (command: { _tag: string }) => {
    if (command._tag === 'ListObjectsV2') return { Contents: [{ Key: 'org-avatars/org_nw/avatar.jpg' }] };
    return {};
  });
});

describe('ORG-1 (partial) the processor stores an org avatar only for a token bound to that org', () => {
  it('stores the image under the org\'s own folder, named from its type (never the uploader\'s filename), replacing the old one', async () => {
    const res = await request(createApp(boundTo('org_nw'), { mimetype: 'image/png' })).post('/org-avatar/org_nw');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ filename: 'avatar.png' });
    expect(commands('DeleteObjects')[0].input).toMatchObject({ Delete: { Objects: [{ Key: 'org-avatars/org_nw/avatar.jpg' }] } });
    expect(commands('PutObject')[0].input).toMatchObject({ Key: 'org-avatars/org_nw/avatar.png', ContentType: 'image/png' });
  });

  it('refuses a token bound to another org, to a user, or to nothing, and writes nothing', async () => {
    for (const auth of [boundTo('org_other'), { userId: 'u_admin', resourceBinding: { type: 'user', id: 'org_nw' } }, { userId: 'u_admin' }]) {
      expect((await request(createApp(auth, {})).post('/org-avatar/org_nw')).status).toBe(403);
      expect((await request(createApp(auth)).delete('/org-avatar/org_nw')).status).toBe(403);
    }
    expect((await request(createApp(undefined, {})).post('/org-avatar/org_nw')).status).toBe(401);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('refuses a type that is not a raster image (an SVG can carry script) and a missing file', async () => {
    expect((await request(createApp(boundTo('org_nw'), { mimetype: 'image/svg+xml' })).post('/org-avatar/org_nw')).status).toBe(400);
    expect((await request(createApp(boundTo('org_nw'))).post('/org-avatar/org_nw')).status).toBe(400);
    expect(commands('PutObject')).toEqual([]);
  });

  it('removes every object in the org\'s avatar folder and nothing outside it', async () => {
    const res = await request(createApp(boundTo('org_nw'))).delete('/org-avatar/org_nw');
    expect(res.status).toBe(200);
    expect(commands('ListObjectsV2')[0].input).toMatchObject({ Prefix: 'org-avatars/org_nw/' });
    expect(commands('DeleteObjects')[0].input).toMatchObject({ Delete: { Objects: [{ Key: 'org-avatars/org_nw/avatar.jpg' }] } });
  });
});
