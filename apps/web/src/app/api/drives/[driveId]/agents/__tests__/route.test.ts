import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/drives/[driveId]/agents
// ============================================================================

vi.mock('@pagespace/lib/permissions/permissions', () => ({
    getUserDriveAccess: vi.fn(),
    canUserViewPage: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/db', () => {
  return {
    db: {
      select: vi.fn(),
    },
    pages: {
      id: 'col_pages_id',
      title: 'col_pages_title',
      parentId: 'col_pages_parentId',
      position: 'col_pages_position',
      systemPrompt: 'col_pages_systemPrompt',
      enabledTools: 'col_pages_enabledTools',
      aiProvider: 'col_pages_aiProvider',
      aiModel: 'col_pages_aiModel',
      content: 'col_pages_content',
      createdAt: 'col_pages_createdAt',
      updatedAt: 'col_pages_updatedAt',
      driveId: 'col_pages_driveId',
      type: 'col_pages_type',
      isTrashed: 'col_pages_isTrashed',
    },
    drives: {
      id: 'col_drives_id',
      name: 'col_drives_name',
      slug: 'col_drives_slug',
    },
    eq: vi.fn((a: unknown, b: unknown) => ({ _type: 'eq', a, b })),
    and: vi.fn((...args: unknown[]) => ({ _type: 'and', args })),
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn().mockReturnValue(null),
}));

import { GET } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { getUserDriveAccess, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

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

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';

function _setupDbSelectChain(results: unknown[]) {
  const mockOrderBy = vi.fn().mockResolvedValue(results);
  const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);
  return { mockFrom, mockWhere, mockOrderBy };
}

// ============================================================================
// GET /api/drives/[driveId]/agents
// ============================================================================

describe('GET /api/drives/[driveId]/agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);
  });

  describe('authentication', () => {
    it('should return auth error when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(401);
    });

    it('should check MCP drive scope', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(
        NextResponse.json({ error: 'Scope denied' }, { status: 403 })
      );

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));

      expect(response.status).toBe(403);
      const scopeArgs = vi.mocked(checkMCPDriveScope).mock.calls[0];
      expect(scopeArgs[0]).toEqual(mockWebAuth(MOCK_USER_ID));
      expect(scopeArgs[1]).toBe(MOCK_DRIVE_ID);
    });
  });

  describe('authorization', () => {
    it('should return 403 when user has no drive access', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain("don't have access");
    });
  });

  describe('drive lookup', () => {
    it('should return 404 when drive not found', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      // First call: drive query returns empty, second call: agents query
      const mockOrderBy = vi.fn();
      const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
      const mockFrom = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.select).mockReturnValue({ from: mockFrom } as never);

      // First call returns empty (drive not found)
      mockWhere.mockReturnValueOnce(Promise.resolve([]) as never);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('not found');
    });
  });

  describe('response contract', () => {
    beforeEach(() => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    });

    it('should return agents list with correct fields', async () => {
      // Setup: drive query and agents query
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Drive query
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Test Drive', slug: 'test-drive' },
              ]),
            })),
          } as never;
        }
        // Agents query
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1',
                  title: 'My Agent',
                  parentId: 'page-1',
                  position: 0,
                  systemPrompt: 'You are a helpful assistant',
                  enabledTools: ['search', 'create'],
                  aiProvider: 'openai',
                  aiModel: 'gpt-4',
                  content: 'Welcome!',
                  createdAt: new Date('2024-01-01'),
                  updatedAt: new Date('2024-06-01'),
                },
              ]),
            })),
          })),
        } as never;
      });

      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.driveId).toBe(MOCK_DRIVE_ID);
      expect(body.driveName).toBe('Test Drive');
      expect(body.driveSlug).toBe('test-drive');
      expect(body.agents).toHaveLength(1);
      expect(body.count).toBe(1);
      expect(body.agents[0]).toMatchObject({
        id: 'agent-1',
        title: 'My Agent',
        parentId: 'page-1',
        position: 0,
        aiProvider: 'openai',
        aiModel: 'gpt-4',
        hasWelcomeMessage: true,
        hasSystemPrompt: true,
      });
      // Default: tools included, systemPrompt as preview only
      expect(body.agents[0].enabledTools).toEqual(['search', 'create']);
      expect(body.agents[0].enabledToolsCount).toBe(2);
      expect(typeof body.agents[0].systemPromptPreview).toBe('string');
      expect(body.agents[0].systemPrompt).toBeUndefined();
    });

    it('should include full system prompt when includeSystemPrompt=true', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: 'Agent', parentId: null, position: 0,
                  systemPrompt: 'Full prompt text here',
                  enabledTools: [], aiProvider: null, aiModel: null,
                  content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents?includeSystemPrompt=true');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].systemPrompt).toBe('Full prompt text here');
    });

    it('should truncate system prompt preview at 100 chars', async () => {
      const longPrompt = 'A'.repeat(150);
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: 'Agent', parentId: null, position: 0,
                  systemPrompt: longPrompt,
                  enabledTools: [], aiProvider: null, aiModel: null,
                  content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].systemPromptPreview).toBe('A'.repeat(100) + '...');
      expect(body.agents[0].systemPrompt).toBeUndefined();
    });

    it('should not add ellipsis when prompt is 100 chars or less', async () => {
      const shortPrompt = 'A'.repeat(100);
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: 'Agent', parentId: null, position: 0,
                  systemPrompt: shortPrompt,
                  enabledTools: [], aiProvider: null, aiModel: null,
                  content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].systemPromptPreview).toBe(shortPrompt);
    });

    it('should exclude tools when includeTools=false', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: 'Agent', parentId: null, position: 0,
                  systemPrompt: null, enabledTools: ['search'], aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents?includeTools=false');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].enabledTools).toBeUndefined();
      expect(body.agents[0].enabledToolsCount).toBeUndefined();
    });

    it('should handle agents with non-array enabledTools', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: 'Agent', parentId: null, position: 0,
                  systemPrompt: null, enabledTools: null, aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].enabledTools).toEqual([]);
      expect(body.agents[0].enabledToolsCount).toBe(0);
    });

    it('should filter agents by view permission', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-visible', title: 'Visible', parentId: null, position: 0,
                  systemPrompt: null, enabledTools: [], aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
                {
                  id: 'agent-hidden', title: 'Hidden', parentId: null, position: 1,
                  systemPrompt: null, enabledTools: [], aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });

      vi.mocked(canUserViewPage).mockImplementation(async (_userId: string, pageId: string) => {
        return pageId === 'agent-visible';
      });

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].id).toBe('agent-visible');
      expect(body.count).toBe(1);
      expect(body.stats.totalInDrive).toBe(2);
      expect(body.stats.accessible).toBe(1);
    });

    it('should use default values for null fields', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'agent-1', title: null, parentId: null, position: 0,
                  systemPrompt: null, enabledTools: null, aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.agents[0].parentId).toBe('root');
      expect(body.agents[0].aiProvider).toBe('default');
      expect(body.agents[0].aiModel).toBe('default');
      expect(body.agents[0].hasWelcomeMessage).toBe(false);
      expect(body.agents[0].hasSystemPrompt).toBe(false);
    });

    it('should return proper stats and nextSteps', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.stats).toMatchObject({
        totalInDrive: 0,
        accessible: 0,
        withSystemPrompt: 0,
        withTools: 0,
      });
      expect(body.nextSteps).toEqual([
        'No agents found - consider creating one',
        'Use update_agent_config to modify agent settings',
        'Use ask_agent to consult with specific agents',
        'Drive: Drive (drive_abc)',
      ]);
    });

    it('should return next steps with read_page suggestion when agents exist', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Drive', slug: 'drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'a1', title: 'A', parentId: null, position: 0,
                  systemPrompt: null, enabledTools: [], aiProvider: null,
                  aiModel: null, content: null, createdAt: new Date(), updatedAt: new Date(),
                },
              ]),
            })),
          })),
        } as never;
      });
      vi.mocked(canUserViewPage).mockResolvedValue(true);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(body.nextSteps[0]).toContain('read_page');
    });

    it('should log the agents listing', async () => {
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([
                { id: MOCK_DRIVE_ID, name: 'Test Drive', slug: 'test-drive' },
              ]),
            })),
          } as never;
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        } as never;
      });

      const request = new Request('https://example.com/api/drives/d/agents');
      await GET(request, createContext(MOCK_DRIVE_ID));

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Listed agents in drive',
        {
          driveId: MOCK_DRIVE_ID,
          driveName: 'Test Drive',
          totalAgents: 0,
          accessibleAgents: 0,
          userId: MOCK_USER_ID,
        }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 with error message when service throws', async () => {
      const error = new Error('Database connection lost');
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
      vi.mocked(isAuthError).mockReturnValue(false);
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);
      vi.mocked(getUserDriveAccess).mockRejectedValueOnce(error);

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to list agents');
      expect(body.error).toContain('Database connection lost');
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error listing agents in drive:',
        error
      );
    });

    it('should handle non-Error thrown values', async () => {
      vi.mocked(getUserDriveAccess).mockRejectedValueOnce('string error');

      const request = new Request('https://example.com/api/drives/d/agents');
      const response = await GET(request, createContext(MOCK_DRIVE_ID));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('string error');
    });
  });
});
