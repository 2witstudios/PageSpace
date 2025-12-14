import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PUT } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const returningMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  return {
    db: {
      select: selectMock,
      update: updateMock,
    },
    pages: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  canUserEditPage: vi.fn(),
  agentAwarenessCache: {
    invalidateDriveAgents: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({ type: 'updated' })),
}));

vi.mock('@/lib/ai/core', () => ({
  pageSpaceTools: {
    read_page: {},
    list_pages: {},
    create_page: {},
    update_page: {},
    delete_page: {},
  },
}));

import { db } from '@pagespace/db';
import { loggers, canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { broadcastPageEvent } from '@/lib/websocket';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock agent page
const mockAgent = (overrides: Partial<{
  id: string;
  title: string;
  type: string;
  driveId: string;
  parentId: string | null;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
}> = {}) => ({
  id: overrides.id || 'agent_123',
  title: overrides.title || 'Test Agent',
  type: overrides.type || 'AI_CHAT',
  driveId: overrides.driveId || 'drive_123',
  parentId: overrides.parentId ?? null,
  systemPrompt: overrides.systemPrompt ?? 'You are a helpful assistant.',
  enabledTools: overrides.enabledTools ?? [],
  aiProvider: overrides.aiProvider ?? null,
  aiModel: overrides.aiModel ?? null,
});

describe('PUT /api/ai/page-agents/[agentId]/config', () => {
  const mockUserId = 'user_123';
  const mockAgentId = 'agent_123';

  // Helper to setup select mock for agent
  const setupAgentSelectMock = (agent: ReturnType<typeof mockAgent> | undefined) => {
    const whereMock = vi.fn().mockResolvedValue(agent ? [agent] : []);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup update mock
  const setupUpdateMock = (updatedAgent: ReturnType<typeof mockAgent>) => {
    const returningMock = vi.fn().mockResolvedValue([updatedAgent]);
    const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock, returningMock };
  };

  const createContext = (agentId: string) => ({
    params: Promise.resolve({ agentId }),
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default agent exists
    setupAgentSelectMock(mockAgent());
    setupUpdateMock(mockAgent());
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'Updated prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      expect(response.status).toBe(401);
    });
  });

  describe('agent not found', () => {
    it('should return 404 when agent does not exist', async () => {
      setupAgentSelectMock(undefined);

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'Updated prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('Agent with ID');
      expect(body.error).toContain('not found');
    });
  });

  describe('page type validation', () => {
    it('should return 400 when page is not AI_CHAT type', async () => {
      setupAgentSelectMock(mockAgent({ type: 'DOCUMENT' }));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'Updated prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('not an AI agent');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user lacks edit permission', async () => {
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'Updated prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('validation', () => {
    it('should return 400 when no fields provided for update', async () => {
      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({}),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('No valid fields');
    });

    it('should return 400 when enabledTools contains invalid tools', async () => {
      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          enabledTools: ['invalid_tool', 'read_page'],
        }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tools specified');
    });
  });

  describe('successful updates', () => {
    it('should update systemPrompt', async () => {
      const { setMock } = setupUpdateMock(mockAgent({ systemPrompt: 'New prompt' }));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'New prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.updatedFields).toContain('systemPrompt');
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'New prompt',
        })
      );
    });

    it('should update enabledTools', async () => {
      const { setMock } = setupUpdateMock(mockAgent({ enabledTools: ['read_page', 'list_pages'] }));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ enabledTools: ['read_page', 'list_pages'] }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('enabledTools');
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          enabledTools: ['read_page', 'list_pages'],
        })
      );
    });

    it('should update aiProvider and aiModel', async () => {
      setupUpdateMock(mockAgent({
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-opus',
      }));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          aiProvider: 'openrouter',
          aiModel: 'anthropic/claude-3-opus',
        }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('aiProvider');
      expect(body.updatedFields).toContain('aiModel');
    });

    it('should update agentDefinition', async () => {
      const { setMock } = setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ agentDefinition: 'A coding assistant' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('agentDefinition');
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDefinition: 'A coding assistant',
        })
      );
    });

    it('should update visibleToGlobalAssistant', async () => {
      const { setMock } = setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ visibleToGlobalAssistant: true }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields).toContain('visibleToGlobalAssistant');
      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          visibleToGlobalAssistant: true,
        })
      );
    });

    it('should update multiple fields at once', async () => {
      setupUpdateMock(mockAgent({
        systemPrompt: 'New prompt',
        enabledTools: ['read_page'],
      }));

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          systemPrompt: 'New prompt',
          enabledTools: ['read_page'],
          aiProvider: 'google',
        }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.updatedFields.length).toBe(3);
    });

    it('should broadcast page update event', async () => {
      setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'New prompt' }),
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('should invalidate agent cache when agentDefinition changes', async () => {
      setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ agentDefinition: 'New definition' }),
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalled();
    });

    it('should invalidate agent cache when visibleToGlobalAssistant changes', async () => {
      setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ visibleToGlobalAssistant: true }),
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalled();
    });

    it('should log successful update', async () => {
      setupUpdateMock(mockAgent());

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'New prompt' }),
      });
      const context = createContext(mockAgentId);

      await PUT(request, context);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'AI agent configuration updated',
        expect.objectContaining({
          agentId: mockAgentId,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      const returningMock = vi.fn().mockRejectedValue(new Error('Database error'));
      const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
      const setMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request(`https://example.com/api/ai/page-agents/${mockAgentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({ systemPrompt: 'New prompt' }),
      });
      const context = createContext(mockAgentId);

      const response = await PUT(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to update AI agent');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
