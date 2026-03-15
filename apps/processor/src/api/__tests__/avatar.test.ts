import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Hoisted mocks
const {
  mockFsMkdir,
  mockFsReaddir,
  mockFsUnlink,
  mockFsWriteFile,
  mockFsRmdir,
  mockResolvePathWithin,
  mockNormalizeIdentifier,
  mockSanitizeExtension,
  mockHasAuthScope,
} = vi.hoisted(() => ({
  mockFsMkdir: vi.fn().mockResolvedValue(undefined),
  mockFsReaddir: vi.fn().mockResolvedValue([]),
  mockFsUnlink: vi.fn().mockResolvedValue(undefined),
  mockFsWriteFile: vi.fn().mockResolvedValue(undefined),
  mockFsRmdir: vi.fn().mockResolvedValue(undefined),
  // Default implementation: return base/seg
  mockResolvePathWithin: vi.fn().mockImplementation((base: string, ...segs: string[]) => {
    if (!base) return null;
    return `${base}/${segs.join('/')}`;
  }),
  mockNormalizeIdentifier: vi.fn().mockImplementation((value: unknown) => {
    if (typeof value !== 'string' || !value) return null;
    return value;
  }),
  mockSanitizeExtension: vi.fn().mockReturnValue('.jpg'),
  mockHasAuthScope: vi.fn().mockReturnValue(false),
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../middleware/auth', () => ({
  hasAuthScope: (...args: unknown[]) => mockHasAuthScope(...args),
}));

vi.mock('../../utils/security', () => ({
  DEFAULT_IMAGE_EXTENSION: '.png',
  IDENTIFIER_PATTERN: /^[A-Za-z0-9_-]{3,64}$/,
  resolvePathWithin: (...args: unknown[]) => mockResolvePathWithin(...args),
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

vi.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    readdir: (...args: unknown[]) => mockFsReaddir(...args),
    unlink: (...args: unknown[]) => mockFsUnlink(...args),
    writeFile: (...args: unknown[]) => mockFsWriteFile(...args),
    rmdir: (...args: unknown[]) => mockFsRmdir(...args),
  },
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
    stream: null as unknown as NodeJS.ReadableStream,
    ...overrides,
  };
}

describe('POST /avatar/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (!base) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockNormalizeIdentifier.mockImplementation((value: unknown) => {
      if (typeof value !== 'string' || !value) return null;
      return value;
    });
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsReaddir.mockResolvedValue([]);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockSanitizeExtension.mockReturnValue('.jpg');
  });

  it('returns 401 when no auth', async () => {
    const app = createApp(undefined, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(401);
  });

  it('returns 400 when no file provided', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('No file provided');
  });

  it('returns 400 when userId is invalid', async () => {
    mockNormalizeIdentifier.mockReturnValue(null);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: '' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid user ID format');
  });

  it('returns 403 when uploading for another user without scope', async () => {
    mockHasAuthScope.mockReturnValue(false);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-2' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Cannot modify avatar');
  });

  it('allows uploading for another user with avatars:write:any scope', async () => {
    mockHasAuthScope.mockReturnValue(true);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-2' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('saves avatar successfully for own user', async () => {
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.filename).toBe('avatar.jpg');
    expect(mockFsWriteFile).toHaveBeenCalled();
  });

  it('deletes old avatar files before saving new one', async () => {
    mockFsReaddir.mockResolvedValue(['avatar.jpg', 'avatar.png', 'other-file.txt']);
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(200);
    // Should unlink avatar.jpg and avatar.png (starts with 'avatar.')
    expect(mockFsUnlink).toHaveBeenCalledTimes(2);
  });

  it('returns 400 when avatarsDir resolution fails', async () => {
    // First call returns base path (for AVATAR_ROOT), second call fails for user dir
    mockResolvePathWithin
      .mockReturnValueOnce('/data/files/avatars')  // AVATAR_ROOT init
      .mockReturnValue(null); // user dir fails
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid avatar path');
  });

  it('handles errors gracefully', async () => {
    mockFsWriteFile.mockRejectedValue(new Error('Disk full'));
    const app = createApp({ userId: 'user-1' }, createMockFile());
    const response = await request(app)
      .post('/avatar/upload')
      .send({ userId: 'user-1' });
    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Failed to upload avatar');
  });
});

describe('DELETE /avatar/:userId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (!base) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockNormalizeIdentifier.mockImplementation((value: unknown) => {
      if (typeof value !== 'string' || !value) return null;
      return value;
    });
    mockFsReaddir.mockResolvedValue(['avatar.jpg']);
    mockFsUnlink.mockResolvedValue(undefined);
    mockFsRmdir.mockResolvedValue(undefined);
  });

  it('returns 401 when no auth', async () => {
    const app = createApp(undefined);
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(401);
  });

  it('returns 400 when userId is invalid', async () => {
    mockNormalizeIdentifier.mockReturnValue(null);
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/');
    // Express may route this differently, but let's test with a known route
    expect([400, 404]).toContain(response.status);
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

  it('deletes own avatar successfully', async () => {
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockFsUnlink).toHaveBeenCalled();
  });

  it('returns success even when directory does not exist', async () => {
    mockFsReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('handles unlink errors gracefully (inner try/catch)', async () => {
    mockFsReaddir.mockResolvedValue(['avatar.jpg']);
    mockFsUnlink.mockRejectedValue(new Error('Permission denied'));
    mockFsRmdir.mockRejectedValue(Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }));
    // Both unlink and rmdir failures are caught by inner try/catch
    const app = createApp({ userId: 'user-1' });
    const response = await request(app).delete('/avatar/user-1');
    // The outer delete catches the inner errors, returns 200
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
