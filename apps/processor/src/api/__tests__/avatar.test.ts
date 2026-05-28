import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Hoisted mocks
const {
  mockS3Send,
  mockNormalizeIdentifier,
  mockSanitizeExtension,
  mockHasAuthScope,
} = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockNormalizeIdentifier: vi.fn().mockImplementation((value: unknown) => {
    if (typeof value !== 'string' || !value) return null;
    return value;
  }),
  mockSanitizeExtension: vi.fn().mockReturnValue('.jpg'),
  mockHasAuthScope: vi.fn().mockReturnValue(false),
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (_req: Request, _res: Response, next: NextFunction) => next(),
  rateLimitRead: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../middleware/auth', () => ({
  hasAuthScope: (...args: unknown[]) => mockHasAuthScope(...args),
}));

vi.mock('../../utils/security', () => ({
  DEFAULT_IMAGE_EXTENSION: '.png',
  IDENTIFIER_PATTERN: /^[A-Za-z0-9_-]{3,64}$/,
  normalizeIdentifier: (...args: unknown[]) => mockNormalizeIdentifier(...args),
  sanitizeExtension: (...args: unknown[]) => mockSanitizeExtension(...args),
}));

vi.mock('../../logger', () => ({
  processorLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@aws-sdk/client-s3', () => {
  const makeCommand = (tag: string) =>
    class { _tag = tag; input: unknown; constructor(i: unknown) { this.input = i; } };
  return {
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
    PutObjectCommand: makeCommand('PutObject'),
    GetObjectCommand: makeCommand('GetObject'),
    ListObjectsV2Command: makeCommand('ListObjectsV2'),
    DeleteObjectsCommand: makeCommand('DeleteObjects'),
  };
});

vi.mock('../../s3-client', () => ({
  createS3Client: () => ({ send: mockS3Send }),
  getS3Bucket: () => 'test-bucket',
}));

vi.mock('multer', () => {
  const passthroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();
  const multerInstance = {
    single: vi.fn().mockReturnValue(passthroughMiddleware),
    memoryStorage: vi.fn().mockReturnValue({}),
  };
  const multer = vi.fn().mockReturnValue(multerInstance);
  (multer as unknown as Record<string, unknown>).memoryStorage = vi.fn().mockReturnValue({});
  return { default: multer };
});

import avatarRouter from '../avatar';

type MockAuth = {
  userId?: string;
  resourceBinding?: { type: string; id: string };
};

function createApp(auth?: MockAuth, file?: Express.Multer.File): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    if (file) req.file = file;
    next();
  });
  app.use('/avatar', avatarRouter);
  return app;
}

function createMockFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'avatar.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    destination: '',
    filename: 'avatar.jpg',
    path: '',
    size: 1024,
    buffer: Buffer.from('fake-image-data'),
    stream: null!,
    ...overrides,
  };
}

function defaultS3Behavior() {
  mockS3Send.mockImplementation(async (command: { _tag: string }) => {
    if (command._tag === 'ListObjectsV2') return { Contents: [] };
    if (command._tag === 'DeleteObjects') return {};
    if (command._tag === 'PutObject') return {};
    if (command._tag === 'GetObject') {
      return {
        Body: {
          transformToByteArray: () => Promise.resolve(new Uint8Array(Buffer.from('fake-image'))),
        },
      };
    }
    throw new Error(`Unexpected S3 command: ${command._tag}`);
  });
}

describe('POST /avatar/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultS3Behavior();
    mockNormalizeIdentifier.mockImplementation((value: unknown) => {
      if (typeof value !== 'string' || !value) return null;
      return value;
    });
    mockSanitizeExtension.mockReturnValue('.jpg');
  });

  it('returns 401 when no auth', async () => {
    const app = createApp(undefined, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(401);
  });

  it('returns 400 when no file provided', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('No file provided');
  });

  it('returns 400 when userId is invalid', async () => {
    mockNormalizeIdentifier.mockReturnValue(null);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid user ID format');
  });

  it('returns 403 when uploading for another user without scope', async () => {
    mockHasAuthScope.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-2' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Cannot modify avatar');
  });

  it('allows uploading for another user with avatars:write:any scope', async () => {
    mockHasAuthScope.mockReturnValue(true);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-2' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('saves avatar successfully via S3 PutObjectCommand', async () => {
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.filename).toBe('avatar.jpg');

    const putCall = mockS3Send.mock.calls.find(
      (call: unknown[]) => (call[0] as { _tag: string })._tag === 'PutObject'
    );
    expect(putCall).toBeDefined();
    const putInput = (putCall![0] as { input: { Key: string; Body: Buffer } }).input;
    expect(putInput.Key).toContain('avatars/user-1/avatar');
    expect(putInput.Body).toEqual(Buffer.from('fake-image-data'));
  });

  it('lists and deletes old avatars before saving new one', async () => {
    mockS3Send.mockImplementation(async (command: { _tag: string }) => {
      if (command._tag === 'ListObjectsV2') return {
        Contents: [
          { Key: 'avatars/user-1/avatar.jpg' },
          { Key: 'avatars/user-1/avatar.png' },
        ],
      };
      if (command._tag === 'DeleteObjects') return {};
      if (command._tag === 'PutObject') return {};
      throw new Error(`Unexpected: ${command._tag}`);
    });

    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(200);

    const deleteCall = mockS3Send.mock.calls.find(
      (call: unknown[]) => (call[0] as { _tag: string })._tag === 'DeleteObjects'
    );
    expect(deleteCall).toBeDefined();
    const deleteInput = (deleteCall![0] as { input: { Delete: { Objects: Array<{ Key: string }> } } }).input;
    expect(deleteInput.Delete.Objects).toHaveLength(2);
  });

  it('succeeds when no previous avatars exist (empty ListObjectsV2)', async () => {
    // defaultS3Behavior returns { Contents: [] } for ListObjectsV2
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    // DeleteObjects should NOT be called when list is empty
    const deleteCall = mockS3Send.mock.calls.find(
      (call: unknown[]) => (call[0] as { _tag: string })._tag === 'DeleteObjects'
    );
    expect(deleteCall).toBeUndefined();
  });

  it('succeeds even when S3 list fails (best-effort cleanup)', async () => {
    mockS3Send.mockImplementation(async (command: { _tag: string }) => {
      if (command._tag === 'ListObjectsV2') throw new Error('S3 error');
      if (command._tag === 'PutObject') return {};
      throw new Error(`Unexpected: ${command._tag}`);
    });
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('returns 500 when S3 PutObject fails', async () => {
    mockS3Send.mockImplementation(async (command: { _tag: string }) => {
      if (command._tag === 'ListObjectsV2') return { Contents: [] };
      if (command._tag === 'PutObject') throw new Error('S3 write error');
      throw new Error(`Unexpected: ${command._tag}`);
    });
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app).post('/avatar/upload').send({ userId: 'user-1' });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Failed to upload avatar');
  });
});

describe('DELETE /avatar/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultS3Behavior();
    mockNormalizeIdentifier.mockImplementation((value: unknown) => {
      if (typeof value !== 'string' || !value) return null;
      return value;
    });
  });

  it('returns 401 when no auth', async () => {
    const app = createApp(undefined);
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(401);
  });

  it('returns 400 when userId is invalid', async () => {
    mockNormalizeIdentifier.mockReturnValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/bad-user-id');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid user ID format');
  });

  it('returns 403 when deleting another user avatar without scope', async () => {
    mockHasAuthScope.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-2');
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Cannot delete avatar');
  });

  it('allows deleting another user avatar with scope', async () => {
    mockHasAuthScope.mockReturnValue(true);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-2');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('deletes own avatar via S3', async () => {
    mockS3Send.mockImplementation(async (command: { _tag: string }) => {
      if (command._tag === 'ListObjectsV2') return { Contents: [{ Key: 'avatars/user-1/avatar.jpg' }] };
      if (command._tag === 'DeleteObjects') return {};
      throw new Error(`Unexpected: ${command._tag}`);
    });

    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const deleteCall = mockS3Send.mock.calls.find(
      (call: unknown[]) => (call[0] as { _tag: string })._tag === 'DeleteObjects'
    );
    expect(deleteCall).toBeDefined();
  });

  it('returns success even when no avatars exist', async () => {
    // defaultS3Behavior returns { Contents: [] } for ListObjectsV2
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('returns 500 when outer catch is triggered', async () => {
    mockNormalizeIdentifier.mockImplementation(() => {
      throw new Error('Unexpected identifier error');
    });
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Failed to delete avatar');
    expect(response.body.details).toContain('Unexpected identifier error');
  });
});

describe('GET /avatar/:userId/:filename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultS3Behavior();
    mockNormalizeIdentifier.mockImplementation((value: unknown) => {
      if (typeof value !== 'string' || !value) return null;
      return value;
    });
    mockSanitizeExtension.mockReturnValue('.jpg');
  });

  it('returns 400 when userId is invalid', async () => {
    mockNormalizeIdentifier.mockReturnValue(null);
    const app = createApp();
    const response = await request(app).get('/avatar/bad-id/avatar.jpg');
    expect(response.status).toBe(400);
  });

  it('returns avatar image from S3', async () => {
    const app = createApp();
    const response = await request(app).get('/avatar/user-1/avatar.jpg');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('returns 404 when avatar not found in S3', async () => {
    mockS3Send.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    const app = createApp();
    const response = await request(app).get('/avatar/user-1/avatar.jpg');
    expect(response.status).toBe(404);
  });
});
