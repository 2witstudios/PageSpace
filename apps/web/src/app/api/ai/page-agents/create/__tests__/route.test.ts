/**
 * Contract tests for POST /api/ai/page-agents/create
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam, not at the ORM level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/page-agent-repository', () => ({
  pageAgentRepository: {
    getDriveById: vi.fn(),
    getParentPage: vi.fn(),
    getNextPosition: vi.fn(),
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

// Mock app-permissions (boundary): drive-scope role lookup for scoped MCP tokens
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
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
  createPageEventPayload: vi.fn((driveId, pageId, operation, data) => ({
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
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  DEFAULT_PROVIDER: 'openai',
  DEFAULT_MODEL: 'openai/gpt-5.3-chat',
  ONPREM_ALLOWED_PROVIDERS: new Set(['ollama', 'lmstudio', 'azure_openai']),
  // Cloud models are vendor-prefixed; treat any 'vendor/model' id as valid here.
  isValidModel: (_provider: string, model: string) =>
    typeof model === 'string' && model.includes('/'),
}));

// Mock DB — wraps both the pages insert and membership insert in a transaction.
// tx.insert(pages).values(data).returning() → [createdAgent]
// tx.insert(driveAgentMembers).values(data)  → awaitable (no .returning())
const { mockInsertReturning, mockInsertValues, mockInsert, mockTransaction } = vi.hoisted(() => {
  const mockInsertReturning = vi.fn().mockResolvedValue([{ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' }]);
  const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
  const mockTransaction = vi.fn().mockImplementation(
    async (cb: (tx: { insert: typeof mockInsert }) => Promise<unknown>) =>
      cb({ insert: mockInsert }),
  );
  return { mockInsertReturning, mockInsertValues, mockInsert, mockTransaction };
});

vi.mock('@pagespace/db/db', () => ({
  db: { transaction: mockTransaction },
}));

vi.mock('@pagespace/db/schema/members', () => ({
  driveAgentMembers: 'driveAgentMembers_table',
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: 'pages_table',
}));

import { pageAgentRepository } from '@/lib/repositories/page-agent-repository';
import { getAppDriveMembership } from '@pagespace/lib/permissions/app-permissions';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/websocket';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { pages } from '@pagespace/db/schema/core';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';

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

    // Re-wire the DB insert chain after clearAllMocks wipes implementations
    mockInsertReturning.mockResolvedValue([{ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' }]);
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockTransaction.mockImplementation(
      async (cb: (tx: { insert: typeof mockInsert }) => Promise<unknown>) =>
        cb({ insert: mockInsert }),
    );

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

    // Scoped MCP token at root level: an explicit role means the key acts as
    // exactly that role (user parity) — only OWNER may create at drive root.
    it('should return 403 when scoped token with explicit ADMIN role creates at root level', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        userId: mockUserId,
        tokenType: 'mcp',
        tokenId: 'token_123',
        allowedDriveIds: [mockDriveId],
      } as unknown as SessionAuthResult);
      vi.mocked(getAppDriveMembership).mockResolvedValue({
        role: 'ADMIN',
        customRoleId: null,
        ownerUserId: mockUserId,
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
      expect(getAppDriveMembership).toHaveBeenCalledWith('token_123', mockDriveId);
    });

    // role === null means INHERIT: the key acts as its owner, so root creation
    // falls through to the drive.ownerId === userId check and succeeds.
    it('should allow scoped token with inherited (null) role to create at root when owner owns the drive', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        userId: mockUserId,
        tokenType: 'mcp',
        tokenId: 'token_123',
        allowedDriveIds: [mockDriveId],
      } as unknown as SessionAuthResult);
      vi.mocked(getAppDriveMembership).mockResolvedValue({
        role: null,
        customRoleId: null,
        ownerUserId: mockUserId,
      });

      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
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

    it('should pass correct data in transaction when creating agent', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'anthropic',
        aiModel: 'anthropic/claude-haiku-4.5',
        welcomeMessage: 'Hello!',
      });

      await POST(request);

      // First insert in the transaction is the pages row
      expect(mockInsert).toHaveBeenNthCalledWith(1, pages);
      expect(mockInsertValues).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          title: 'Test Agent',
          type: 'AI_CHAT',
          systemPrompt: 'You are helpful.',
          enabledTools: ['read_page', 'list_pages'],
          aiProvider: 'anthropic',
          aiModel: 'anthropic/claude-haiku-4.5',
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
      expect(mockInsertValues).toHaveBeenNthCalledWith(
        1,
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
        aiProvider: 'anthropic',
        aiModel: 'anthropic/claude-haiku-4.5',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.agentConfig).toMatchObject({
        enabledTools: ['read_page', 'list_pages'],
        aiProvider: 'anthropic',
        aiModel: 'anthropic/claude-haiku-4.5',
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

    it('should insert pages and MEMBER membership atomically in one transaction', async () => {
      const request = createRequest({
        driveId: mockDriveId,
        title: 'Test Agent',
        systemPrompt: 'You are helpful.',
      });

      await POST(request);

      // Both inserts happen inside the single transaction
      expect(mockTransaction).toHaveBeenCalledOnce();

      // First insert: pages table
      expect(mockInsert).toHaveBeenNthCalledWith(1, pages);

      // Second insert: drive membership with MEMBER role
      expect(mockInsert).toHaveBeenNthCalledWith(2, driveAgentMembers);
      expect(mockInsertValues).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          driveId: mockDriveId,
          agentPageId: 'agent_123',
          role: 'MEMBER',
          addedBy: mockUserId,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when transaction throws', async () => {
      mockTransaction.mockRejectedValue(new Error('Database connection failed'));

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
      mockTransaction.mockRejectedValue(
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
