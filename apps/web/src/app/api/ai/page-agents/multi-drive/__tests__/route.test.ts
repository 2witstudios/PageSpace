/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/ai/page-agents/multi-drive
//
// Tests the route handler's contract for listing AI agents across all
// accessible drives, with options for grouping, system prompt inclusion,
// and tool information filtering.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: {
    driveId: 'driveId',
    type: 'type',
    isTrashed: 'isTrashed',
    id: 'id',
    title: 'title',
    parentId: 'parentId',
    position: 'position',
    systemPrompt: 'systemPrompt',
    enabledTools: 'enabledTools',
    aiProvider: 'aiProvider',
    aiModel: 'aiModel',
    content: 'content',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  drives: {
    id: 'id',
    name: 'name',
    slug: 'slug',
    ownerId: 'ownerId',
    isTrashed: 'isTrashed',
  },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getAllowedDriveIds: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: vi.fn(),
  canUserViewPage: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, getAllowedDriveIds } from '@/lib/auth';
import { getUserDriveAccess, canUserViewPage, loggers } from '@pagespace/lib/server';

// ============================================================================
// Test Helpers
// ============================================================================

const USER_ID = 'user_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (queryString = ''): Request =>
  new Request(
    `https://example.com/api/ai/page-agents/multi-drive${queryString ? `?${queryString}` : ''}`
  );

const createDriveFixture = (overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  ownerId: string;
}> = {}) => ({
  id: overrides.id ?? 'drive_1',
  name: overrides.name ?? 'Test Drive',
  slug: overrides.slug ?? 'test-drive',
  ownerId: overrides.ownerId ?? USER_ID,
});

const createAgentFixture = (overrides: Partial<{
  id: string;
  title: string;
  parentId: string | null;
  position: number;
  systemPrompt: string | null;
  enabledTools: string[] | null;
  aiProvider: string | null;
  aiModel: string | null;
  content: string | null;
  createdAt: Date;
  updatedAt: Date;
}> = {}) => ({
  id: overrides.id ?? 'agent_1',
  title: overrides.title ?? 'Test Agent',
  parentId: overrides.parentId ?? null,
  position: overrides.position ?? 0,
  systemPrompt: overrides.systemPrompt ?? null,
  enabledTools: overrides.enabledTools ?? null,
  aiProvider: overrides.aiProvider ?? null,
  aiModel: overrides.aiModel ?? null,
  content: overrides.content ?? null,
  createdAt: overrides.createdAt ?? new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-02'),
});

/**
 * Set up the chainable db.select() mock for drives and agents queries.
 * The route calls db.select() twice per drive iteration:
 *   1st call: drives query (select from drives where not trashed)
 *   2nd+ calls: agents query per drive (select from pages where driveId/type/not trashed)
 */
const setupDbSelectMock = (drivesResult: any[], agentsByDrive: Record<string, any[]> = {}) => {
  let callCount = 0;

  vi.mocked(db.select).mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // First call: drives query
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(drivesResult),
        }),
      } as any;
    }
    // Subsequent calls: agent queries for each drive
    // We determine which drive by the call order
    const driveIndex = callCount - 2;
    const driveIds = Object.keys(agentsByDrive);
    const agents = driveIds[driveIndex] !== undefined
      ? agentsByDrive[driveIds[driveIndex]]
      : [];
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(agents ?? []),
        }),
      }),
    } as any;
  });
};

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/ai/page-agents/multi-drive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getAllowedDriveIds).mockReturnValue([]);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    setupDbSelectMock([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest());

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('empty results', () => {
    it('should return empty results when no accessible drives', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);
      setupDbSelectMock([createDriveFixture()]);

      const response = await GET(createRequest());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.totalCount).toBe(0);
      expect(body.driveCount).toBe(0);
    });
  });

  describe('grouping', () => {
    it('should return agents grouped by drive (default groupByDrive=true)', async () => {
      const drive = createDriveFixture({ id: 'drive_1', name: 'My Drive', slug: 'my-drive' });
      const agent = createAgentFixture({ id: 'agent_1', title: 'Agent One' });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest());

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.totalCount).toBe(1);
      expect(body.driveCount).toBe(1);
      expect(body.agentsByDrive).toBeDefined();
      expect(body.agentsByDrive).toHaveLength(1);
      expect(body.agentsByDrive[0].driveId).toBe('drive_1');
      expect(body.agentsByDrive[0].driveName).toBe('My Drive');
      expect(body.agentsByDrive[0].agents).toHaveLength(1);
      expect(body.agentsByDrive[0].agents[0].id).toBe('agent_1');
    });

    it('should return flat agent list when groupByDrive=false', async () => {
      const drive = createDriveFixture({ id: 'drive_1', name: 'My Drive', slug: 'my-drive' });
      const agent = createAgentFixture({ id: 'agent_1', title: 'Agent One' });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.agents).toBeDefined();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe('agent_1');
      expect(body.agentsByDrive).toBeUndefined();
    });
  });

  describe('system prompt', () => {
    it('should include full system prompt when includeSystemPrompt=true', async () => {
      const drive = createDriveFixture();
      const agent = createAgentFixture({
        systemPrompt: 'You are a helpful assistant that specializes in coding tasks.',
      });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('includeSystemPrompt=true&groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].systemPrompt).toBe(
        'You are a helpful assistant that specializes in coding tasks.'
      );
      expect(body.agents[0].systemPromptPreview).toBeUndefined();
    });

    it('should show system prompt preview when includeSystemPrompt is not set', async () => {
      const longPrompt = 'A'.repeat(150);
      const drive = createDriveFixture();
      const agent = createAgentFixture({ systemPrompt: longPrompt });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].systemPrompt).toBeUndefined();
      expect(body.agents[0].systemPromptPreview).toBeDefined();
      expect(body.agents[0].systemPromptPreview).toHaveLength(103); // 100 chars + '...'
      expect(body.agents[0].hasSystemPrompt).toBe(true);
    });

    it('should not include preview for agents without system prompt', async () => {
      const drive = createDriveFixture();
      const agent = createAgentFixture({ systemPrompt: null });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].systemPrompt).toBeUndefined();
      expect(body.agents[0].systemPromptPreview).toBeUndefined();
      expect(body.agents[0].hasSystemPrompt).toBe(false);
    });
  });

  describe('tools information', () => {
    it('should include tools information by default', async () => {
      const drive = createDriveFixture();
      const agent = createAgentFixture({
        enabledTools: ['search', 'calculator'],
      });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].enabledTools).toEqual(['search', 'calculator']);
      expect(body.agents[0].enabledToolsCount).toBe(2);
    });

    it('should exclude tools when includeTools=false', async () => {
      const drive = createDriveFixture();
      const agent = createAgentFixture({
        enabledTools: ['search', 'calculator'],
      });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('includeTools=false&groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].enabledTools).toBeUndefined();
      expect(body.agents[0].enabledToolsCount).toBeUndefined();
    });
  });

  describe('MCP token scope filtering', () => {
    it('should filter by MCP token scope (getAllowedDriveIds)', async () => {
      const drive1 = createDriveFixture({ id: 'drive_1', name: 'Allowed Drive' });
      const drive2 = createDriveFixture({ id: 'drive_2', name: 'Other Drive' });
      const agent1 = createAgentFixture({ id: 'agent_in_allowed' });

      // getAllowedDriveIds returns scoped drives
      vi.mocked(getAllowedDriveIds).mockReturnValue(['drive_1']);

      // Both drives are accessible
      setupDbSelectMock([drive1, drive2], { drive_1: [agent1] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      // Only agents from drive_1 should be returned
      expect(body.driveCount).toBe(1);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe('agent_in_allowed');
    });
  });

  describe('drive access permissions', () => {
    it('should respect drive access permissions (getUserDriveAccess)', async () => {
      const drive1 = createDriveFixture({ id: 'drive_1', name: 'Accessible' });
      const drive2 = createDriveFixture({ id: 'drive_2', name: 'Not Accessible' });

      vi.mocked(getUserDriveAccess).mockImplementation(async (_userId: string, driveId: string) => {
        return driveId === 'drive_1';
      });

      const agent1 = createAgentFixture({ id: 'agent_accessible' });
      setupDbSelectMock([drive1, drive2], { drive_1: [agent1] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.driveCount).toBe(1);
      expect(body.agents).toHaveLength(1);
    });
  });

  describe('page view permissions', () => {
    it('should respect page view permissions (canUserViewPage)', async () => {
      const drive = createDriveFixture();
      const agent1 = createAgentFixture({ id: 'agent_visible', title: 'Visible' });
      const agent2 = createAgentFixture({ id: 'agent_hidden', title: 'Hidden' });
      setupDbSelectMock([drive], { drive_1: [agent1, agent2] });

      vi.mocked(canUserViewPage).mockImplementation(async (_userId: string, pageId: string) => {
        return pageId === 'agent_visible';
      });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe('agent_visible');
      expect(body.totalCount).toBe(1);
    });
  });

  describe('response shape', () => {
    it('should include stats and nextSteps in response', async () => {
      const drive = createDriveFixture({ name: 'My Drive' });
      const agent = createAgentFixture({
        systemPrompt: 'You are helpful.',
        enabledTools: ['search'],
      });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.stats).toMatchObject({
        accessibleDrives: 1,
        totalAgents: 1,
        withSystemPrompt: 1,
        withTools: 1,
        averageAgentsPerDrive: 1,
      });
      expect(body.nextSteps).toBeDefined();
      expect(Array.isArray(body.nextSteps)).toBe(true);
      expect(body.summary).toContain('1 accessible AI agent');
    });

    it('should set default values for missing agent fields', async () => {
      const drive = createDriveFixture();
      const agent = createAgentFixture({
        parentId: null,
        aiProvider: null,
        aiModel: null,
        content: null,
      });
      setupDbSelectMock([drive], { drive_1: [agent] });

      const response = await GET(createRequest('groupByDrive=false'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.agents[0].parentId).toBe('root');
      expect(body.agents[0].aiProvider).toBe('default');
      expect(body.agents[0].aiModel).toBe('default');
      expect(body.agents[0].hasWelcomeMessage).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should return 500 with error message when an unexpected error occurs', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Database connection lost');
      });

      const response = await GET(createRequest());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('Failed to list agents across drives');
      expect(body.error).toContain('Database connection lost');
    });

    it('should log error when request fails', async () => {
      vi.mocked(db.select).mockImplementation(() => {
        throw new Error('Query failed');
      });

      await GET(createRequest());

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error listing agents across drives:',
        expect.any(Error)
      );
    });
  });
});
