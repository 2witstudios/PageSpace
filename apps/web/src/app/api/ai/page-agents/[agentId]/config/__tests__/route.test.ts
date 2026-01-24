/**
 * Contract tests for PUT /api/ai/page-agents/[agentId]/config
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PUT } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { PageOperation } from '@/lib/websocket';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/page-agent-repository', () => ({
  pageAgentRepository: {
    getAgentById: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock permissions (boundary)
vi.mock('@pagespace/lib/server', () => ({
  canUserEditPage: vi.fn(),
  agentAwarenessCache: {
    invalidateDriveAgents: vi.fn(),
  },
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
    },
  },
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
vi.mock('@/lib/ai/core', () => ({
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
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { applyPageMutation } from '@/services/api/page-mutation-service';

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
  isTrashed: boolean;
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
  isTrashed: overrides.isTrashed ?? false,
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

    it('should invalidate cache when agentDefinition changes', async () => {
      const request = createRequest(mockAgentId, {
        agentDefinition: 'New definition',
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('should invalidate cache when visibleToGlobalAssistant changes', async () => {
      const request = createRequest(mockAgentId, {
        visibleToGlobalAssistant: false,
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('should NOT invalidate cache when only systemPrompt changes', async () => {
      const request = createRequest(mockAgentId, {
        systemPrompt: 'New prompt',
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(agentAwarenessCache.invalidateDriveAgents).not.toHaveBeenCalled();
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
