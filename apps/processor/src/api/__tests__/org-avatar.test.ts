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
  it('writes each upload as a NEW file in the org\'s own folder, named from its type and a fresh nonce (never the uploader\'s filename), and deletes nothing', async () => {
    const first = await request(createApp(boundTo('org_nw'), { mimetype: 'image/png' })).post('/org-avatar/org_nw');
    const second = await request(createApp(boundTo('org_nw'), { mimetype: 'image/png' })).post('/org-avatar/org_nw');
    expect(first.status).toBe(200);
    expect(first.body.filename).toMatch(/^avatar-[a-z0-9]{1,32}\.png$/);
    expect(second.body.filename).not.toBe(first.body.filename);
    expect(commands('PutObject').map((c) => c.input)).toEqual([
      expect.objectContaining({ Key: `org-avatars/org_nw/${first.body.filename}`, ContentType: 'image/png' }),
      expect.objectContaining({ Key: `org-avatars/org_nw/${second.body.filename}`, ContentType: 'image/png' }),
    ]);
    // The old file goes only once the org points at the new one (the web route deletes it by name).
    expect(commands('DeleteObjects')).toEqual([]);
  });

  it('deletes exactly the one named file, and refuses a name that is not an org avatar file', async () => {
    const res = await request(createApp(boundTo('org_nw'))).delete('/org-avatar/org_nw/avatar-old123.png');
    expect(res.status).toBe(200);
    expect(commands('DeleteObjects')[0].input).toMatchObject({ Delete: { Objects: [{ Key: 'org-avatars/org_nw/avatar-old123.png' }] } });
    expect(commands('ListObjectsV2')).toEqual([]);
    for (const name of ['..%2F..%2Favatars%2Fu1%2Favatar.png', 'avatar.svg', 'other.png']) {
      expect((await request(createApp(boundTo('org_nw'))).delete(`/org-avatar/org_nw/${name}`)).status).toBe(400);
    }
    expect((await request(createApp(boundTo('org_other'))).delete('/org-avatar/org_nw/avatar-old123.png')).status).toBe(403);
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

  it('on org deletion, removes every object in the org\'s avatar folder and nothing outside it', async () => {
    const res = await request(createApp(boundTo('org_nw'))).delete('/org-avatar/org_nw');
    expect(res.status).toBe(200);
    expect(commands('ListObjectsV2')[0].input).toMatchObject({ Prefix: 'org-avatars/org_nw/' });
    expect(commands('DeleteObjects')[0].input).toMatchObject({ Delete: { Objects: [{ Key: 'org-avatars/org_nw/avatar.jpg' }] } });
  });
});
