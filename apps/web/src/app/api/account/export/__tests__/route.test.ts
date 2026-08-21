import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock at the service seam level
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/export/gdpr-export', () => ({
  collectAllUserData: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    EXPORT_DATA: {
      maxAttempts: 1,
      windowMs: 24 * 60 * 60 * 1000,
      blockDurationMs: 24 * 60 * 60 * 1000,
      progressiveDelay: false,
    },
  },
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
import { buildNativeExportFiles } from '@pagespace/lib/compliance/export/export-format';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { GET } from '../route';

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
  sheets: [],
  messages: [],
  files: [],
  activity: [],
  systemLogs: [],
  apiMetrics: [],
  errorLogs: [],
  aiUsage: [],
  tasks: [],
  sessions: [],
  notifications: [],
  displayPreferences: [],
  settings: { hotkeys: [], automation: null, toastNotifications: null, emailNotifications: [] },
  personalization: null,
  personalizationCandidates: [],
  // The categories the "Agent-Session Single Source of Truth" epic added. They
  // were missing from the export for the whole epic, and THIS FILE is why
  // nobody noticed: the category assertion below used to be a hand-written list
  // that agreed with whatever the route already emitted, so an absent category
  // could never fail it. It is now derived — see the test.
  agentWorkspaces: [{ id: 'ws-1', role: 'owner', name: 'Working context', shells: [] }],
  streamState: [{ messageId: 'sm-1', conversationId: 'c-1', status: 'complete', parts: [] }],
  contentTags: [{ tagName: 'risk', pageId: 'p-1', pageTitle: 'Page', targetKind: 'page', anchor: null, anchorStatus: null, channelMessageId: null, aiMessageId: null, source: 'user', confidence: null }],
};

describe('GET /api/account/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 0 });

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

    it('resets rate limit on 404 so user can retry', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(null);

      await GET(createRequest());

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('export:user:user-1');
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

    /**
     * DERIVED, NOT HAND-WRITTEN.
     *
     * This assertion used to be a literal list of the fourteen file names the
     * route happened to emit, plus a hardcoded `toHaveBeenCalledTimes(15)`. A
     * list like that agrees with the code by construction: when the
     * agent-session epic moved a large amount of user work into
     * `agent_workspaces` / `agent_workspace_shells` / `ai_stream_sessions` and
     * grew no collector for any of it, this test stayed green — it was PINNING
     * the omission rather than catching it.
     *
     * So it now derives the expectation from `buildNativeExportFiles`, the same
     * function the route calls, and asserts the archive carries exactly that
     * inventory. The list can never again lag the bundle. Catching the missing
     * COLLECTOR is a different job, done at the schema level by
     * `packages/lib/src/compliance/export/gdpr-export-coverage.test.ts`.
     */
    it('appends every file the native bundle defines, and nothing else', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      const appendCalls = mockArchive.append.mock.calls.map(
        (call: unknown[]) => (call[1] as { name: string }).name
      );
      const basenames = appendCalls.map((n: string) => n.split('/').pop()!);
      const expected = buildNativeExportFiles(mockUserData as never).map((f) => f.name);

      // manifest.json is always present (Art 20 self-describing bundle).
      expect(basenames.sort()).toEqual([...expected, 'manifest.json'].sort());
      expect(mockArchive.append).toHaveBeenCalledTimes(expected.length + 1);
    });

    it('carries the agent-session categories the epic left out of the export', () => {
      // Regression pins, named individually so a future edit that drops one
      // fails with the category rather than as a set difference.
      const names = buildNativeExportFiles(mockUserData as never).map((f) => f.name);
      expect(names).toContain('agent-workspaces.json');
      expect(names).toContain('stream-state.json');
    });

    it('manifest.json documents the schema version and file inventory', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      const manifestCall = mockArchive.append.mock.calls.find(
        (call: unknown[]) => (call[1] as { name: string }).name.includes('manifest.json')
      );
      expect(manifestCall).toBeDefined();
      const manifest = JSON.parse(manifestCall![0] as string);
      expect(manifest.schemaVersion).toBe('1.0.0');
      expect(manifest.format).toBe('native');
      expect(Array.isArray(manifest.files)).toBe(true);
      expect(manifest.files.some((f: { name: string }) => f.name === 'pages.json')).toBe(true);
    });

    it('format=portable emits a single schema.org data.json plus manifest', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(new Request('http://localhost/api/account/export?format=portable'));

      const appendCalls = mockArchive.append.mock.calls.map(
        (call: unknown[]) => (call[1] as { name: string }).name
      );
      // portable = data.json + manifest.json only
      expect(mockArchive.append).toHaveBeenCalledTimes(2);
      expect(appendCalls.some((n: string) => n.includes('data.json'))).toBe(true);
      expect(appendCalls.some((n: string) => n.includes('manifest.json'))).toBe(true);

      const dataCall = mockArchive.append.mock.calls.find(
        (call: unknown[]) => (call[1] as { name: string }).name.includes('data.json')
      );
      const portable = JSON.parse(dataCall![0] as string);
      expect(portable['@context']).toBe('https://schema.org');
    });

    it('appends personalization.json when personalization data exists', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue({
        ...mockUserData,
        personalization: { bio: 'test', writingStyle: null, rules: null, enabled: true, createdAt: new Date(), updatedAt: new Date() },
      } as never);

      await GET(createRequest());

      const appendCalls = mockArchive.append.mock.calls.map(
        (call: unknown[]) => (call[1] as { name: string }).name
      );
      expect(appendCalls.some((n: string) => n.includes('personalization.json'))).toBe(true);
      // One more file than the null-personalization case — asserted as a
      // DELTA rather than a hardcoded total, so a category added to the bundle
      // does not silently re-pin this count either.
      const withoutPersonalization = buildNativeExportFiles(mockUserData as never).length;
      expect(mockArchive.append).toHaveBeenCalledTimes(withoutPersonalization + 1 + 1);
    });

    it('calls archive.finalize()', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      expect(mockArchive.finalize).toHaveBeenCalledTimes(1);
    });

    it('does not reset rate limit on successful export', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      expect(resetDistributedRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 86400,
        attemptsRemaining: 0,
      });

      const response = await GET(createRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Export rate limit exceeded. You can request one export per 24 hours.');
      expect(response.headers.get('Retry-After')).toBe('86400');
    });

    it('calls checkDistributedRateLimit with correct key and config', async () => {
      vi.mocked(collectAllUserData).mockResolvedValue(mockUserData as never);

      await GET(createRequest());

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'export:user:user-1',
        expect.objectContaining({
          maxAttempts: 1,
          windowMs: 24 * 60 * 60 * 1000,
        })
      );
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

    it('resets rate limit on 500 so user can retry', async () => {
      vi.mocked(collectAllUserData).mockRejectedValueOnce(new Error('DB error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await GET(createRequest());
      consoleSpy.mockRestore();

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('export:user:user-1');
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
