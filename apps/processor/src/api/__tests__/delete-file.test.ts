import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';

const VALID_HASH = 'a'.repeat(64);

const mockDeleteOriginalAndCache = vi.fn();
const mockAssertDeleteFileAccess = vi.fn();

vi.mock('../../server', () => ({
  contentStore: {
    deleteOriginalAndCache: (...args: unknown[]) => mockDeleteOriginalAndCache(...args),
  },
}));

vi.mock('../../services/rbac', () => {
  class DeleteFileAuthorizationError extends Error {
    constructor(message = 'Access denied for requested file') {
      super(message);
      this.name = 'DeleteFileAuthorizationError';
    }
  }

  class DeleteFileReferencedError extends Error {
    constructor(message = 'File is still referenced and cannot be hard deleted') {
      super(message);
      this.name = 'DeleteFileReferencedError';
    }
  }

  return {
    assertDeleteFileAccess: (...args: unknown[]) => mockAssertDeleteFileAccess(...args),
    DeleteFileAuthorizationError,
    DeleteFileReferencedError,
  };
});

import { deleteFileRouter } from '../delete-file';
import { DeleteFileAuthorizationError, DeleteFileReferencedError } from '../../services/rbac';

type MockAuth = {
  userId: string;
};

function createApp(auth?: MockAuth): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = auth as unknown as typeof req.auth;
    next();
  });
  app.use('/files', deleteFileRouter);
  return app;
}

describe('delete-file route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertDeleteFileAccess.mockResolvedValue(undefined);
    mockDeleteOriginalAndCache.mockResolvedValue({
      originalDeleted: true,
      cacheDeleted: true,
    });
  });

  it('returns 400 for invalid hash', async () => {
    const app = createApp({ userId: 'user-1' });

    const response = await request(app).delete('/files/not-a-valid-hash');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid content hash format' });
    expect(mockAssertDeleteFileAccess).not.toHaveBeenCalled();
    expect(mockDeleteOriginalAndCache).not.toHaveBeenCalled();
  });

  it('returns 401 for missing auth', async () => {
    const app = createApp();

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Service authentication required' });
    expect(mockAssertDeleteFileAccess).not.toHaveBeenCalled();
    expect(mockDeleteOriginalAndCache).not.toHaveBeenCalled();
  });

  it('returns 403 for authorization failure', async () => {
    const app = createApp({ userId: 'user-1' });
    mockAssertDeleteFileAccess.mockRejectedValue(new DeleteFileAuthorizationError());

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Access denied for requested file' });
    expect(mockDeleteOriginalAndCache).not.toHaveBeenCalled();
  });

  it('returns 409 when file is still referenced', async () => {
    const app = createApp({ userId: 'user-1' });
    mockAssertDeleteFileAccess.mockRejectedValue(new DeleteFileReferencedError());

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'File is still referenced and cannot be hard deleted' });
    expect(mockDeleteOriginalAndCache).not.toHaveBeenCalled();
  });

  it('returns 200 for authorized orphan delete', async () => {
    const app = createApp({ userId: 'user-1' });
    mockDeleteOriginalAndCache.mockResolvedValue({
      originalDeleted: true,
      cacheDeleted: false,
    });

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      contentHash: VALID_HASH,
      originalDeleted: true,
      cacheDeleted: false,
    });
  });

  it('returns 404 when nothing is deleted', async () => {
    const app = createApp({ userId: 'user-1' });
    mockDeleteOriginalAndCache.mockResolvedValue({
      originalDeleted: false,
      cacheDeleted: false,
    });

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      contentHash: VALID_HASH,
      originalDeleted: false,
      cacheDeleted: false,
    });
  });

  it('returns 500 when deletion throws an unexpected error', async () => {
    const app = createApp({ userId: 'user-1' });
    mockDeleteOriginalAndCache.mockRejectedValue(new Error('disk failure'));

    const response = await request(app).delete(`/files/${VALID_HASH}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'disk failure' });
  });
});
