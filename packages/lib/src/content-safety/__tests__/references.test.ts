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
  transactions: 0,
  statements: [] as string[],
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
      transaction: async (run: (tx: { execute: (query: unknown) => Promise<void>; select: typeof select }) => Promise<unknown>) => {
        state.transactions += 1;
        return run({
          execute: async (query: unknown) => {
            const chunks = (query as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ?? [];
            state.statements.push(chunks.flatMap((chunk) => chunk.value ?? []).join(''));
          },
          select,
        });
      },
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
});

describe('collectAiMessageReferences (the takedown step)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.failMessages = false;
    state.transactions = 0;
    state.statements = [];
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

  it('runs at the ordinary timeout by default and in its own transaction with a longer one when asked', async () => {
    await collectAiMessageReferences(HASH);
    expect(state.transactions).toBe(0);

    await collectAiMessageReferences(HASH, { extendedTimeout: true });
    expect(state.transactions).toBe(1);
    expect(state.statements).toEqual(["set local statement_timeout = '120s'"]);
  });

  it('throws when the search cannot finish, rather than returning a partial list as if it were whole', async () => {
    state.failMessages = true;
    await expect(collectAiMessageReferences(HASH)).rejects.toThrow('statement timeout');
    expect(JSON.stringify(vi.mocked(loggers.security.error).mock.calls)).not.toContain(HASH);
  });
});
