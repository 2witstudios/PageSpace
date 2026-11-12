/**
 * The one behaviour of the reference sweep that Postgres cannot be made to
 * show on demand: the AI-message search failing. The queries themselves are
 * proven against a real database in takedown-db.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { messages } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';

const state = vi.hoisted(() => ({
  failMessages: false,
  pageRows: [] as Array<{ id: string; driveId: string; createdBy: string | null }>,
  messageRows: [] as Array<{ id: string; conversationId: string; userId: string | null }>,
}));

vi.mock('@pagespace/db/db', () => {
  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === messages) {
            if (state.failMessages) throw new Error('canceling statement due to statement timeout');
            return state.messageRows;
          }
          return table === pages ? state.pageRows : [];
        },
      }),
    }),
  });
  return {
    db: {
      select,
      transaction: async (run: (tx: { execute: () => Promise<void>; select: typeof select }) => Promise<unknown>) =>
        run({ execute: async () => undefined, select }),
    },
  };
});
vi.mock('../../logging/logger-config', () => ({ loggers: { security: { error: vi.fn() } } }));

import { collectAiMessageReferences, collectContentReferences } from '../references';
import { loggers } from '../../logging/logger-config';

const HASH = 'a'.repeat(64);

describe('collectContentReferences (a lookup) — when the AI-message search cannot finish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.pageRows = [{ id: 'page-1', driveId: 'drive-1', createdBy: 'user-1' }];
    state.messageRows = [{ id: 'msg-1', conversationId: 'conv-1', userId: 'chat-user' }];
  });

  it('still returns every other reference', async () => {
    state.failMessages = true;

    const refs = await collectContentReferences(HASH);

    expect(refs.pageIds).toEqual(['page-1']);
    expect(refs.driveIds).toEqual(['drive-1']);
    expect(refs.uploaderUserIds).toEqual(['user-1']);
    expect(refs.aiMessageIds).toEqual([]);
  });

  it('says so on the result and in the log, rather than passing an incomplete list off as complete', async () => {
    state.failMessages = true;

    const refs = await collectContentReferences(HASH);

    expect(refs.aiMessageScanFailed).toBe(true);
    expect(loggers.security.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(loggers.security.error).mock.calls)).not.toContain(HASH);
  });

  it('does not set the flag when the search succeeds', async () => {
    const refs = await collectContentReferences(HASH);
    expect(refs.aiMessageScanFailed).toBeUndefined();
    expect(loggers.security.error).not.toHaveBeenCalled();
  });

  it('does not run the search at all when asked to skip it (the takedown records these in a step of its own)', async () => {
    state.failMessages = true;

    const refs = await collectContentReferences(HASH, { aiMessages: 'skip' });

    expect(refs.aiMessageScanFailed).toBeUndefined();
    expect(refs.aiMessageIds).toEqual([]);
    expect(loggers.security.error).not.toHaveBeenCalled();
  });
});

describe('collectAiMessageReferences (the takedown step)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.messageRows = [
      { id: 'msg-1', conversationId: 'conv-1', userId: 'chat-user' },
      { id: 'msg-2', conversationId: 'conv-1', userId: null },
    ];
  });

  it('returns the messages, their conversations and their human authors', async () => {
    expect(await collectAiMessageReferences(HASH)).toEqual({
      aiMessageIds: ['msg-1', 'msg-2'],
      conversationIds: ['conv-1'],
      uploaderUserIds: ['chat-user'],
      truncated: false,
    });
  });

  it('throws when the search cannot finish, rather than returning a partial list as if it were whole', async () => {
    state.failMessages = true;
    await expect(collectAiMessageReferences(HASH)).rejects.toThrow('statement timeout');
    expect(JSON.stringify(vi.mocked(loggers.security.error).mock.calls)).not.toContain(HASH);
  });
});
