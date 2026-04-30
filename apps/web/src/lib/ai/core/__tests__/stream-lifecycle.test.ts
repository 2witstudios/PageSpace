import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockRegistryRegister,
  mockRegistryPush,
  mockRegistryFinish,
  mockBroadcastStart,
  mockBroadcastComplete,
  mockInsertValues,
  mockInsertOnConflict,
  mockUpdateSet,
  mockUpdateWhere,
  mockLoggerWarn,
  aiStreamSessionsToken,
} = vi.hoisted(() => ({
  mockRegistryRegister: vi.fn(),
  mockRegistryPush: vi.fn(),
  mockRegistryFinish: vi.fn(),
  mockBroadcastStart: vi.fn().mockResolvedValue(undefined),
  mockBroadcastComplete: vi.fn().mockResolvedValue(undefined),
  mockInsertValues: vi.fn(),
  mockInsertOnConflict: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
  aiStreamSessionsToken: { __table: 'ai_stream_sessions', messageId: 'message_id' },
}));

vi.mock('@/lib/ai/core/stream-multicast-registry', () => ({
  streamMulticastRegistry: {
    register: mockRegistryRegister,
    push: mockRegistryPush,
    finish: mockRegistryFinish,
    getMeta: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastAiStreamStart: mockBroadcastStart,
  broadcastAiStreamComplete: mockBroadcastComplete,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (row: Record<string, unknown>) => {
        mockInsertValues(row);
        return {
          onConflictDoUpdate: (cfg: Record<string, unknown>) => mockInsertOnConflict(cfg),
        };
      },
    })),
    update: vi.fn(() => ({
      set: (patch: Record<string, unknown>) => {
        mockUpdateSet(patch);
        return {
          where: (clause: unknown) => mockUpdateWhere(clause),
        };
      },
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: aiStreamSessionsToken,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: mockLoggerWarn,
    },
  },
}));

import { createStreamLifecycle } from '../stream-lifecycle';

const params = (overrides: Partial<Parameters<typeof createStreamLifecycle>[0]> = {}) => ({
  messageId: 'msg-1',
  channelId: 'page-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  displayName: 'Alice',
  tabId: 'tab-1',
  ...overrides,
});

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('createStreamLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertOnConflict.mockResolvedValue(undefined);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockBroadcastStart.mockResolvedValue(undefined);
    mockBroadcastComplete.mockResolvedValue(undefined);
  });

  describe('register / insert / broadcastStart on creation', () => {
    it('given valid params, should register the messageId in the multicast registry with full meta', async () => {
      await createStreamLifecycle(params());

      expect(mockRegistryRegister).toHaveBeenCalledWith('msg-1', {
        pageId: 'page-1',
        userId: 'user-1',
        displayName: 'Alice',
        conversationId: 'conv-1',
        tabId: 'tab-1',
      });
    });

    it('given valid params, should insert an aiStreamSessions row with status=streaming and full identity fields', async () => {
      await createStreamLifecycle(params());

      expect(mockInsertValues).toHaveBeenCalledWith({
        messageId: 'msg-1',
        channelId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Alice',
        tabId: 'tab-1',
        status: 'streaming',
      });
    });

    it('given a duplicate messageId, should refresh all 8 fields via onConflictDoUpdate', async () => {
      await createStreamLifecycle(params());

      expect(mockInsertOnConflict).toHaveBeenCalledTimes(1);
      const cfg = mockInsertOnConflict.mock.calls[0][0];
      expect(cfg.set).toMatchObject({
        channelId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Alice',
        tabId: 'tab-1',
        status: 'streaming',
        completedAt: null,
      });
      expect(cfg.set.startedAt).toBeInstanceOf(Date);
    });

    it('given the insert is in-flight, should not broadcast chat:stream_start until it has resolved', async () => {
      let resolveInsert!: () => void;
      mockInsertOnConflict.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveInsert = res; })
      );

      const lifecyclePromise = createStreamLifecycle(params());
      await flushMicrotasks();

      expect(mockInsertValues).toHaveBeenCalled();
      expect(mockBroadcastStart).not.toHaveBeenCalled();

      resolveInsert();
      await lifecyclePromise;

      expect(mockBroadcastStart).toHaveBeenCalled();
    });

    it('given a successful start, should broadcast chat:stream_start with the full triggeredBy payload', async () => {
      await createStreamLifecycle(params());

      expect(mockBroadcastStart).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-1', displayName: 'Alice', tabId: 'tab-1' },
      });
    });

    it('given the insert rejects, should warn and still resolve the lifecycle handle', async () => {
      mockInsertOnConflict.mockRejectedValueOnce(new Error('db down'));

      const handle = await createStreamLifecycle(params());

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(handle).toBeDefined();
    });

    it('given broadcastStart rejects, should not throw out of the factory', async () => {
      mockBroadcastStart.mockRejectedValueOnce(new Error('socket dead'));

      await expect(createStreamLifecycle(params())).resolves.toBeDefined();
    });
  });

  describe('pushChunk', () => {
    it('given a chunk, should push it through the multicast registry under the messageId', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.pushChunk('hello');

      expect(mockRegistryPush).toHaveBeenCalledWith('msg-1', 'hello');
    });

    it('given the registry throws on push, should not throw out of pushChunk', async () => {
      mockRegistryPush.mockImplementationOnce(() => { throw new Error('push'); });
      const lifecycle = await createStreamLifecycle(params());

      expect(() => lifecycle.pushChunk('hi')).not.toThrow();
    });
  });

  describe('finish — completion path', () => {
    it('given finish(false), should call registry.finish, UPDATE the row to status=complete, and broadcast complete', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockRegistryFinish).toHaveBeenCalledWith('msg-1', false);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'complete',
        completedAt: expect.any(Date),
      });
      expect(mockBroadcastComplete).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        aborted: false,
      });
    });

    it('given finish(true), should UPDATE the row to status=aborted and broadcast complete with aborted=true', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(true);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'aborted',
        completedAt: expect.any(Date),
      });
      expect(mockBroadcastComplete).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        aborted: true,
      });
    });
  });

  describe('finish — idempotence', () => {
    it('given finish() is called twice, should fire registry.finish only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockRegistryFinish).toHaveBeenCalledTimes(1);
    });

    it('given finish() is called twice, should fire the DB UPDATE only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    });

    it('given finish() is called twice, should fire broadcastComplete only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockBroadcastComplete).toHaveBeenCalledTimes(1);
    });

    it('given finish(true) followed by finish(false), should keep aborted=true on the broadcast (first call wins)', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(true);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockBroadcastComplete).toHaveBeenCalledTimes(1);
      expect(mockBroadcastComplete).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }));
    });
  });

  describe('finish — invocation order', () => {
    it('given finish(), should call registry.finish, then DB UPDATE, then broadcastComplete in that order', async () => {
      const lifecycle = await createStreamLifecycle(params());

      mockRegistryFinish.mockClear();
      mockUpdateSet.mockClear();
      mockBroadcastComplete.mockClear();

      lifecycle.finish(false);
      await flushMicrotasks();

      const finishOrder = mockRegistryFinish.mock.invocationCallOrder[0];
      const updateOrder = mockUpdateSet.mock.invocationCallOrder[0];
      const broadcastOrder = mockBroadcastComplete.mock.invocationCallOrder[0];

      expect(finishOrder).toBeLessThan(updateOrder);
      expect(updateOrder).toBeLessThan(broadcastOrder);
    });
  });

  describe('finish — resilience', () => {
    it('given the DB UPDATE rejects, should warn and still broadcast complete', async () => {
      mockUpdateWhere.mockRejectedValueOnce(new Error('db dead'));
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(mockBroadcastComplete).toHaveBeenCalled();
    });

    it('given broadcastComplete rejects, should not throw synchronously out of finish()', async () => {
      mockBroadcastComplete.mockRejectedValueOnce(new Error('socket dead'));
      const lifecycle = await createStreamLifecycle(params());

      expect(() => lifecycle.finish(false)).not.toThrow();
    });

    it('given registry.finish throws, should still UPDATE and broadcast', async () => {
      mockRegistryFinish.mockImplementationOnce(() => { throw new Error('reg err'); });
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalled();
      expect(mockBroadcastComplete).toHaveBeenCalled();
    });
  });
});
