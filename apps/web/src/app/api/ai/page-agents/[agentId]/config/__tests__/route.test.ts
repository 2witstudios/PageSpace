/**
 * Contract tests for PUT /api/ai/page-agents/[agentId]/config
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PUT } from '../route';
import type { PageOperation } from '@/lib/websocket';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/page-agent-repository', () => ({
  pageAgentRepository: {
    getAgentById: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isScopedMCPAuth: (auth: { tokenType?: string; allowedDriveIds?: string[] }) =>
    auth?.tokenType === 'mcp' && (auth.allowedDriveIds?.length ?? 0) > 0,
  canPrincipalEditPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  }),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

// Mock websocket broadcast (boundary)
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn((
    driveId: string,
    pageId: string,
    operation: PageOperation,
    data: { parentId?: string | null; title?: string; type?: string; socketId?: string }
  ) => ({
    driveId,
    pageId,
    operation,
    ...data,
  })),
}));

// Mock AI tools for validation
vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    read_page: {},
    list_pages: {},
    create_page: {},
    update_page: {},
    delete_page: {},
  },
}));

vi.mock('@/services/api/page-mutation-service', () => ({
  applyPageMutation: vi.fn(),
  PageRevisionMismatchError: class PageRevisionMismatchError extends Error {
    currentRevision: number;
    expectedRevision?: number;

    constructor(message: string, currentRevision: number, expectedRevision?: number) {
      super(message);
      this.currentRevision = currentRevision;
      this.expectedRevision = expectedRevision;
    }
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
}));

import { pageAgentRepository } from '@/lib/repositories/page-agent-repository';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { applyPageMutation } from '@/services/api/page-mutation-service';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';

// Test fixtures
const mockUserId = 'user_123';
const mockAgentId = 'agent_123';
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

const mockAgent = (overrides: Partial<{
  id: string;
  type: string;
  driveId: string;
  parentId: string | null;
  title: string;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
  toolExposureMode: 'upfront' | 'search' | null;
  isTrashed: boolean;
  terminalAccess: boolean;
  machines: Array<{ kind: 'own' } | { kind: 'existing'; machineId: string }>;
}> = {}) => ({
  id: overrides.id ?? mockAgentId,
  type: overrides.type ?? 'AI_CHAT',
  driveId: overrides.driveId ?? mockDriveId,
  parentId: overrides.parentId ?? null,
  title: overrides.title ?? 'Test Agent',
  systemPrompt: overrides.systemPrompt ?? 'You are helpful.',
  enabledTools: overrides.enabledTools ?? ['read_page'],
  aiProvider: overrides.aiProvider ?? 'openrouter',
  aiModel: overrides.aiModel ?? 'claude-3-opus',
  toolExposureMode: overrides.toolExposureMode ?? 'upfront',
  isTrashed: overrides.isTrashed ?? false,
  terminalAccess: overrides.terminalAccess ?? false,
  machines: overrides.machines ?? [],
});

const createRequest = (agentId: string, body: Record<string, unknown>) =>
  new Request(`https://example.com/api/ai/page-agents/${agentId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const createContext = (agentId: string) => ({
  params: Promise.resolve({ agentId }),
});

describe('PUT /api/ai/page-agents/[agentId]/config', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: MCP scope check passes (returns null = allowed)
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);

    // Default: agent exists
    vi.mocked(pageAgentRepository.getAgentById).mockResolvedValue(mockAgent());

    // Default: update succeeds
    vi.mocked(applyPageMutation).mockResolvedValue({
      pageId: mockAgentId,
      driveId: mockDriveId,
      nextRevision: 1,
      stateHashBefore: 'state_before',
      stateHashAfter: 'state_after',
      contentRefBefore: null,
      contentRefAfter: null,
      contentFormatBefore: 'html',
      contentFormatAfter: 'html',
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);

      expect(response.status).toBe(401);
    });
  });

  describe('resource not found', () => {
    it('should return 404 when agent does not exist', async () => {
      vi.mocked(pageAgentRepository.getAgentById).mockResolvedValue(null);

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('not found');
      // Verify no update was attempted
      expect(applyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('should return 400 when page is not AI_CHAT type', async () => {
      vi.mocked(pageAgentRepository.getAgentById).mockResolvedValue(
        mockAgent({ type: 'DOCUMENT' })
      );

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('not an AI agent');
    });

    it('should return 400 when no valid fields provided', async () => {
      const request = createRequest(mockAgentId, {});
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('No valid fields');
    });

    it('should return 400 when enabledTools contains invalid tools', async () => {
      const request = createRequest(mockAgentId, {
        enabledTools: ['invalid_tool', 'read_page'],
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tools');
      expect(body.error).toContain('invalid_tool');
    });

    it('should return 400 when enabledTools is not an array, null, or undefined', async () => {
      const request = createRequest(mockAgentId, {
        enabledTools: 'read_page',
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('enabledTools');
      expect(applyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
      // Verify no update was attempted
      expect(applyPageMutation).not.toHaveBeenCalled();
    });
  });

  describe('successful updates', () => {
    it('should scrub removed tool names from submitted enabledTools', async () => {
      const request = createRequest(mockAgentId, {
        enabledTools: ['import_from_github', 'read_page'],
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            enabledTools: ['read_page'],
          }),
          updatedFields: expect.arrayContaining(['enabledTools']),
        })
      );
      expect(body.agentConfig.enabledTools).toEqual(['read_page']);
    });

    it('should scrub removed tool names from persisted enabledTools when updating other fields', async () => {
      vi.mocked(pageAgentRepository.getAgentById).mockResolvedValue(
        mockAgent({ enabledTools: ['import_from_github', 'read_page'] })
      );

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            enabledTools: ['read_page'],
          }),
          updatedFields: expect.arrayContaining(['systemPrompt', 'enabledTools']),
        })
      );
      expect(body.agentConfig.enabledTools).toEqual(['read_page']);
      expect(body.updatedFields).toEqual(expect.arrayContaining(['systemPrompt', 'enabledTools']));
    });

    it('should update systemPrompt and return success', async () => {
      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.updatedFields).toContain('systemPrompt');
    });

    it('should pass correct data to mutation service', async () => {
      const request = createRequest(mockAgentId, {
        systemPrompt: 'New prompt',
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'google',
        aiModel: 'gemini-pro',
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockAgentId,
          operation: 'agent_config_update',
          updates: expect.objectContaining({
            systemPrompt: 'New prompt',
            enabledTools: ['read_page', 'list_pages'],
            aiProvider: 'google',
            aiModel: 'gemini-pro',
          }),
          updatedFields: expect.arrayContaining(['systemPrompt', 'enabledTools', 'aiProvider', 'aiModel']),
        })
      );
    });

    it('should update agentDefinition', async () => {
      const request = createRequest(mockAgentId, {
        agentDefinition: 'This agent helps with code review',
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('agentDefinition');
    });

    it('should update visibleToGlobalAssistant', async () => {
      const request = createRequest(mockAgentId, {
        visibleToGlobalAssistant: true,
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('visibleToGlobalAssistant');
    });

    it('should update toolExposureMode to "search"', async () => {
      const request = createRequest(mockAgentId, {
        toolExposureMode: 'search',
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('toolExposureMode');
      expect(applyPageMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({ toolExposureMode: 'search' }),
        })
      );
    });

    it('should return 400 for an invalid toolExposureMode value', async () => {
      const request = createRequest(mockAgentId, {
        toolExposureMode: 'invalid',
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);

      expect(response.status).toBe(400);
      expect(applyPageMutation).not.toHaveBeenCalled();
    });

    it('should update multiple fields at once', async () => {
      const request = createRequest(mockAgentId, {
        systemPrompt: 'New prompt',
        enabledTools: ['read_page'],
        aiProvider: 'google',
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      // Assert explicit fields rather than just count for resilience to future additions
      expect(body.updatedFields).toEqual(
        expect.arrayContaining(['systemPrompt', 'enabledTools', 'aiProvider'])
      );
      expect(body.updatedFields.length).toBe(3);
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast page update event with correct payload', async () => {
      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        mockAgentId,
        'updated',
        expect.objectContaining({
          title: 'Test Agent',
          type: 'AI_CHAT',
        })
      );
      // Verify broadcastPageEvent is called with the payload from createPageEventPayload
      const expectedPayload = vi.mocked(createPageEventPayload).mock.results[0]?.value;
      expect(broadcastPageEvent).toHaveBeenCalledWith(expectedPayload);
    });

  });

  describe('error handling', () => {
    it('should return 500 when mutation throws', async () => {
      vi.mocked(applyPageMutation).mockRejectedValue(new Error('Database error'));

      const request = createRequest(mockAgentId, { systemPrompt: 'New prompt' });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to update');
    });
  });
});
