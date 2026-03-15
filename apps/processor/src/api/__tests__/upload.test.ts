import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';

// Hoisted mocks to avoid initialization errors
const {
  mockOriginalExists,
  mockSaveOriginalFromFile,
  mockAppendUploadMetadata,
  mockAddJob,
  mockFsUnlink,
  mockFsMkdir,
  mockResolvePathWithin,
  mockSanitizeExtension,
  mockCreateReadStream,
  UPLOAD_TEMP_DIR,
} = vi.hoisted(() => {
  // Set env var BEFORE module loads (hoisted runs first)
  process.env.CACHE_PATH = '/tmp/test-cache';
  const UPLOAD_TEMP_DIR = '/tmp/test-cache/temp-uploads';
  const MOCK_HASH = 'a'.repeat(64);

  // Create a stream-like object that emits 'data' and 'end' events
  function makeMockStream() {
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stream = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);

        if (event === 'end') {
          // Emit end asynchronously after registration
          Promise.resolve().then(() => {
            handlers['end']?.forEach(h => h());
          });
        }
        return stream;
      },
    };
    return stream;
  }

  const mockCreateReadStream = vi.fn().mockImplementation(() => makeMockStream());

  return {
    mockOriginalExists: vi.fn(),
    mockSaveOriginalFromFile: vi.fn(),
    mockAppendUploadMetadata: vi.fn(),
    mockAddJob: vi.fn(),
    mockFsUnlink: vi.fn().mockResolvedValue(undefined),
    mockFsMkdir: vi.fn().mockResolvedValue(undefined),
    // Default: return base/seg so module-level TEMP_UPLOADS_DIR resolves
    mockResolvePathWithin: vi.fn().mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some((s: string) => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    }),
    mockSanitizeExtension: vi.fn().mockReturnValue('.jpg'),
    mockCreateReadStream,
    UPLOAD_TEMP_DIR,
  };
});

vi.mock('../../server', () => ({
  contentStore: {
    originalExists: (...args: unknown[]) => mockOriginalExists(...args),
    saveOriginalFromFile: (...args: unknown[]) => mockSaveOriginalFromFile(...args),
    appendUploadMetadata: (...args: unknown[]) => mockAppendUploadMetadata(...args),
  },
  queueManager: {
    addJob: (...args: unknown[]) => mockAddJob(...args),
  },
}));

vi.mock('../../utils/security', () => ({
  resolvePathWithin: (...args: unknown[]) => mockResolvePathWithin(...args),
  sanitizeExtension: (...args: unknown[]) => mockSanitizeExtension(...args),
}));

vi.mock('../../middleware/rate-limit', () => ({
  rateLimitUpload: (req: Request, res: Response, next: NextFunction) => next(),
}));

vi.mock('../../middleware/auth', () => ({
  hasAuthScope: vi.fn().mockReturnValue(false),
}));

vi.mock('../../logger', () => ({
  processorLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockFsMkdir(...args),
    unlink: (...args: unknown[]) => mockFsUnlink(...args),
  },
  mkdir: (...args: unknown[]) => mockFsMkdir(...args),
  unlink: (...args: unknown[]) => mockFsUnlink(...args),
}));

// Mock fs module (for createReadStream used by computeFileHash)
vi.mock('fs', () => ({
  createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  default: {
    createReadStream: (...args: unknown[]) => mockCreateReadStream(...args),
  },
}));

// Mock crypto to return a predictable hash
vi.mock('crypto', () => {
  const FAKE_HASH = 'a'.repeat(64);
  const hashObj = {
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue(FAKE_HASH),
  };
  return {
    createHash: vi.fn().mockReturnValue(hashObj),
    default: {
      createHash: vi.fn().mockReturnValue(hashObj),
    },
  };
});

// Mock multer - we need to control file uploads
const { mockMulterSingle, mockMulterArray } = vi.hoisted(() => ({
  mockMulterSingle: vi.fn(),
  mockMulterArray: vi.fn(),
}));

vi.mock('multer', () => {
  // single and array return passthrough middleware so the route handler runs
  const passthroughMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();

  const multerInstance = {
    single: (...args: unknown[]) => {
      mockMulterSingle(...args);
      return passthroughMiddleware;
    },
    array: (...args: unknown[]) => {
      mockMulterArray(...args);
      return passthroughMiddleware;
    },
  };

  // disk storage mock
  const diskStorage = vi.fn().mockReturnValue({});

  const multer = vi.fn().mockReturnValue(multerInstance);
  (multer as unknown as { diskStorage: typeof diskStorage }).diskStorage = diskStorage;

  return { default: multer };
});

// For most tests we skip the upload middleware and test the route logic directly
// by attaching a mock file to req
import { uploadRouter } from '../upload';

type MockAuth = {
  userId?: string;
  resourceBinding?: { type: string; id: string };
  driveId?: string;
};

function createApp(auth?: MockAuth, file?: Express.Multer.File, files?: Express.Multer.File[]): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Inject auth
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    if (file) req.file = file;
    if (files) req.files = files;
    next();
  });

  // Bypass multer middleware by overriding it
  app.use((req: Request, _res: Response, next: NextFunction) => {
    // Override multer single handler
    next();
  });

  app.use('/upload', uploadRouter);
  return app;
}

// Create a mock multer file
function createMockFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    destination: UPLOAD_TEMP_DIR,
    filename: 'temp-file.jpg',
    path: `${UPLOAD_TEMP_DIR}/temp-file.jpg`,
    size: 1024,
    buffer: Buffer.from(''),
    stream: null as unknown as NodeJS.ReadableStream,
    ...overrides,
  };
}

describe('upload router - auth check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some(s => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    });
  });

  it('returns 401 when no auth on single upload', async () => {
    // The router middleware checks auth before multer
    const app = createApp(undefined, undefined, undefined);
    const response = await request(app).post('/upload/single');
    expect(response.status).toBe(401);
    expect(response.body.error).toContain('Authentication required');
  });

  it('returns 401 when no auth on multiple upload', async () => {
    const app = createApp(undefined, undefined, undefined);
    const response = await request(app).post('/upload/multiple');
    expect(response.status).toBe(401);
  });
});

// Test the route logic more directly by examining specific code paths
// We need a way to bypass multer. Let's test using a direct Express setup that bypasses multer.
describe('upload router - single upload handler', () => {
  let capturedSingleHandler: ((req: Request, res: Response) => Promise<void>) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some(s => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({
      contentHash: 'a'.repeat(64),
      path: '/storage/hash/original',
    });
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockAddJob.mockResolvedValue('job-123');
    mockFsUnlink.mockResolvedValue(undefined);
    mockSanitizeExtension.mockReturnValue('.jpg');
  });

  it('handles missing resource page binding', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = { userId: 'user-1' } as unknown as typeof req.auth;
      req.file = createMockFile();
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    // Should be 403 - missing page resource binding
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('page resource binding');
  });

  it('handles missing driveId', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.file = createMockFile();
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ pageId: 'page-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('driveId is required');
  });

  it('handles drive mismatch', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-OTHER',
      } as unknown as typeof req.auth;
      req.file = createMockFile();
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Token drive does not match');
  });

  it('handles missing pageId', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.file = createMockFile();
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('pageId is required');
  });

  it('handles page resource binding mismatch', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-DIFFERENT' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.file = createMockFile();
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Token resource does not match');
  });

  it('returns 400 when no file provided', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      // No file
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('No file provided');
  });

  it('returns 400 when file path is outside temp dir', async () => {
    // Mock resolvePathWithin to return a path outside temp-uploads
    // The check is: normalizedTemp.startsWith(path.resolve(TEMP_UPLOADS_DIR) + path.sep)
    // We can test this by providing a file path that doesn't start with the upload dir
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.file = createMockFile({ path: '/etc/passwd' });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid upload file path');
  });
});

describe('upload router - multiple upload handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some(s => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({
      contentHash: 'a'.repeat(64),
      path: '/storage/hash/original',
    });
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockAddJob.mockResolvedValue('job-123');
    mockFsUnlink.mockResolvedValue(undefined);
  });

  it('returns 403 when missing page resource binding', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = { userId: 'user-1', driveId: 'drive-1' } as unknown as typeof req.auth;
      req.files = [];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('page resource binding');
  });

  it('returns 400 when no driveId', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.files = [];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app).post('/upload/multiple').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('driveId is required');
  });

  it('returns 400 when no files provided', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.files = undefined;
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('No files provided');
  });

  it('returns 403 for drive mismatch in multiple', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-OTHER',
      } as unknown as typeof req.auth;
      req.files = [];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Token drive does not match');
  });

  it('returns 400 for invalid file path in multiple upload', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-1' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.files = [createMockFile({ path: '/etc/passwd' })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Invalid upload file path');
  });
});

describe('upload router - single upload success paths', () => {
  const TEMP_PATH = `${UPLOAD_TEMP_DIR}/temp-file.jpg`;

  function makeAuth() {
    return {
      userId: 'user-1',
      resourceBinding: { type: 'page', id: 'page-1' },
      driveId: 'drive-1',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some(s => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({
      contentHash: 'a'.repeat(64),
      path: '/storage/hash/original',
    });
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockAddJob.mockResolvedValue('job-123');
    mockFsUnlink.mockResolvedValue(undefined);
    mockSanitizeExtension.mockReturnValue('.jpg');
  });

  it('uploads single file successfully (new file)', async () => {
    mockOriginalExists.mockResolvedValue(false);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.deduplicated).toBe(false);
    expect(mockSaveOriginalFromFile).toHaveBeenCalled();
    expect(mockAddJob).toHaveBeenCalledWith('ingest-file', expect.any(Object));
    expect(mockFsUnlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('uploads single file - deduplication path', async () => {
    mockOriginalExists.mockResolvedValue(true);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.deduplicated).toBe(true);
    expect(mockAppendUploadMetadata).toHaveBeenCalled();
    expect(mockSaveOriginalFromFile).not.toHaveBeenCalled();
  });

  it('handles error during file save', async () => {
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockRejectedValue(new Error('Storage error'));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Upload failed');
    // Should still try to clean up temp file
    expect(mockFsUnlink).toHaveBeenCalledWith(TEMP_PATH);
  });

  it('handles different userId in body (same as auth userId - allowed)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1', userId: 'user-1' });

    expect(response.status).toBe(200);
  });

  it('handles cleanup failure when unlink fails after save (logs warning, still returns 200)', async () => {
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({
      contentHash: 'a'.repeat(64),
      path: '/storage/hash/original',
    });
    // Make unlink fail - cleanup error should be logged but not affect response
    mockFsUnlink.mockRejectedValue(new Error('Cannot delete temp file'));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    // Should still succeed even when cleanup fails
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('handles cleanup failure during deduplication unlink (lines 178-183)', async () => {
    mockOriginalExists.mockResolvedValue(true);
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockFsUnlink.mockRejectedValue(new Error('Unlink failed'));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    // Should still succeed even when cleanup fails in deduplication path
    expect(response.status).toBe(200);
    expect(response.body.deduplicated).toBe(true);
  });

  it('returns 403 when userId in body differs from auth userId and hasAuthScope returns false', async () => {
    const { hasAuthScope } = await import('../../middleware/auth');
    (hasAuthScope as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1', userId: 'other-user' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Cannot upload on behalf of another user');
  });

  it('returns 500 and cleans up when error occurs and unlink also fails (lines 254-258)', async () => {
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockRejectedValue(new Error('Storage error'));
    // Make unlink fail during error cleanup so we hit lines 254-258
    mockFsUnlink.mockRejectedValue(new Error('Cleanup also failed'));

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.file = createMockFile({ path: TEMP_PATH });
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/single')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain('Upload failed');
    // Unlink was attempted (and failed) during error cleanup
    expect(mockFsUnlink).toHaveBeenCalled();
  });
});

describe('upload router - multiple upload success paths', () => {
  const TEMP_PATH = `${UPLOAD_TEMP_DIR}/temp-file.jpg`;

  function makeAuth() {
    return {
      userId: 'user-1',
      resourceBinding: { type: 'page', id: 'page-1' },
      driveId: 'drive-1',
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePathWithin.mockImplementation((base: string, ...segs: string[]) => {
      if (segs.some(s => s.includes('..'))) return null;
      return `${base}/${segs.join('/')}`;
    });
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({
      contentHash: 'a'.repeat(64),
      path: '/storage/hash/original',
    });
    mockAppendUploadMetadata.mockResolvedValue(undefined);
    mockAddJob.mockResolvedValue('job-123');
    mockFsUnlink.mockResolvedValue(undefined);
  });

  it('uploads multiple files successfully', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.files = [
        createMockFile({ path: TEMP_PATH, originalname: 'file1.jpg' }),
        createMockFile({ path: TEMP_PATH, originalname: 'file2.jpg' }),
      ] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.files).toHaveLength(2);
    expect(mockFsUnlink).toHaveBeenCalledTimes(2);
  });

  it('uploads multiple files with deduplication', async () => {
    mockOriginalExists.mockResolvedValue(true);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.files = [createMockFile({ path: TEMP_PATH })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.files[0].deduplicated).toBe(true);
    expect(mockAppendUploadMetadata).toHaveBeenCalled();
    expect(mockSaveOriginalFromFile).not.toHaveBeenCalled();
  });

  it('handles per-file errors gracefully', async () => {
    mockSaveOriginalFromFile.mockRejectedValue(new Error('Storage error'));
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.files = [createMockFile({ path: TEMP_PATH })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.files[0].error).toBeDefined();
    expect(response.body.files[0].success).toBe(false);
  });

  it('returns 403 when userId differs and hasAuthScope is false in multiple upload (lines 298-302)', async () => {
    const { hasAuthScope } = await import('../../middleware/auth');
    (hasAuthScope as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.files = [createMockFile({ path: TEMP_PATH })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', userId: 'other-user' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Cannot upload on behalf of another user');
  });

  it('returns 403 when page binding mismatches in multiple upload (lines 312-313)', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = {
        userId: 'user-1',
        resourceBinding: { type: 'page', id: 'page-BOUND' },
        driveId: 'drive-1',
      } as unknown as typeof req.auth;
      req.files = [createMockFile({ path: TEMP_PATH })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', pageId: 'page-DIFFERENT' });

    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Token resource does not match requested page');
  });

  it('handles cleanup failure in multi-file success cleanup loop (lines 383-388)', async () => {
    // Files process successfully but unlink fails during cleanup
    mockOriginalExists.mockResolvedValue(false);
    mockSaveOriginalFromFile.mockResolvedValue({ contentHash: 'a'.repeat(64), path: '/storage/hash/original' });
    mockFsUnlink.mockRejectedValue(new Error('Cannot delete temp file'));

    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.auth = makeAuth() as unknown as typeof req.auth;
      req.files = [createMockFile({ path: TEMP_PATH })] as Express.Multer.File[];
      next();
    });
    app.use('/upload', uploadRouter);

    const response = await request(app)
      .post('/upload/multiple')
      .send({ driveId: 'drive-1', pageId: 'page-1' });

    // Should still succeed even if cleanup fails
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockFsUnlink).toHaveBeenCalledWith(TEMP_PATH);
  });
});
