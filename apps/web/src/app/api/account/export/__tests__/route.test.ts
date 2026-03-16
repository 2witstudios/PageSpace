import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/compliance/export/gdpr-export', () => ({
  collectAllUserData: vi.fn(),
}));

// Mock archiver - return an event emitter-like object
const mockArchive = {
  on: vi.fn(),
  append: vi.fn(),
  finalize: vi.fn(),
};

vi.mock('archiver', () => ({
  default: vi.fn(() => mockArchive),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { collectAllUserData } from '@pagespace/lib/compliance/export/gdpr-export';

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

const createRequest = () =>
  new Request('http://localhost/api/account/export');

const mockUserData = {
  profile: { id: 'user-1', email: 'test@example.com' },
  drives: [{ id: 'drive-1', name: 'My Drive' }],
  pages: [{ id: 'page-1', title: 'Page 1' }],
  messages: [],
  files: [],
  activity: [],
  aiUsage: [],
  tasks: [],
};

describe('GET /api/account/export', () => {
  /**
   * We use dynamic import with vi.resetModules() so each test gets a fresh
   * module with a clean lastExportMap (the in-memory rate limit state).
   */
  let GET: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Reset the archive mock handlers
    mockArchive.on.mockReset();
    mockArchive.append.mockReset();
    mockArchive.finalize.mockReset();

    mockArchive.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'data') {
        mockArchive.finalize.mockImplementation(() => {
          handler(Buffer.from('mock-zip-data'));
          const endCall = mockArchive.on.mock.calls.find(
            (call: unknown[]) => call[0] === 'end'
          );
          if (endCall) {
            (endCall[1] as () => void)();
          }
        });
      }
      return mockArchive;
    });

    // Re-import to get fresh module state (clean rate limit map)
    vi.resetModules();
    const mod = await import('../route');
    GET = mod.GET;
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest());

      expect(response.status).toBe(401);
    });

    it('calls authenticateRequestWithOptions with session-only and no CSRF', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      const request = createRequest();
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('user data not found', () => {
    it('returns 404 when collectAllUserData returns null', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(null);

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('successful export', () => {
    it('returns ZIP response with correct headers', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      const response = await GET(createRequest());

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/zip');
      expect(response.headers.get('Content-Disposition')).toMatch(
        /attachment; filename="pagespace-export-\d{4}-\d{2}-\d{2}\.zip"/
      );
    });

    it('returns a ReadableStream body', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      const response = await GET(createRequest());

      expect(response.body).toBeInstanceOf(ReadableStream);
    });

    it('appends all data categories to archive', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      // Should append 8 JSON files
      expect(mockArchive.append).toHaveBeenCalledTimes(8);
      // Verify each data category name pattern
      const appendCalls = mockArchive.append.mock.calls.map(
        (call: unknown[]) => (call[1] as { name: string }).name
      );
      expect(appendCalls.some((n: string) => n.includes('profile.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('drives.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('pages.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('messages.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('files-metadata.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('activity.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('ai-usage.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('tasks.json'))).toBe(true);
    });

    it('calls archive.finalize()', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      expect(mockArchive.finalize).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 on second export within 24 hours', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      // First export should succeed
      const response1 = await GET(createRequest());
      expect(response1.status).toBe(200);

      // Second export should be rate limited
      const response2 = await GET(createRequest());
      const body = await response2.json();

      expect(response2.status).toBe(429);
      expect(body.error).toBe('Export rate limit exceeded. You can request one export per 24 hours.');
      const retryAfter = Number(response2.headers.get('Retry-After'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(86400);
    });
  });

  describe('error handling', () => {
    it('returns 500 when collectAllUserData throws', async () => {
      vi.mocked(collectAllUserData).mockRejectedValueOnce(new Error('DB error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate data export');
      consoleSpy.mockRestore();
    });

    it('propagates archive error to ReadableStream controller', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      // Override the archive mock to trigger the error handler
      mockArchive.on.mockReset();
      mockArchive.finalize.mockReset();

      let errorHandler: ((err: Error) => void) | undefined;

      mockArchive.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'error') {
          errorHandler = handler as (err: Error) => void;
        }
        if (event === 'data') {
          mockArchive.finalize.mockImplementation(() => {
            // Trigger the error handler instead of data
            if (errorHandler) {
              errorHandler(new Error('Archive compression failed'));
            }
          });
        }
        return mockArchive;
      });

      const response = await GET(createRequest());

      // The response is created with the ReadableStream, so status is 200
      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(ReadableStream);

      // Reading the stream should throw since the error handler was invoked
      const reader = response.body!.getReader();
      await expect(reader.read()).rejects.toThrow('Archive compression failed');
    });
  });
});
