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

import driveAvatarRouter from '../drive-avatar';

type MockAuth = { userId: string; resourceBinding?: { type: string; id: string } };

function createApp(auth?: MockAuth, file?: Partial<Express.Multer.File>): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    if (file) req.file = { mimetype: 'image/png', buffer: Buffer.from('png'), size: 3, originalname: 'evil.svg', ...file } as Express.Multer.File;
    next();
  });
  app.use('/drive-avatar', driveAvatarRouter);
  return app;
}

const boundTo = (driveId: string): MockAuth => ({ userId: 'u_admin', resourceBinding: { type: 'drive', id: driveId } });
const commands = (tag: string) =>
  mockS3Send.mock.calls.map(([command]) => command as { _tag: string; input: Record<string, unknown> }).filter((c) => c._tag === tag);

beforeEach(() => {
  vi.clearAllMocks();
  mockS3Send.mockImplementation(async (command: { _tag: string }) => {
    if (command._tag === 'ListObjectsV2') return { Contents: [{ Key: 'drive-avatars/drv_1/avatar-a1.jpg' }] };
    return {};
  });
});

describe('the processor stores a drive avatar only for a token bound to that drive', () => {
  it('writes each upload as a new file in the drive\'s own folder and deletes nothing', async () => {
    const res = await request(createApp(boundTo('drv_1'), { mimetype: 'image/webp' })).post('/drive-avatar/drv_1');
    expect(res.status).toBe(200);
    expect(res.body.filename).toMatch(/^avatar-[a-z0-9]{1,32}\.webp$/);
    expect(commands('PutObject')[0].input).toMatchObject({ Key: `drive-avatars/drv_1/${res.body.filename}`, ContentType: 'image/webp' });
    expect(commands('DeleteObjects')).toEqual([]);
  });

  it('deletes exactly the one named file, and refuses a name that is not an avatar file', async () => {
    expect((await request(createApp(boundTo('drv_1'))).delete('/drive-avatar/drv_1/avatar-old123.png')).status).toBe(200);
    expect(commands('DeleteObjects')[0].input).toMatchObject({ Delete: { Objects: [{ Key: 'drive-avatars/drv_1/avatar-old123.png' }] } });
    expect((await request(createApp(boundTo('drv_1'))).delete('/drive-avatar/drv_1/other.png')).status).toBe(400);
  });

  it('refuses a token bound to another drive, to an org with the same id, or to nothing, and writes nothing', async () => {
    for (const auth of [boundTo('drv_other'), { userId: 'u_admin', resourceBinding: { type: 'organization', id: 'drv_1' } }, { userId: 'u_admin' }]) {
      expect((await request(createApp(auth, {})).post('/drive-avatar/drv_1')).status).toBe(403);
      expect((await request(createApp(auth)).delete('/drive-avatar/drv_1')).status).toBe(403);
    }
    expect((await request(createApp(undefined, {})).post('/drive-avatar/drv_1')).status).toBe(401);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('refuses an SVG and a missing file', async () => {
    expect((await request(createApp(boundTo('drv_1'), { mimetype: 'image/svg+xml' })).post('/drive-avatar/drv_1')).status).toBe(400);
    expect((await request(createApp(boundTo('drv_1'))).post('/drive-avatar/drv_1')).status).toBe(400);
    expect(commands('PutObject')).toEqual([]);
  });

  it('empties only the drive\'s own folder', async () => {
    expect((await request(createApp(boundTo('drv_1'))).delete('/drive-avatar/drv_1')).status).toBe(200);
    expect(commands('ListObjectsV2')[0].input).toMatchObject({ Prefix: 'drive-avatars/drv_1/' });
  });
});
