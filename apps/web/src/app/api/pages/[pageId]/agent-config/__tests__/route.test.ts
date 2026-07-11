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
  mockGetUserAccessiblePagesInDrive,
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
    mockGetUserAccessiblePagesInDrive: vi.fn().mockResolvedValue([]),
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
  // The route authorizes via the principal dispatch (scoped tokens use their own
  // role); tests drive it through the same mock as the old user-level check.
  canPrincipalEditPage: (...args: unknown[]) => mockCanUserEditPage(...args),
  isScopedMCPAuth: (auth: { tokenType?: string; allowedDriveIds?: string[] }) =>
    auth?.tokenType === 'mcp' && (auth.allowedDriveIds?.length ?? 0) > 0,
}));

vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    read_page: { description: 'Read a page' },
    write_page: { description: 'Write a page' },
    search: { description: 'Search pages' },
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id' },
  drives: { id: 'id', drivePrompt: 'drivePrompt' },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: (...args: unknown[]) => mockCanUserEditPage(...args),
    getUserAccessiblePagesInDrive: (...args: unknown[]) => mockGetUserAccessiblePagesInDrive(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: mockLoggers,

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
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
  aiModel: 'anthropic/claude-haiku-4.5',
  includeDrivePrompt: true,
  agentDefinition: 'Agent definition text',
  visibleToGlobalAssistant: true,
  includePageTree: false,
  pageTreeScope: 'children',
  toolExposureMode: 'search',
  terminalAccess: true,
  machines: [{ kind: 'own' }],
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
    mockGetUserAccessiblePagesInDrive.mockResolvedValue([]);
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
      expect(body.aiModel).toBe('anthropic/claude-haiku-4.5');
      expect(body.includeDrivePrompt).toBe(true);
      expect(body.drivePrompt).toBe('Drive system prompt');
      expect(body.agentDefinition).toBe('Agent definition text');
      expect(body.visibleToGlobalAssistant).toBe(true);
      expect(body.includePageTree).toBe(false);
      expect(body.pageTreeScope).toBe('children');
      expect(body.toolExposureMode).toBe('search');
      expect(body.terminalAccess).toBe(true);
      expect(body.machines).toEqual([{ kind: 'own' }]);
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
          terminalAccess: null,
          machines: null,
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
      expect(body.terminalAccess).toBe(false);
      expect(body.machines).toEqual([]);
    });

    it('back-reads a pre-existing config (fields absent entirely) with terminal defaults', async () => {
      // A row created before this PR has no terminalAccess/machines columns
      // populated yet — undefined, not null, until backfilled.
      const { terminalAccess: _terminalAccess, machines: _machines, ...legacyPage } = mockPage;
      setupGetSelectChain([legacyPage], [{ drivePrompt: null }]);

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.terminalAccess).toBe(false);
      expect(body.machines).toEqual([]);
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

    it('returns an empty availableTerminals list by default', async () => {
      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(body.availableTerminals).toEqual([]);
    });

    it('returns configured terminalAccess and machines', async () => {
      setupGetSelectChain(
        [{ ...mockPage, terminalAccess: true, machines: [{ kind: 'own' }] }],
        [{ drivePrompt: 'Drive system prompt' }]
      );

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(body.terminalAccess).toBe(true);
      expect(body.machines).toEqual([{ kind: 'own' }]);
    });

    it('returns availableTerminals filtered to MACHINE pages the user can access', async () => {
      mockGetUserAccessiblePagesInDrive.mockResolvedValue(['term_1', 'term_2']);
      let callCount = 0;
      mockDbSelect.mockImplementation(() => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockPage]); // page fetch
            if (callCount === 2) {
              return { limit: () => Promise.resolve([{ drivePrompt: 'Drive system prompt' }]) }; // drive fetch
            }
            return Promise.resolve([{ id: 'term_1', title: 'Terminal One' }]); // terminal listing
          },
        }),
      }));

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(body.availableTerminals).toEqual([{ id: 'term_1', title: 'Terminal One' }]);
    });

    it('returns an empty availableTerminals list when the accessible-pages lookup throws', async () => {
      mockGetUserAccessiblePagesInDrive.mockRejectedValue(new Error('permissions error'));

      const response = await GET(createGetRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.availableTerminals).toEqual([]);
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
    mockGetUserAccessiblePagesInDrive.mockResolvedValue([]);
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

    it('nullifies empty aiProvider after trim (provider+model cleared together)', async () => {
      // A model can't be stored without a provider, so clearing the provider clears
      // the model too — the UI always sends both fields together.
      await PATCH(createPatchRequest({ aiProvider: '', aiModel: '' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiProvider: null,
            aiModel: null,
          }),
        })
      );
    });

    it('updates aiModel (trims whitespace)', async () => {
      await PATCH(createPatchRequest({ aiModel: '  anthropic/claude-haiku-4.5  ' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            aiModel: 'anthropic/claude-haiku-4.5',
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

    it('updates terminalAccess as boolean', async () => {
      await PATCH(createPatchRequest({ terminalAccess: 1 }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            terminalAccess: true,
          }),
        })
      );
    });

    it('updates machines with a valid MachineRef array', async () => {
      // Own-machine entries only — the "existing" machineId path (which also
      // needs an accessibility check) is covered in "machines validation" below.
      const machines = [{ kind: 'own' }];
      await PATCH(createPatchRequest({ machines }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            machines,
          }),
        })
      );
    });

    it('preserves an empty machines array', async () => {
      await PATCH(createPatchRequest({ machines: [] }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            machines: [],
          }),
        })
      );
    });

    it('returns 400 for a malformed machines array and does not mutate', async () => {
      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'existing' }] }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/machines/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('returns 400 when machines is not an array', async () => {
      const response = await PATCH(
        createPatchRequest({ machines: { kind: 'own' } }),
        mockParams
      );

      expect(response.status).toBe(400);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
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

    it('updates toolExposureMode with valid value "upfront"', async () => {
      await PATCH(createPatchRequest({ toolExposureMode: 'upfront' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            toolExposureMode: 'upfront',
          }),
        })
      );
    });

    it('updates toolExposureMode with valid value "search"', async () => {
      await PATCH(createPatchRequest({ toolExposureMode: 'search' }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            toolExposureMode: 'search',
          }),
        })
      );
    });

    it('ignores invalid toolExposureMode values', async () => {
      await PATCH(createPatchRequest({ toolExposureMode: 'invalid' }), mockParams);

      // Invalid value is not persisted, and with no other fields no mutation occurs
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

    it('updates terminalAccess as boolean', async () => {
      await PATCH(createPatchRequest({ terminalAccess: 1 }), mockParams);

      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            terminalAccess: true,
          }),
        })
      );
    });
  });

  describe('machines validation', () => {
    it('returns 400 for malformed machine entries', async () => {
      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'bogus' }] }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/machines must be an array/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('returns 400 when machines is not an array', async () => {
      const response = await PATCH(
        createPatchRequest({ machines: 'not-an-array' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/machines must be an array/i);
    });

    it('accepts an own-machine entry with no extra DB lookup', async () => {
      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'own' }] }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            machines: [{ kind: 'own' }],
          }),
        })
      );
    });

    it('updates machines when an existing machineId resolves to a MACHINE page the user can access', async () => {
      mockGetUserAccessiblePagesInDrive.mockResolvedValue(['term_1']);
      let callCount = 0;
      mockDbSelect.mockImplementation(() => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockPage]); // page fetch
            if (callCount === 2) return Promise.resolve([{ id: 'term_1' }]); // terminal validation
            return { limit: () => Promise.resolve([{ ...mockPage, machines: [{ kind: 'existing', machineId: 'term_1' }] }]) }; // refetch
          },
        }),
      }));

      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'own' }, { kind: 'existing', machineId: 'term_1' }] }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            machines: [{ kind: 'own' }, { kind: 'existing', machineId: 'term_1' }],
          }),
        })
      );
    });

    it('returns 400 when an existing machine references a terminal that cannot be found', async () => {
      mockGetUserAccessiblePagesInDrive.mockResolvedValue(['missing_term']);
      let callCount = 0;
      mockDbSelect.mockImplementation(() => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockPage]); // page fetch
            return Promise.resolve([]); // terminal validation finds nothing
          },
        }),
      }));

      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'existing', machineId: 'missing_term' }] }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/invalid terminal reference/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('returns 400 when an existing machine references a real MACHINE page the user cannot access', async () => {
      // getUserAccessiblePagesInDrive resolves without this machineId — the page
      // exists (and the DB query would find it) but is outside the user's access.
      mockGetUserAccessiblePagesInDrive.mockResolvedValue([]);
      let callCount = 0;
      mockDbSelect.mockImplementation(() => ({
        from: () => ({
          where: () => {
            callCount++;
            if (callCount === 1) return Promise.resolve([mockPage]); // page fetch
            return Promise.resolve([{ id: 'other_drive_term' }]); // terminal exists, but inaccessible
          },
        }),
      }));

      const response = await PATCH(
        createPatchRequest({ machines: [{ kind: 'existing', machineId: 'other_drive_term' }] }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/invalid terminal reference/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('returns 400 when machines exceeds the maximum length', async () => {
      const machines = Array.from({ length: 21 }, () => ({ kind: 'own' as const }));
      const response = await PATCH(createPatchRequest({ machines }), mockParams);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/machines must be an array/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('model validation', () => {
    it('returns 400 for a hallucinated model id', async () => {
      const response = await PATCH(
        createPatchRequest({ aiProvider: 'openai', aiModel: 'openai/gpt-6-ultra' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not a valid model/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('accepts a valid catalog model id', async () => {
      const response = await PATCH(
        createPatchRequest({ aiProvider: 'openai', aiModel: 'openai/gpt-5.3-chat' }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockApplyPageMutation).toHaveBeenCalled();
    });

    it('returns 400 when only a bad aiModel is sent (validated against stored provider)', async () => {
      // mockPage.aiProvider is "anthropic"; the bad model resolves against it.
      const response = await PATCH(
        createPatchRequest({ aiModel: 'anthropic/not-real' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/not a valid model/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
    });

    it('returns 400 for a model set without a provider (no provider to validate against)', async () => {
      const response = await PATCH(
        createPatchRequest({ aiProvider: '', aiModel: 'openai/gpt-6-ultra' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toMatch(/provider/i);
      expect(mockApplyPageMutation).not.toHaveBeenCalled();
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

    it('round-trips terminalAccess and machines in the response', async () => {
      // Own-machine entries only — the "existing" machineId path is covered
      // in "machines validation" below.
      const machines = [{ kind: 'own' }];
      setupPatchSelectChain(
        [mockPage],
        [{ ...mockPage, terminalAccess: true, machines }]
      );

      const response = await PATCH(
        createPatchRequest({ terminalAccess: true, machines }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.terminalAccess).toBe(true);
      expect(body.machines).toEqual(machines);
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
