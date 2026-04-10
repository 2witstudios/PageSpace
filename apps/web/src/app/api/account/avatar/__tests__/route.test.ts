import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  users: { id: 'id', image: 'image' },
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));

vi.mock('@pagespace/lib', () => ({
  createUserServiceToken: vi.fn().mockResolvedValue({ token: 'mock-service-token' }),
}));

vi.mock('@pagespace/lib/server', () => ({
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { POST, DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { securityAudit } from '@pagespace/lib/server';

// Test helpers
const mockSessionAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockSelectChain = (result: unknown[]) => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(result);
  vi.mocked(db.select).mockImplementation(chain.select as never);
  return chain;
};

const mockUpdateChain = () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.update = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.update).mockImplementation(chain.update as never);
  return chain;
};

const createMockFile = (type = 'image/png', size = 1024, name = 'avatar.png') => ({
  type,
  size,
  name,
});

/**
 * Create a request with a mocked formData() method.
 * jsdom's Request.formData() can hang, so we mock it directly.
 */
const createUploadRequest = (file?: { type: string; size: number; name: string }) => {
  const _formData = new FormData();
  // We don't actually append the file to FormData; we mock formData() to return it
  const mockFormData = {
    get: vi.fn((key: string) => {
      if (key === 'file' && file) return file;
      return null;
    }),
  };
  const request = {
    formData: vi.fn().mockResolvedValue(mockFormData),
    headers: new Headers(),
    url: 'http://localhost/api/account/avatar',
    method: 'POST',
  };
  return request as unknown as import('next/server').NextRequest;
};

const createDeleteRequest = () => {
  return {
    headers: new Headers(),
    url: 'http://localhost/api/account/avatar',
    method: 'DELETE',
  } as unknown as import('next/server').NextRequest;
};

describe('POST /api/account/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createUploadRequest(createMockFile()));

      expect(response.status).toBe(401);
    });
  });

  describe('file validation', () => {
    it('returns 400 when no file is provided', async () => {
      const response = await POST(createUploadRequest());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('No file provided');
    });

    it('returns 400 for invalid file type', async () => {
      const file = createMockFile('application/pdf', 1024, 'document.pdf');
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid file type');
    });

    it('returns 400 when file exceeds 5MB', async () => {
      const file = createMockFile('image/png', 6 * 1024 * 1024, 'huge.png');
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('File too large');
    });

    it('accepts image/jpeg', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'avatar.jpg' }),
      });

      const file = createMockFile('image/jpeg', 1024, 'avatar.jpg');
      const response = await POST(createUploadRequest(file));

      expect(response.status).toBe(200);
    });

    it('accepts image/jpg', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'avatar.jpg' }),
      });

      const file = createMockFile('image/jpg', 1024, 'avatar.jpg');
      const response = await POST(createUploadRequest(file));

      expect(response.status).toBe(200);
    });

    it('accepts image/gif', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'avatar.gif' }),
      });

      const file = createMockFile('image/gif', 1024, 'avatar.gif');
      const response = await POST(createUploadRequest(file));

      expect(response.status).toBe(200);
    });

    it('accepts image/webp', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'avatar.webp' }),
      });

      const file = createMockFile('image/webp', 1024, 'avatar.webp');
      const response = await POST(createUploadRequest(file));

      expect(response.status).toBe(200);
    });
  });

  describe('old avatar deletion', () => {
    it('deletes old local avatar before upload', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/old.png' }]);
      mockUpdateChain();
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // DELETE old avatar
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ filename: 'new.png' }),
        }); // POST new avatar

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      // First fetch call is DELETE of old avatar
      const deleteCall = mockFetch.mock.calls.find(
        (call: unknown[]) => (call[1] as { method: string }).method === 'DELETE'
      );
      expect(deleteCall).not.toBeUndefined();
      expect(deleteCall![0]).toContain('/api/avatar/user-1');
      expect((deleteCall![1] as { method: string }).method).toBe('DELETE');
    });

    it('skips deletion when old avatar is external URL (http)', async () => {
      mockSelectChain([{ image: 'http://example.com/avatar.png' }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'new.png' }),
      });

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      // Only one fetch call (the upload), no delete
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('skips deletion when old avatar is external URL (https)', async () => {
      mockSelectChain([{ image: 'https://example.com/avatar.png' }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'new.png' }),
      });

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      // Only one fetch call (the upload), no delete
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('skips deletion when no old avatar exists', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'new.png' }),
      });

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      // Only one fetch call (the upload)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('continues upload when old avatar deletion fails', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/old.png' }]);
      mockUpdateChain();
      mockFetch
        .mockRejectedValueOnce(new Error('Network error')) // DELETE fails
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ filename: 'new.png' }),
        }); // POST succeeds

      const file = createMockFile('image/png', 1024);
      const response = await POST(createUploadRequest(file));

      expect(response.status).toBe(200);
    });

    it('handles empty old user array (no user record)', async () => {
      mockSelectChain([]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'new.png' }),
      });

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      // Only one fetch call (the upload), no delete
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('processor upload', () => {
    it('forwards file to processor service', async () => {
      mockSelectChain([{ image: null }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'processed.png' }),
      });

      const file = createMockFile('image/png', 1024);
      await POST(createUploadRequest(file));

      const uploadCall = mockFetch.mock.calls.find(
        (call: unknown[]) => (call[1] as { method: string }).method === 'POST'
      );
      expect(uploadCall).not.toBeUndefined();
      expect(uploadCall![0]).toContain('/api/avatar/upload');
      expect((uploadCall![1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer mock-service-token');
    });

    it('returns 500 when processor rejects upload', async () => {
      mockSelectChain([{ image: null }]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ error: 'Invalid image' }),
      });

      const file = createMockFile('image/png', 1024);
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to upload avatar');
    });

    it('handles processor response with no parseable JSON error', async () => {
      mockSelectChain([{ image: null }]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Not JSON')),
      });

      const file = createMockFile('image/png', 1024);
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to upload avatar');
    });
  });

  describe('successful upload', () => {
    it('updates user record and returns avatar URL', async () => {
      mockSelectChain([{ image: null }]);
      const chain = mockUpdateChain();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ filename: 'final.png' }),
      });

      const file = createMockFile('image/png', 1024);
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.avatarUrl).toMatch(/\/api\/avatar\/user-1\/final\.png\?t=\d+/);
      expect(body.message).toBe('Avatar uploaded successfully');
      const setCallArgs = vi.mocked(chain.set).mock.calls[0];
      const setPayload = setCallArgs[0] as { image: string };
      expect(Object.keys(setPayload)).toEqual(['image']);
      expect(setPayload.image).toContain('/api/avatar/user-1/final.png');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected top-level error', async () => {
      vi.mocked(authenticateRequestWithOptions).mockRejectedValueOnce(new Error('Unexpected'));

      const file = createMockFile('image/png', 1024);
      const response = await POST(createUploadRequest(file));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to upload avatar');
    });
  });
});

describe('DELETE /api/account/avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await DELETE(createDeleteRequest());

      expect(response.status).toBe(401);
    });
  });

  describe('no avatar to delete', () => {
    it('returns success message when user has no avatar', async () => {
      mockSelectChain([{ image: null }]);

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('No avatar to delete');
    });

    it('returns success message when user record not found', async () => {
      mockSelectChain([]);

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('No avatar to delete');
    });
  });

  describe('local avatar deletion', () => {
    it('sends delete request to processor for local avatar', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/avatar.png' }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({ ok: true });

      await DELETE(createDeleteRequest());

      const fetchCallArgs = mockFetch.mock.calls[0];
      expect(fetchCallArgs[0]).toContain('/api/avatar/user-1');
      const fetchOpts = fetchCallArgs[1] as { method: string; headers: Record<string, string> };
      expect(fetchOpts.method).toBe('DELETE');
      expect(fetchOpts.headers).toEqual({ Authorization: 'Bearer mock-service-token' });
    });

    it('continues when processor delete fails', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/avatar.png' }]);
      mockUpdateChain();
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('external avatar deletion', () => {
    it('skips processor delete for http URL', async () => {
      mockSelectChain([{ image: 'http://example.com/avatar.png' }]);
      mockUpdateChain();

      await DELETE(createDeleteRequest());

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('skips processor delete for https URL', async () => {
      mockSelectChain([{ image: 'https://example.com/avatar.png' }]);
      mockUpdateChain();

      await DELETE(createDeleteRequest());

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('successful deletion', () => {
    it('clears avatar from database and returns success', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/avatar.png' }]);
      const chain = mockUpdateChain();
      mockFetch.mockResolvedValue({ ok: true });

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Avatar deleted successfully');
      expect(chain.set).toHaveBeenCalledWith({ image: null });
    });

    it('logs delete audit event with operation details', async () => {
      mockSelectChain([{ image: '/api/avatar/user-1/avatar.png' }]);
      mockUpdateChain();
      mockFetch.mockResolvedValue({ ok: true });

      await DELETE(createDeleteRequest());

      expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
        'user-1', 'delete', 'avatar', 'user-1', { operation: 'delete' }
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      vi.mocked(authenticateRequestWithOptions).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await DELETE(createDeleteRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete avatar');
    });
  });
});
