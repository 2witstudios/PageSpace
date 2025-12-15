import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const orderByMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const returningMock = vi.fn().mockResolvedValue([]);
  const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  return {
    db: {
      select: selectMock,
      insert: insertMock,
    },
    pages: {},
    drives: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
    and: vi.fn((...conditions: unknown[]) => ({ conditions, type: 'and' })),
    desc: vi.fn((field: unknown) => ({ field, type: 'desc' })),
    isNull: vi.fn((field: unknown) => ({ field, type: 'isNull' })),
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
  createPageEventPayload: vi.fn(() => ({ type: 'created' })),
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

// Helper to create mock drive
const mockDrive = (overrides: Partial<{
  id: string;
  ownerId: string;
}> = {}) => ({
  id: overrides.id || 'drive_123',
  ownerId: overrides.ownerId || 'user_123',
});

// Helper to create mock page
const mockPage = (overrides: Partial<{
  id: string;
  driveId: string;
  position: number;
}> = {}) => ({
  id: overrides.id || 'page_123',
  driveId: overrides.driveId || 'drive_123',
  position: overrides.position ?? 1,
});

describe('POST /api/ai/page-agents/create', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_123';

  let selectCallCount = 0;

  // Helper to setup mocks for drive and parent page
  // hasParentId: set to true if the test provides a parentId in the request body
  const setupSelectMocks = (
    drive: ReturnType<typeof mockDrive> | undefined,
    parentPage: ReturnType<typeof mockPage> | undefined,
    siblingPages: ReturnType<typeof mockPage>[] = [],
    hasParentId: boolean = false
  ) => {
    selectCallCount = 0;
    const whereMock = vi.fn().mockImplementation(() => {
      selectCallCount++;

      // Determine what result to return based on call order
      let result: unknown[];
      if (selectCallCount === 1) {
        // First call: get drive
        result = drive ? [drive] : [];
      } else if (hasParentId && selectCallCount === 2) {
        // Second call WITH parentId: verify parent page
        result = parentPage ? [parentPage] : [];
      } else {
        // Sibling pages call (call 2 without parentId, or call 3 with parentId)
        result = siblingPages;
      }

      // Return a thenable object that also has orderBy for chaining
      // This allows both patterns: `await db.select().from().where()`
      // and `await db.select().from().where().orderBy()`
      return {
        then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
          Promise.resolve(result).then(resolve, reject),
        orderBy: vi.fn().mockResolvedValue(result),
      };
    });
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup insert mock
  const setupInsertMock = (newAgent: { id: string; title: string; type: string }) => {
    const returningMock = vi.fn().mockResolvedValue([newAgent]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);
    return { valuesMock, returningMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default permission granted
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    // Default drive exists and user owns it
    setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
    setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId is missing', async () => {
      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('driveId, title, and systemPrompt are required');
    });

    it('should return 400 when title is missing', async () => {
      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('driveId, title, and systemPrompt are required');
    });

    it('should return 400 when systemPrompt is missing', async () => {
      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('driveId, title, and systemPrompt are required');
    });

    it('should return 400 when enabledTools contains invalid tools', async () => {
      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
          enabledTools: ['invalid_tool', 'read_page'],
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid tools specified');
      expect(body.error).toContain('invalid_tool');
    });
  });

  describe('drive not found', () => {
    it('should return 404 when drive does not exist', async () => {
      setupSelectMocks(undefined, undefined, []);

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('Drive with ID');
      expect(body.error).toContain('not found');
    });
  });

  describe('parent page validation', () => {
    it('should return 404 when parent page does not exist', async () => {
      setupSelectMocks(mockDrive(), undefined, [], true); // hasParentId = true

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          parentId: 'parent_123',
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('Parent page');
      expect(body.error).toContain('not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when non-owner tries to create at root level', async () => {
      setupSelectMocks(mockDrive({ ownerId: 'different_user' }), undefined, []);

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Only drive owners');
    });

    it('should return 403 when user lacks edit permission for parent folder', async () => {
      setupSelectMocks(mockDrive(), mockPage({ id: 'parent_123' }), [], true); // hasParentId = true
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          parentId: 'parent_123',
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('Insufficient permissions');
    });
  });

  describe('successful creation', () => {
    it('should create agent at drive root', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.id).toBe('agent_123');
      expect(body.title).toBe('Test Agent');
      expect(body.type).toBe('AI_CHAT');
    });

    it('should create agent in parent folder', async () => {
      setupSelectMocks(mockDrive(), mockPage({ id: 'parent_123' }), [], true); // hasParentId = true
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          parentId: 'parent_123',
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should accept valid enabledTools', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
          enabledTools: ['read_page', 'list_pages'],
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentConfig.enabledTools).toEqual(['read_page', 'list_pages']);
    });

    it('should accept aiProvider and aiModel', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
          aiProvider: 'openrouter',
          aiModel: 'anthropic/claude-3-opus',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.agentConfig.aiProvider).toBe('openrouter');
      expect(body.agentConfig.aiModel).toBe('anthropic/claude-3-opus');
    });

    it('should broadcast page creation event', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      await POST(request);

      expect(broadcastPageEvent).toHaveBeenCalled();
    });

    it('should invalidate agent awareness cache', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      await POST(request);

      expect(agentAwarenessCache.invalidateDriveAgents).toHaveBeenCalledWith(mockDriveId);
    });

    it('should log agent creation', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      setupInsertMock({ id: 'agent_123', title: 'Test Agent', type: 'AI_CHAT' });

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'AI agent created',
        expect.objectContaining({
          agentId: 'agent_123',
          title: 'Test Agent',
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle database errors gracefully', async () => {
      setupSelectMocks(mockDrive({ ownerId: mockUserId }), undefined, []);
      const returningMock = vi.fn().mockRejectedValue(new Error('Database error'));
      const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
      vi.mocked(db.insert).mockReturnValue({ values: valuesMock } as unknown as ReturnType<typeof db.insert>);

      const request = new Request('https://example.com/api/ai/page-agents/create', {
        method: 'POST',
        body: JSON.stringify({
          driveId: mockDriveId,
          title: 'Test Agent',
          systemPrompt: 'You are a helpful assistant.',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to create AI agent');
      expect(loggers.api.error).toHaveBeenCalled();
    });
  });
});
