import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': 'mock',
  })),
}));

vi.mock('@pagespace/lib/logger-browser', () => ({
  browserLoggers: {
    realtime: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
      })),
    },
  },
}));

vi.mock('@pagespace/lib/utils/environment', () => ({
  isNodeEnvironment: vi.fn(() => true),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

const { dbState } = vi.hoisted(() => ({
  dbState: {
    runs: [] as Array<{ id: string }>,
    lastWhere: null as unknown,
  },
}));

vi.mock('@pagespace/db', () => {
  const buildQuery = () => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn((predicate: unknown) => {
        dbState.lastWhere = predicate;
        return Promise.resolve(dbState.runs);
      }),
      innerJoin: vi.fn(() => query),
    };
    return query;
  };
  return {
    db: {
      select: vi.fn(() => buildQuery()),
    },
    eq: vi.fn((a: unknown, b: unknown) => ({ op: 'eq', a, b })),
    and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
    or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
    inArray: vi.fn((a: unknown, b: unknown) => ({ op: 'inArray', a, b })),
    agentRuns: { id: 'agentRuns.id', conversationId: 'agentRuns.conversationId' },
    conversations: { id: 'conversations.id', type: 'conversations.type', contextId: 'conversations.contextId' },
    pages: { id: 'pages.id', driveId: 'pages.driveId' },
  };
});

import {
  kickUserFromAgentRun,
  kickUserFromAgentRunsForPage,
  kickUserFromAgentRunsForDrive,
} from '../kick-agent-runs';

describe('kick-agent-runs', () => {
  const originalEnv = process.env;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
    process.env = {
      ...originalEnv,
      INTERNAL_REALTIME_URL: 'http://realtime.test',
    };
    dbState.runs = [];
    dbState.lastWhere = null;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, kickedCount: 1, rooms: [] }),
    });
  });

  describe('kickUserFromAgentRun', () => {
    it('given a runId, should POST a kick targeting the agent-run room', async () => {
      await kickUserFromAgentRun('run_1', 'user_1', 'permission_revoked');
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('http://realtime.test/api/kick');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        userId: 'user_1',
        roomPattern: 'agent-run:run_1',
        reason: 'permission_revoked',
      });
    });
  });

  describe('kickUserFromAgentRunsForPage', () => {
    it('given no matching runs, should not call fetch', async () => {
      dbState.runs = [];
      await kickUserFromAgentRunsForPage('page_1', 'user_1', 'permission_revoked');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given matching runs, should kick user from each agent-run room', async () => {
      dbState.runs = [{ id: 'run_a' }, { id: 'run_b' }];
      await kickUserFromAgentRunsForPage('page_1', 'user_1', 'permission_revoked');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const patterns = mockFetch.mock.calls
        .map((c) => JSON.parse(c[1].body).roomPattern)
        .sort();
      expect(patterns).toEqual(['agent-run:run_a', 'agent-run:run_b']);
    });
  });

  describe('kickUserFromAgentRunsForDrive', () => {
    it('given no matching runs, should not call fetch', async () => {
      dbState.runs = [];
      await kickUserFromAgentRunsForDrive('drive_1', 'user_1', 'member_removed');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given matching runs across drive and pages, should kick user from each agent-run room', async () => {
      dbState.runs = [{ id: 'run_drive' }, { id: 'run_page_a' }, { id: 'run_page_b' }];
      await kickUserFromAgentRunsForDrive('drive_1', 'user_1', 'member_removed');
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const patterns = mockFetch.mock.calls
        .map((c) => JSON.parse(c[1].body).roomPattern)
        .sort();
      expect(patterns).toEqual(['agent-run:run_drive', 'agent-run:run_page_a', 'agent-run:run_page_b']);
    });
  });
});
