/**
 * Contract tests for GET/PATCH/PUT /api/pages/[pageId]/agent-config
 *
 * These tests verify the route handler's contract:
 * - Authentication, MCP scope, and permission checks
 * - GET: returns page AI configuration with available tools
 * - PATCH: validates and updates page AI configuration fields
 * - PUT: alias for PATCH
 * - Tool validation against available tools
 * - PageRevisionMismatchError handling (409 and 428)
 * - Error handling
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockApplyPageMutation,
  mockAuthenticateRequest,
  mockIsAuthError,
  mockCheckMCPPageScope,
  mockCanUserEditPage,
  mockDbSelect,
  mockGetActorInfo,
  mockLoggers,
  MockPageRevisionMismatchError,
} = vi.hoisted(() => {
  class _MockPageRevisionMismatchError extends Error {
    currentRevision: number;
    expectedRevision?: number;
    constructor(message: string, currentRevision: number, expectedRevision?: number) {
      super(message);
      this.currentRevision = currentRevision;
      this.expectedRevision = expectedRevision;
    }
  }

  return {
    mockApplyPageMutation: vi.fn(),
    mockAuthenticateRequest: vi.fn(),
    mockIsAuthError: vi.fn((result: unknown) => result != null && typeof result === 'object' && 'error' in result),
    mockCheckMCPPageScope: vi.fn().mockResolvedValue(null),
    mockCanUserEditPage: vi.fn(),
    mockDbSelect: vi.fn(),
    mockGetActorInfo: vi.fn().mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    }),
    mockLoggers: {
      api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
    MockPageRevisionMismatchError: _MockPageRevisionMismatchError,
  };
});

// ── vi.mock declarations ───────────────────────────────────────────────────

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: (...args: unknown[]) => mockApplyPageMutation(...args),
  PageRevisionMismatchError: MockPageRevisionMismatchError,
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: (...args: unknown[]) => mockAuthenticateRequest(...args),
  isAuthError: (result: unknown) => mockIsAuthError(result),
  checkMCPPageScope: (...args: unknown[]) => mockCheckMCPPageScope(...args),
}));

vi.mock('@/lib/ai/core', () => ({
  pageSpaceTools: {
    read_page: { description: 'Read a page' },
    write_page: { description: 'Write a page' },
    search: { description: 'Search pages' },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
  eq: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: (...args: unknown[]) => mockCanUserEditPage(...args),
  loggers: mockLoggers,
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: (...args: unknown[]) => mockGetActorInfo(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import { GET, PATCH, PUT } from '../../agent-config/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const mockUserId = 'user_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
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

const createGetRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/agent-config`, {
    method: 'GET',
  });

const createPatchRequest = (body: Record<string, unknown>) =>
  new Request(`https://example.com/api/pages/${mockPageId}/agent-config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

const mockPage = {
  id: mockPageId,
  driveId: mockDriveId,
  type: 'AI_CHAT',
  systemPrompt: 'You are helpful',
  enabledTools: ['read_page'],
  aiProvider: 'anthropic',
  aiModel: 'claude-3',
  includeDrivePrompt: true,
  agentDefinition: 'Agent definition text',
  visibleToGlobalAssistant: true,
  includePageTree: false,
  pageTreeScope: 'children',
  revision: 5,
};

/**
 * Sets up the select chain for GET requests (page query + drive query).
 */
function setupGetSelectChain(pageResult: unknown[], driveResult: unknown[]) {
  let callCount = 0;
  mockDbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(pageResult);
        }
        // drive query has a limit chain
        return {
          limit: () => Promise.resolve(driveResult),
        };
      },
    }),
  }));
}

/**
 * Sets up the select chain for PATCH requests (page query + refetch after update).
 */
function setupPatchSelectChain(pageResult: unknown[], updatedPageResult: unknown[]) {
  let callCount = 0;
  mockDbSelect.mockImplementation(() => ({
    from: () => ({
      where: () => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(pageResult);
        }
        // refetch query has a limit chain
        return {
          limit: () => Promise.resolve(updatedPageResult),
        };
      },
    }),
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/pages/[pageId]/agent-config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockIsAuthError.mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    mockCheckMCPPageScope.mockResolvedValue(null);
    mockCanUserEditPage.mockResolvedValue(true);
    mockGetActorInfo.mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
    setupGetSelectChain([mockPage], [{ drivePrompt: 'Drive system prompt' }]);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest(), mockParams);

      expect(response.status).toBe(401);
    });
  });

  describe('MCP scope checking', () => {
    it('returns scope error when MCP token lacks page scope', async () => {
      mockCheckMCPPageScope.mockResolvedValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const response = await GET(createGetRequest(), mockParams);

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });
  });

  describe('page not found', () => {
    it('returns 404 when page does not exist', async () => {
      setupGetSelectChain([], []);

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('successful response', () => {
    it('returns page agent configuration with all fields', async () => {
      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.pageId).toBe(mockPageId);
      expect(body.systemPrompt).toBe('You are helpful');
      expect(body.enabledTools).toEqual(['read_page']);
      expect(body.aiProvider).toBe('anthropic');
      expect(body.aiModel).toBe('claude-3');
      expect(body.includeDrivePrompt).toBe(true);
      expect(body.drivePrompt).toBe('Drive system prompt');
      expect(body.agentDefinition).toBe('Agent definition text');
      expect(body.visibleToGlobalAssistant).toBe(true);
      expect(body.includePageTree).toBe(false);
      expect(body.pageTreeScope).toBe('children');
    });

    it('returns available tools list', async () => {
      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(body.availableTools).toEqual([
        { name: 'read_page', description: 'Read a page' },
        { name: 'write_page', description: 'Write a page' },
        { name: 'search', description: 'Search pages' },
      ]);
    });

    it('returns defaults for null fields', async () => {
      setupGetSelectChain(
        [{
          ...mockPage,
          systemPrompt: null,
          enabledTools: null,
          aiProvider: null,
          aiModel: null,
          includeDrivePrompt: null,
          agentDefinition: null,
          visibleToGlobalAssistant: null,
          includePageTree: null,
          pageTreeScope: null,
        }],
        [{ drivePrompt: null }]
      );

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(body.systemPrompt).toBe('');
      expect(body.enabledTools).toEqual([]);
      expect(body.aiProvider).toBe('');
      expect(body.aiModel).toBe('');
      expect(body.includeDrivePrompt).toBe(false);
      expect(body.drivePrompt).toBeNull();
      expect(body.agentDefinition).toBe('');
      expect(body.visibleToGlobalAssistant).toBe(true);
      expect(body.includePageTree).toBe(false);
      expect(body.pageTreeScope).toBe('children');
    });

    it('handles drive prompt fetch error gracefully', async () => {
      let callCount = 0;
      mockDbSelect.mockImplementation(() => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve([mockPage]);
            }
            // drive query throws
            return {
              limit: () => Promise.reject(new Error('Drive fetch error')),
            };
          },
        }),
      }));

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.drivePrompt).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns 500 for unexpected errors', async () => {
      mockAuthenticateRequest.mockRejectedValueOnce(new Error('Unexpected'));

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});

describe('PATCH /api/pages/[pageId]/agent-config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth(mockUserId));
    mockIsAuthError.mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    mockCheckMCPPageScope.mockResolvedValue(null);
    mockCanUserEditPage.mockResolvedValue(true);
    mockGetActorInfo.mockResolvedValue({
      actorEmail: 'test@example.com',
      actorDisplayName: 'Test User',
    });
    setupPatchSelectChain([mockPage], [{
      ...mockPage,
      systemPrompt: 'Updated prompt',
    }]);
    mockApplyPageMutation.mockResolvedValue({});
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );

      expect(response.status).toBe(401);
    });
  });

  describe('MCP scope checking', () => {
    it('returns scope error when MCP token lacks page scope', async () => {
      mockCheckMCPPageScope.mockResolvedValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );

      expect(response.status).toBe(403);
    });
  });

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });
  });

  describe('page not found', () => {
    it('returns 404 when page does not exist', async () => {
      setupPatchSelectChain([], []);

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('tool validation', () => {
    it('returns 400 for invalid tools', async () => {
      const response = await PATCH(
        createPatchRequest({ enabledTools: ['invalid_tool', 'read_page'] }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/invalid_tool/i);
    });

    it('accepts valid tools', async () => {
      const response = await PATCH(
        createPatchRequest({ enabledTools: ['read_page', 'write_page'] }),
        mockParams
      );

      expect(response.status).toBe(200);
    });

    it('skips tool validation when enabledTools is not an array', async () => {
      // non-array enabledTools should skip validation and be set to null
      const response = await PATCH(
        createPatchRequest({ enabledTools: 'not-an-array' }),
        mockParams
      );

      expect(response.status).toBe(200);
    });
  });

  describe('update fields', () => {
    it('updates systemPrompt (trims whitespace)', async () => {
      await PATCH(createPatchRequest({ systemPrompt: '  prompt  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            systemPrompt: 'prompt',
          }),
        })
      );
    });

    it('nullifies empty systemPrompt after trim', async () => {
      await PATCH(createPatchRequest({ systemPrompt: '   ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            systemPrompt: null,
          }),
        })
      );
    });

    it('preserves empty arrays for enabledTools', async () => {
      await PATCH(createPatchRequest({ enabledTools: [] }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            enabledTools: [],
          }),
        })
      );
    });

    it('sets enabledTools to null for non-array values', async () => {
      await PATCH(createPatchRequest({ enabledTools: 'not-array' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            enabledTools: null,
          }),
        })
      );
    });

    it('updates aiProvider (trims whitespace)', async () => {
      await PATCH(createPatchRequest({ aiProvider: '  anthropic  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiProvider: 'anthropic',
          }),
        })
      );
    });

    it('nullifies empty aiProvider after trim', async () => {
      await PATCH(createPatchRequest({ aiProvider: '' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiProvider: null,
          }),
        })
      );
    });

    it('updates aiModel (trims whitespace)', async () => {
      await PATCH(createPatchRequest({ aiModel: '  claude-3  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiModel: 'claude-3',
          }),
        })
      );
    });

    it('nullifies empty aiModel after trim', async () => {
      await PATCH(createPatchRequest({ aiModel: '' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiModel: null,
          }),
        })
      );
    });

    it('updates includeDrivePrompt as boolean', async () => {
      await PATCH(createPatchRequest({ includeDrivePrompt: 1 }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            includeDrivePrompt: true,
          }),
        })
      );
    });

    it('updates agentDefinition (trims whitespace)', async () => {
      await PATCH(createPatchRequest({ agentDefinition: '  agent def  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            agentDefinition: 'agent def',
          }),
        })
      );
    });

    it('nullifies empty agentDefinition after trim', async () => {
      await PATCH(createPatchRequest({ agentDefinition: '  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            agentDefinition: null,
          }),
        })
      );
    });

    it('updates visibleToGlobalAssistant as boolean', async () => {
      await PATCH(createPatchRequest({ visibleToGlobalAssistant: false }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            visibleToGlobalAssistant: false,
          }),
        })
      );
    });

    it('updates includePageTree as boolean', async () => {
      await PATCH(createPatchRequest({ includePageTree: true }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            includePageTree: true,
          }),
        })
      );
    });

    it('updates pageTreeScope with valid value "children"', async () => {
      await PATCH(createPatchRequest({ pageTreeScope: 'children' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            pageTreeScope: 'children',
          }),
        })
      );
    });

    it('updates pageTreeScope with valid value "drive"', async () => {
      await PATCH(createPatchRequest({ pageTreeScope: 'drive' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            pageTreeScope: 'drive',
          }),
        })
      );
    });

    it('ignores invalid pageTreeScope values', async () => {
      await PATCH(createPatchRequest({ pageTreeScope: 'invalid' }), mockParams);

      // pageTreeScope should not be in the updates since the value was invalid
      // and no other fields were passed, so no mutation should occur
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('passes expectedRevision when provided as number', async () => {
      await PATCH(
        createPatchRequest({ systemPrompt: 'test', expectedRevision: 5 }),
        mockParams
      );

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: 5,
        })
      );
    });

    it('passes undefined expectedRevision when not a number', async () => {
      await PATCH(
        createPatchRequest({ systemPrompt: 'test', expectedRevision: 'not-a-number' }),
        mockParams
      );

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: undefined,
        })
      );
    });
  });

  describe('no changes', () => {
    it('returns success without calling applyPageMutation when no recognized fields are present', async () => {
      const response = await PATCH(
        createPatchRequest({}),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('revision mismatch', () => {
    it('returns 409 when expected revision does not match', async () => {
      mockApplyPageMutation.mockRejectedValueOnce(
        new MockPageRevisionMismatchError('Revision mismatch', 10, 5)
      );

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test', expectedRevision: 5 }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/revision/i);
      expect(body.currentRevision).toBe(10);
      expect(body.expectedRevision).toBe(5);
    });

    it('returns 428 when expectedRevision is undefined', async () => {
      mockApplyPageMutation.mockRejectedValueOnce(
        new MockPageRevisionMismatchError('Revision required', 10, undefined)
      );

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(428);
      expect(body.currentRevision).toBe(10);
    });
  });

  describe('refetch after update', () => {
    it('uses updated page data in response', async () => {
      setupPatchSelectChain(
        [mockPage],
        [{ ...mockPage, systemPrompt: 'Updated prompt' }]
      );

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'Updated prompt' }),
        mockParams
      );
      const body = await response.json();

      expect(body.systemPrompt).toBe('Updated prompt');
    });

    it('falls back to original page when refetch returns empty', async () => {
      setupPatchSelectChain([mockPage], []);

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'Updated prompt' }),
        mockParams
      );
      const body = await response.json();

      // Falls back to original page data
      expect(body.systemPrompt).toBe('You are helpful');
    });
  });

  describe('error handling', () => {
    it('returns 500 for unexpected errors', async () => {
      mockAuthenticateRequest.mockRejectedValueOnce(new Error('Unexpected'));

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('rethrows non-PageRevisionMismatchError from applyPageMutation', async () => {
      mockApplyPageMutation.mockRejectedValueOnce(new Error('DB error'));

      const response = await PATCH(
        createPatchRequest({ systemPrompt: 'test' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});

describe('PUT /api/pages/[pageId]/agent-config', () => {
  it('is the same function as PATCH', () => {
    expect(PUT).toBe(PATCH);
  });
});
