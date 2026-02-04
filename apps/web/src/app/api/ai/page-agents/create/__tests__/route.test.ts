/**
 * Contract tests for POST /api/ai/page-agents/create
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam, not at the ORM level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/page-agent-repository', () => ({
  pageAgentRepository: {
    getDriveById: vi.fn(),
    getParentPage: vi.fn(),
    getNextPosition: vi.fn(),
    createAgent: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(),
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
  createPageEventPayload: vi.fn((driveId, pageId, operation, data) => ({
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

import { pageAgentRepository } from '@/lib/repositories/page-agent-repository';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { canUserEditPage, agentAwarenessCache } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';

// Test fixtures
const mockUserId = 'user_123';
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

const createRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/page-agents/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/ai/page-agents/create', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default: MCP scope check passes (returns null = allowed)
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);

    // Default: drive exists, owned by user
    vi.mocked(pageAgentRepository.getDriveById).mockResolvedValue({
      id: mockDriveId,
      ownerId: mockUserId,
    });

    // Default: position calculation returns 1
    vi.mocked(pageAgentRepository.getNextPosition).mockResolvedValue(1);

    // Default: agent creation succeeds
    vi.mocked(pageAgentRepository.createAgent).mockResolvedValue({
      id: 'agent_123',
      title: 'Test Agent',
      type: 'AI_CHAT',
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId is missing', async () => {
      const request = createRequest({
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('driveId');
      expect(body.error).toContain('required');
    });

    it('should return 400 when title is missing', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('title');
      expect(body.error).toContain('required');
    });

    it('should return 400 when systemPrompt is missing', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('systemPrompt');
      expect(body.error).toContain('required');
    });

    it('should return 400 when enabledTools contains invalid tools', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
        enabledTools: ['invalid_tool', 'read_page'],
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tools');
      expect(body.error).toContain('invalid_tool');
    });
  });

  describe('resource not found', () => {
    it('should return 404 when drive does not exist', async () => {
      vi.mocked(pageAgentRepository.getDriveById).mockResolvedValue(null);

      const request = createRequest({
        driveId: 'nonexistent_drive',
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('Drive');
      expect(body.error).toContain('not found');
      // Verify repository was called with correct driveId
      expect(pageAgentRepository.getDriveById).toHaveBeenCalledWith('nonexistent_drive');
    });

    it('should return 404 when parent page does not exist', async () => {
      vi.mocked(pageAgentRepository.getParentPage).mockResolvedValue(null);

      const request = createRequest({
        driveId: mockDriveId,
        parentId: 'nonexistent_parent',
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('Parent page');
      expect(body.error).toContain('not found');
      // Verify repository was called with correct parentId and driveId
      expect(pageAgentRepository.getParentPage).toHaveBeenCalledWith('nonexistent_parent', mockDriveId);
    });
  });

  describe('authorization', () => {
    it('should return 403 when non-owner creates at root level', async () => {
      vi.mocked(pageAgentRepository.getDriveById).mockResolvedValue({
        id: mockDriveId,
        ownerId: 'different_user',
      });

      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Only drive owners');
    });

    it('should return 403 when user lacks edit permission for parent folder', async () => {
      vi.mocked(pageAgentRepository.getParentPage).mockResolvedValue({ id: 'parent_123' });
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = createRequest({
        driveId: mockDriveId,
        parentId: 'parent_123',
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
      // Verify permission check was called with correct userId and pageId
      expect(canUserEditPage).toHaveBeenCalledWith(mockUserId, 'parent_123');
    });
  });

  describe('successful creation', () => {
    it('should create agent at drive root and return correct response', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        id: 'agent_123',
        title: 'Test Agent',
        type: 'AI_CHAT',
      });
    });

    it('should pass correct data to repository when creating agent', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-opus',
        welcomeMessage: 'Hello!',
      });

      await POST(request);

      expect(pageAgentRepository.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Agent',
          type: 'AI_CHAT',
          systemPrompt: 'You are helpful.',
          enabledTools: ['read_page', 'list_pages'],
          aiProvider: 'openrouter',
          aiModel: 'anthropic/claude-3-opus',
          content: 'Hello!',
          driveId: mockDriveId,
          parentId: null,
          isTrashed: false,
        })
      );
    });

    it('should create agent in parent folder', async () => {
      vi.mocked(pageAgentRepository.getParentPage).mockResolvedValue({ id: 'parent_123' });

      const request = createRequest({
        driveId: mockDriveId,
        parentId: 'parent_123',
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(pageAgentRepository.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: 'parent_123',
        })
      );
    });

    it('should return agent config in response', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-opus',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.agentConfig).toMatchObject({
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'openrouter',
        aiModel: 'anthropic/claude-3-opus',
      });
    });
  });

  describe('boundary obligations', () => {
    it('should broadcast page creation event with correct payload', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      await POST(request);

      expect(createPageEventPayload).toHaveBeenCalledWith(
        mockDriveId,
        'agent_123',
        'created',
        expect.objectContaining({
          title: 'Test Agent',
          type: 'AI_CHAT',
        })
      );
      // Verify broadcastPageEvent is called with the payload from createPageEventPayload
      const expectedPayload = vi.mocked(createPageEventPayload).mock.results[0]?.value;
      expect(broadcastPageEvent).toHaveBeenCalledWith(expectedPayload);
    });

    it('should invalidate agent awareness cache for the drive', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      await POST(request);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(pageAgentRepository.createAgent).mockRejectedValue(
        new Error('Database connection failed')
      );

      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create AI agent');
    });

    it('should not leak internal error details to client', async () => {
      vi.mocked(pageAgentRepository.createAgent).mockRejectedValue(
        new Error('SENSITIVE: connection string with password=secret123')
      );

      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      // Error message should be exactly the generic message - no internal details
      expect(body.error).toBe('Failed to create AI agent');
      expect(body.error).not.toContain('SENSITIVE');
      expect(body.error).not.toContain('connection');
      expect(body.error).not.toContain('password');
    });
  });
});
