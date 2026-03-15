import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockGetUserDriveAccess = vi.fn();
  const mockCanUserViewPage = vi.fn();
  const mockAgentAwarenessCache = {
    getDriveAgents: vi.fn(),
    setDriveAgents: vi.fn(),
  };
  const mockLoggers = {
    ai: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
  };
  return { mockGetUserDriveAccess, mockCanUserViewPage, mockAgentAwarenessCache, mockLoggers };
});

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  pages: {
    id: 'id',
    title: 'title',
    type: 'type',
    driveId: 'driveId',
    isTrashed: 'isTrashed',
    agentDefinition: 'agentDefinition',
    visibleToGlobalAssistant: 'visibleToGlobalAssistant',
  },
  drives: {
    id: 'id',
    name: 'name',
    isTrashed: 'isTrashed',
  },
  eq: vi.fn((a, b) => ({ eq: true, a, b })),
  and: vi.fn((...args) => ({ and: true, args })),
}));

vi.mock('@pagespace/lib/server', () => ({
  getUserDriveAccess: mocks.mockGetUserDriveAccess,
  canUserViewPage: mocks.mockCanUserViewPage,
  agentAwarenessCache: mocks.mockAgentAwarenessCache,
  loggers: mocks.mockLoggers,
}));

import { buildAgentAwarenessPrompt } from '../agent-awareness';
import { db } from '@pagespace/db';

describe('agent-awareness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildAgentAwarenessPrompt', () => {
    it('should return empty string when user has no accessible drives', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toBe('');
    });

    it('should return empty string when no visible agents exist after filtering', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'drive-1', name: 'Drive 1' }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(null);
      mocks.mockAgentAwarenessCache.setDriveAgents.mockResolvedValue(undefined);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toBe('');
    });

    it('should build prompt with visible agents', async () => {
      const drives = [{ id: 'drive-1', name: 'My Drive' }];
      const agents = [
        { id: 'agent-1', title: 'My Agent', agentDefinition: 'Helpful agent', visibleToGlobalAssistant: true },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(drives),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(agents),
            }),
          }),
        } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(null);
      mocks.mockAgentAwarenessCache.setDriveAgents.mockResolvedValue(undefined);
      mocks.mockCanUserViewPage.mockResolvedValue(true);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toContain('## Available AI Agents');
      expect(result).toContain('My Agent');
      expect(result).toContain('agent-1');
      expect(result).toContain('My Drive');
    });

    it('should include agent definition in prompt when available', async () => {
      const drives = [{ id: 'drive-1', name: 'Drive A' }];
      const agents = [
        { id: 'agent-2', title: 'Code Assistant', agentDefinition: 'Helps with coding tasks', visibleToGlobalAssistant: true },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(drives),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(agents),
            }),
          }),
        } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(null);
      mocks.mockAgentAwarenessCache.setDriveAgents.mockResolvedValue(undefined);
      mocks.mockCanUserViewPage.mockResolvedValue(true);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toContain('Helps with coding tasks');
    });

    it('should use cached agents when available', async () => {
      const drives = [{ id: 'drive-1', name: 'My Drive' }];
      const cachedAgents = {
        agents: [{ id: 'cached-agent', title: 'Cached Agent', definition: 'From cache' }],
      };

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(drives),
        }),
      } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(cachedAgents);
      mocks.mockCanUserViewPage.mockResolvedValue(true);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toContain('Cached Agent');
      expect(mocks.mockAgentAwarenessCache.setDriveAgents).not.toHaveBeenCalled();
    });

    it('should filter agents based on user view permission', async () => {
      const drives = [{ id: 'drive-1', name: 'My Drive' }];
      const agents = [
        { id: 'agent-visible', title: 'Visible Agent', agentDefinition: null, visibleToGlobalAssistant: true },
        { id: 'agent-hidden', title: 'Hidden Agent', agentDefinition: null, visibleToGlobalAssistant: true },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(drives),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(agents),
            }),
          }),
        } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(null);
      mocks.mockAgentAwarenessCache.setDriveAgents.mockResolvedValue(undefined);

      mocks.mockCanUserViewPage.mockImplementation(async (_userId: string, agentId: string) => {
        return agentId === 'agent-visible';
      });

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toContain('Visible Agent');
      expect(result).not.toContain('Hidden Agent');
    });

    it('should return empty string when user has no access to any drive', async () => {
      const drives = [{ id: 'drive-1', name: 'My Drive' }];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(drives),
        }),
      } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(false);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toBe('');
    });

    it('should return empty string on database error', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      } as never);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toBe('');
    });

    it('should include ask_agent hint in prompt', async () => {
      const drives = [{ id: 'drive-1', name: 'My Drive' }];
      const agents = [
        { id: 'agent-1', title: 'Test Agent', agentDefinition: null, visibleToGlobalAssistant: true },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(drives),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(agents),
            }),
          }),
        } as never);

      mocks.mockGetUserDriveAccess.mockResolvedValue(true);
      mocks.mockAgentAwarenessCache.getDriveAgents.mockResolvedValue(null);
      mocks.mockAgentAwarenessCache.setDriveAgents.mockResolvedValue(undefined);
      mocks.mockCanUserViewPage.mockResolvedValue(true);

      const result = await buildAgentAwarenessPrompt('user-123');
      expect(result).toContain('ask_agent');
    });
  });
});
